import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostr-tun/ndk-adapters'
import { KINDS_NOSTR_TUN } from '@nostr-tun/core'
import type { CryptoPort } from '@nostr-tun/core'
import type { TransportPort } from '../ports/transport.port.js'
import { NostrTunClient } from './nostr-tun-client.js'

function stubCrypto(): CryptoPort {
  return {
    async wrap() {
      return new Uint8Array()
    },
    async unwrapRequest() {
      return null
    },
    async unwrapResponse() {
      return null
    },
  }
}

function stubTransport(): TransportPort {
  return {
    async connect() {},
    onEvent() {},
    async publish() {},
    async disconnect() {},
  }
}

class BridgeTransport implements TransportPort {
  handler: ((b: Uint8Array) => void) | null = null
  publishes: Uint8Array[] = []
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onEvent(h: (b: Uint8Array) => void): void {
    this.handler = h
  }
  async publish(b: Uint8Array): Promise<void> {
    this.publishes.push(b)
  }
  inject(b: Uint8Array): void {
    this.handler?.(b)
  }
}

describe('NostrTunClient strictNostr (global)', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('unpinned origin throws (no HTTPS bootstrap leak)', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60, strictNostr: true })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await expect(c.fetch('https://unknown.test/x')).rejects.toThrow(
      /NostrTunStrictError/,
    )
    // Critical: globalThis.fetch must NOT have been called.
    expect(fetchCalls.length).toBe(0)
  })

  test('501 response throws, no transparent HTTPS retry', async () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const crypto = new NdkCryptoAdapter(ndk, KINDS_NOSTR_TUN)

    const clientSigner = NDKPrivateKeySigner.generate()
    const serverSigner = NDKPrivateKeySigner.generate()
    const clientSk = clientSigner.privateKey
    const clientPk = clientSigner.pubkey
    const serverSk = serverSigner.privateKey
    const serverPk = serverSigner.pubkey

    const transport = new BridgeTransport()
    const client = new NostrTunClient({
      secretKey: clientSk,
      ttl: 60,
      strictNostr: true,
    })
      .useTransport(transport)
      .useCrypto(crypto)
      .pin('https://srv.test', { pubkey: serverPk, relays: [] })

    const pending = client.fetch('https://srv.test/v1/echo', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 30))
    const req = await crypto.unwrapRequest(transport.publishes[0]!, serverSk)
    const wrapped501 = await crypto.wrap(
      {
        id: req!.id,
        status: 501,
        headers: { 'x-nostr-tun-error': 'route-not-enabled' },
        body: null,
      },
      clientPk,
      serverSk,
      60,
    )
    transport.inject(wrapped501)

    await expect(pending).rejects.toThrow(/NostrTunStrictError/)
    expect(fetchCalls.length).toBe(0) // no HTTPS retry leaked
    await client.disconnect()
  })
})

describe('NostrTunClient strictNostr (per-fetch override)', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('per-fetch nostrTunStrict:true overrides global false', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60 }) // strict=false default
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    // Non-strict call: HTTPS fallback works.
    await c.fetch('https://a.test/x')
    expect(fetchCalls.length).toBe(1)

    // Strict call to same origin (cached as notNostrTun): should throw.
    await expect(
      c.fetch('https://a.test/y', { nostrTunStrict: true }),
    ).rejects.toThrow(/NostrTunStrictError/)
  })

  test('per-fetch nostrTunStrict:false overrides global true', async () => {
    const c = new NostrTunClient({
      secretKey: 'sk',
      ttl: 60,
      strictNostr: true,
    })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    // Global strict → would throw. Override with nostrTunStrict:false → allows HTTPS.
    const res = await c.fetch('https://a.test/x', { nostrTunStrict: false })
    expect(res.status).toBe(200)
    expect(fetchCalls.length).toBe(1)
  })
})
