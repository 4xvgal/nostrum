import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostr-tun/ndk-adapters'
import {
  KINDS_NIP80,
  KINDS_NOSTR_TUN,
  type KindSet,
  type NostrRequest,
} from '@nostr-tun/core'
import { NostrTun } from './app/nostr-tun.js'
import { InMemoryStorageAdapter } from './adapters/storage/in-memory.adapter.js'
import { HonoAdapter } from './adapters/http/hono.adapter.js'
import type { RelayPort } from './ports/relay.port.js'

class FakeRelayAdapter implements RelayPort {
  handler: ((b: Uint8Array) => void) | null = null
  published: Uint8Array[] = []
  #waiters: Array<() => void> = []

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  onEvent(h: (b: Uint8Array) => void): void {
    this.handler = h
  }

  async publish(b: Uint8Array): Promise<void> {
    this.published.push(b)
    const toNotify = this.#waiters.splice(0)
    toNotify.forEach((r) => r())
  }

  inject(bytes: Uint8Array): void {
    this.handler?.(bytes)
  }

  async waitForPublishedCount(n: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (this.published.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `publish timeout: expected ${n}, got ${this.published.length}`,
        )
      }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 50)
        this.#waiters.push(() => {
          clearTimeout(timer)
          r()
        })
      })
    }
  }
}

function makeReq(overrides: Partial<NostrRequest> = {}): NostrRequest {
  return {
    id: 'a'.repeat(32),
    method: 'POST',
    path: '/v1/echo',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('hi'),
    principal: '',
    expiresAt: 0,
    ...overrides,
  }
}

for (const kinds of [KINDS_NOSTR_TUN, KINDS_NIP80] satisfies KindSet[]) {
  describe(`NostrTun e2e (wrap=${kinds.wrap})`, () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const crypto = new NdkCryptoAdapter(ndk, kinds)

    let clientSk: string
    let clientPk: string
    let serverSk: string
    let serverPk: string
    let tunnel: NostrTun
    let relay: FakeRelayAdapter
    let app: Hono
    let echoCalls = 0

    beforeAll(async () => {
      const client = NDKPrivateKeySigner.generate()
      const server = NDKPrivateKeySigner.generate()
      clientSk = client.privateKey
      clientPk = client.pubkey
      serverSk = server.privateKey
      serverPk = server.pubkey
      void serverPk

      app = new Hono()
      tunnel = new NostrTun({
        relays: [],
        secretKey: serverSk,
        ttl: 60,
        pubkey: serverPk,
      })
      relay = new FakeRelayAdapter()
      tunnel
        .useRelay(relay)
        .useCrypto(crypto)
        .useStorage(new InMemoryStorageAdapter())
        .useHttp(new HonoAdapter())
        .attachApp(app)

      app.post('/v1/echo', tunnel.route(), async (c) => {
        echoCalls++
        const body = await c.req.text()
        return c.json({
          echoed: body,
          principal: c.req.header('x-nostr-tun-principal'),
        })
      })
      app.post('/v1/off', async (c) => c.text('should not run'))

      await tunnel.connect()
    })

    test('criterion 1 — wrapped request reaches handler and response is published', async () => {
      const before = echoCalls
      const beforePublished = relay.published.length
      const req = makeReq({ id: '1'.repeat(32) })
      const wrapped = await crypto.wrap(req, serverPk, clientSk, 60)
      relay.inject(wrapped)
      await relay.waitForPublishedCount(beforePublished + 1)

      expect(echoCalls).toBe(before + 1)

      const resBytes = relay.published[beforePublished]!
      const res = await crypto.unwrapResponse(resBytes, clientSk)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)
      const payload = JSON.parse(new TextDecoder().decode(res!.body!)) as {
        echoed: string
        principal: string
      }
      expect(payload.echoed).toBe('hi')
      expect(payload.principal).toBe(clientPk)
    })

    test('criterion 2 — route() not mounted → 501 + x-nostr-tun-error', async () => {
      const beforePublished = relay.published.length
      const req = makeReq({ id: '2'.repeat(32), path: '/v1/off' })
      const wrapped = await crypto.wrap(req, serverPk, clientSk, 60)
      relay.inject(wrapped)
      await relay.waitForPublishedCount(beforePublished + 1)

      const resBytes = relay.published[beforePublished]!
      const res = await crypto.unwrapResponse(resBytes, clientSk)
      expect(res!.status).toBe(501)
      expect(res!.headers['x-nostr-tun-error']).toBe('route-not-enabled')
    })

    test('criterion 3 — duplicate correlation id → handler runs once, no second publish', async () => {
      const beforeCalls = echoCalls
      const beforePublished = relay.published.length
      const req = makeReq({ id: '3'.repeat(32) })
      const wrapped = await crypto.wrap(req, serverPk, clientSk, 60)

      relay.inject(wrapped)
      await relay.waitForPublishedCount(beforePublished + 1)
      relay.inject(wrapped)
      await new Promise((r) => setTimeout(r, 100))

      expect(echoCalls).toBe(beforeCalls + 1)
      expect(relay.published.length).toBe(beforePublished + 1)
    })
  })
}
