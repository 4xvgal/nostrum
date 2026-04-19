import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { Hono } from 'hono'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostr-tun/ndk-adapters'
import {
  KINDS_NIP80,
  KINDS_NOSTR_TUN,
  type KindSet,
} from '@nostr-tun/core'
import {
  HonoAdapter,
  InMemoryStorageAdapter,
  NostrTun,
  type RelayPort,
} from '@nostr-tun/server'
import { NostrTunClient } from './app/nostr-tun-client.js'
import type { TransportPort } from './ports/transport.port.js'

class InMemoryHub {
  #subs = new Map<string, Array<(b: Uint8Array) => void>>()
  subscribe(pubkey: string, h: (b: Uint8Array) => void): void {
    const arr = this.#subs.get(pubkey) ?? []
    arr.push(h)
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

for (const kinds of [KINDS_NOSTR_TUN, KINDS_NIP80] satisfies KindSet[]) {
  describe(`NostrTunClient HTTPS-first (wrap=${kinds.wrap})`, () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const crypto = new NdkCryptoAdapter(ndk, kinds)

    let clientSk: string
    let clientPk: string
    let serverSk: string
    let serverPk: string
    let hub: InMemoryHub
    let app: Hono
    let server: NostrTun
    let echoCalls = 0
    let plainCalls = 0
    let originalFetch: typeof globalThis.fetch

    beforeAll(async () => {
      const clientSigner = NDKPrivateKeySigner.generate()
      const serverSigner = NDKPrivateKeySigner.generate()
      clientSk = clientSigner.privateKey
      clientPk = clientSigner.pubkey
      serverSk = serverSigner.privateKey
      serverPk = serverSigner.pubkey

      hub = new InMemoryHub()
      app = new Hono()
      server = new NostrTun({
        relays: ['wss://relay.test'],
        secretKey: serverSk,
        ttl: 60,
        pubkey: serverPk,
        kinds,
        advertiseTtl: 300,
      })
        .useRelay(new HubServerRelay(hub, serverPk))
        .useCrypto(crypto)
        .useStorage(new InMemoryStorageAdapter())
        .useHttp(new HonoAdapter())
        .attachApp(app)

      app.use('*', server.advertise())
      app.get('/.well-known/nostr-tun.json', server.manifest())
      app.post('/v1/echo', server.route(), async (c) => {
        echoCalls++
        const body = await c.req.text()
        return c.json({
          echoed: body,
          principal: c.req.header('x-nostr-tun-principal'),
        })
      })
      // Plain HTTP only — no route() marker, not in manifest.
      app.post('/v1/plain', async (c) => {
        plainCalls++
        return c.text('plain-served')
      })

      await server.connect()

      originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const u = new URL(url)
        return app.fetch(
          new Request(`http://_${u.pathname}${u.search}`, init),
        )
      }) as typeof globalThis.fetch
    })

    afterAll(() => {
      globalThis.fetch = originalFetch
    })

    test('criterion 1 — unpinned origin: HTTPS first, then Nostr auto-switch', async () => {
      const beforeEcho = echoCalls
      const client = new NostrTunClient({
        secretKey: clientSk,
        ttl: 60,
        kinds,
      })
        .useTransport(new HubClientTransport(hub, clientPk))
        .useCrypto(crypto)

      // First call: no pin, no cache → HTTPS fallback (handler runs once via HTTPS).
      const res1 = await client.fetch('https://srv.test/v1/echo', {
        method: 'POST',
        body: 'hi-1',
      })
      expect(res1.status).toBe(200)

      // Wait for background manifest fetch.
      await new Promise((r) => setTimeout(r, 50))

      // Second call: cache now has manifest → Nostr path.
      const res2 = await client.fetch('https://srv.test/v1/echo', {
        method: 'POST',
        body: 'hi-2',
      })
      const data = (await res2.json()) as { echoed: string; principal: string }
      expect(data.echoed).toBe('hi-2')
      expect(data.principal).toBe(clientPk)

      // echoCalls: +1 from HTTPS + +1 from Nostr = 2.
      expect(echoCalls).toBe(beforeEcho + 2)
      await client.disconnect()
    })

    test('criterion 2 — path not in manifest goes to HTTPS and is marked disabled', async () => {
      const beforePlain = plainCalls
      const client = new NostrTunClient({
        secretKey: clientSk,
        ttl: 60,
        kinds,
      })
        .useTransport(new HubClientTransport(hub, clientPk))
        .useCrypto(crypto)

      await client.fetch('https://srv.test/v1/plain', { method: 'POST' })
      await new Promise((r) => setTimeout(r, 50))
      await client.fetch('https://srv.test/v1/plain', { method: 'POST' })
      await client.fetch('https://srv.test/v1/plain', { method: 'POST' })

      expect(plainCalls).toBe(beforePlain + 3)
      await client.disconnect()
    })

    test('criterion 3 — learnFromAdvertisement: false keeps cache empty', async () => {
      const beforePlain = plainCalls
      const client = new NostrTunClient({
        secretKey: clientSk,
        ttl: 60,
        kinds,
        learnFromAdvertisement: false,
      })
        .useTransport(new HubClientTransport(hub, clientPk))
        .useCrypto(crypto)

      // Call plain path twice; both should go HTTPS because cache never populates.
      await client.fetch('https://srv.test/v1/plain', { method: 'POST' })
      await client.fetch('https://srv.test/v1/plain', { method: 'POST' })

      expect(plainCalls).toBe(beforePlain + 2)
      await client.disconnect()
    })

    test('criterion 4 — manifest endpoint responds with Cache-Control', async () => {
      const res = await globalThis.fetch(
        'https://srv.test/.well-known/nostr-tun.json',
      )
      expect(res.headers.get('Cache-Control')).toMatch(
        /public, max-age=\d+/,
      )
      const body = (await res.json()) as {
        capabilities: { kindSet: string | object }
      }
      if (kinds === KINDS_NOSTR_TUN) {
        expect(body.capabilities.kindSet).toBe('nostr-tun')
      } else {
        expect(body.capabilities.kindSet).toBe('nip80')
      }
    })
  })
}
