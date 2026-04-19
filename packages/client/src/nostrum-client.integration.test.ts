import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostrum/ndk-adapters'
import {
  KINDS_NIP80,
  KINDS_NOSTRUM,
  type KindSet,
} from '@nostrum/core'
import {
  HonoAdapter,
  InMemoryStorageAdapter,
  Nostrum,
  type RelayPort,
} from '@nostrum/server'
import { NostrumClient } from './app/nostrum-client.js'
import type { TransportPort } from './ports/transport.port.js'

class InMemoryHub {
  #subs = new Map<string, Array<(b: Uint8Array) => void>>()

  subscribe(pubkey: string, handler: (b: Uint8Array) => void): void {
    const arr = this.#subs.get(pubkey) ?? []
    arr.push(handler)
    this.#subs.set(pubkey, arr)
  }

  publish(bytes: Uint8Array): void {
    const evt = JSON.parse(new TextDecoder().decode(bytes)) as {
      tags: string[][]
    }
    const pTags = evt.tags
      .filter((t) => t[0] === 'p')
      .map((t) => t[1]!)
    for (const pk of pTags) {
      for (const h of this.#subs.get(pk) ?? []) h(bytes)
    }
  }

  injectTo(pubkey: string, bytes: Uint8Array): void {
    for (const h of this.#subs.get(pubkey) ?? []) h(bytes)
  }
}

class HubServerRelay implements RelayPort {
  #h: ((b: Uint8Array) => void) | null = null
  constructor(
    private readonly hub: InMemoryHub,
    private readonly serverPk: string,
  ) {}
  async connect(): Promise<void> {
    if (this.#h) this.hub.subscribe(this.serverPk, this.#h)
  }
  async disconnect(): Promise<void> {}
  onEvent(h: (b: Uint8Array) => void): void {
    this.#h = h
  }
  async publish(b: Uint8Array): Promise<void> {
    this.hub.publish(b)
  }
}

class HubClientTransport implements TransportPort {
  #h: ((b: Uint8Array) => void) | null = null
  constructor(
    private readonly hub: InMemoryHub,
    private readonly clientPk: string,
  ) {}
  async connect(): Promise<void> {
    if (this.#h) this.hub.subscribe(this.clientPk, this.#h)
  }
  async disconnect(): Promise<void> {}
  onEvent(h: (b: Uint8Array) => void): void {
    this.#h = h
  }
  async publish(b: Uint8Array): Promise<void> {
    this.hub.publish(b)
  }
}

for (const kinds of [KINDS_NOSTRUM, KINDS_NIP80] satisfies KindSet[]) {
  describe(`NostrumClient ↔ Nostrum e2e (wrap=${kinds.wrap})`, () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const crypto = new NdkCryptoAdapter(ndk, kinds)

    let clientSk: string
    let clientPk: string
    let serverSk: string
    let serverPk: string
    let hub: InMemoryHub
    let server: Nostrum
    let client: NostrumClient
    let echoCalls = 0

    beforeAll(async () => {
      const clientSigner = NDKPrivateKeySigner.generate()
      const serverSigner = NDKPrivateKeySigner.generate()
      clientSk = clientSigner.privateKey
      clientPk = clientSigner.pubkey
      serverSk = serverSigner.privateKey
      serverPk = serverSigner.pubkey

      hub = new InMemoryHub()

      const app = new Hono()
      server = new Nostrum({
        relays: [],
        secretKey: serverSk,
        ttl: 60,
        pubkey: serverPk,
      })
        .useRelay(new HubServerRelay(hub, serverPk))
        .useCrypto(crypto)
        .useStorage(new InMemoryStorageAdapter())
        .useHttp(new HonoAdapter())
        .attachApp(app)

      app.post('/v1/echo', server.route(), async (c) => {
        echoCalls++
        const body = await c.req.text()
        return c.json({
          echoed: body,
          principal: c.req.header('x-nostrum-principal'),
        })
      })

      await server.connect()

      client = new NostrumClient({ secretKey: clientSk, ttl: 60 })
        .useTransport(new HubClientTransport(hub, clientPk))
        .useCrypto(crypto)
        .pin('https://srv.test', { pubkey: serverPk, relays: [] })
    })

    test('criterion 1 — pin + fetch reaches handler end-to-end', async () => {
      const before = echoCalls
      const res = await client.fetch('https://srv.test/v1/echo', {
        method: 'POST',
        body: 'hi',
      })
      expect(echoCalls).toBe(before + 1)
      expect(res.status).toBe(200)
    })

    test('criterion 2 — handler return value maps to standard Response', async () => {
      const res = await client.fetch('https://srv.test/v1/echo', {
        method: 'POST',
        body: 'payload-x',
      })
      expect(res.headers.get('content-type')).toContain('application/json')
      const data = (await res.json()) as { echoed: string; principal: string }
      expect(data.echoed).toBe('payload-x')
      expect(data.principal).toBe(clientPk)
    })

    test('criterion 3 — TTL timeout rejects and clears pending', async () => {
      const voidHub = new InMemoryHub()
      const sinkClient = new NostrumClient({
        secretKey: clientSk,
        ttl: 1,
      })
        .useTransport(new HubClientTransport(voidHub, clientPk))
        .useCrypto(crypto)
        .pin('https://void.test', { pubkey: serverPk, relays: [] })

      const started = Date.now()
      await expect(
        sinkClient.fetch('https://void.test/v1/echo', {
          method: 'POST',
          body: 'x',
        }),
      ).rejects.toThrow(/timeout/)
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(2000)
      await sinkClient.disconnect()
    })

    test('criterion 4 — unknown correlation id events are ignored', async () => {
      // Build a valid wrap addressed to clientPk but with an id we never sent.
      const fakeWrapped = await crypto.wrap(
        {
          id: 'deadbeef'.repeat(4),
          status: 200,
          headers: {},
          body: null,
        },
        clientPk,
        serverSk,
        60,
      )

      // Inject directly; should not disturb a concurrent real fetch.
      const real = client.fetch('https://srv.test/v1/echo', {
        method: 'POST',
        body: 'still-works',
      })
      hub.injectTo(clientPk, fakeWrapped)

      const res = await real
      const data = (await res.json()) as { echoed: string }
      expect(data.echoed).toBe('still-works')
    })
  })
}
