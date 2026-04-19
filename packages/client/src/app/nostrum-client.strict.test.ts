import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk'
import { NdkCryptoAdapter } from '@nostrum/ndk-adapters'
import { KINDS_NOSTRUM } from '@nostrum/core'
import type { CryptoPort } from '@nostrum/core'
import type { TransportPort } from '../ports/transport.port.js'
import { NostrumClient } from './nostrum-client.js'

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

describe('NostrumClient strictNostr (global)', () => {
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
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60, strictNostr: true })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await expect(c.fetch('https://unknown.test/x')).rejects.toThrow(
      /NostrumStrictError/,
    )
    // Critical: globalThis.fetch must NOT have been called.
    expect(fetchCalls.length).toBe(0)
  })

  test('501 response throws, no transparent HTTPS retry', async () => {
    const ndk = new NDK()
    ndk.explicitRelayUrls = []
    const crypto = new NdkCryptoAdapter(ndk, KINDS_NOSTRUM)

    const clientSigner = NDKPrivateKeySigner.generate()
    const serverSigner = NDKPrivateKeySigner.generate()
    const clientSk = clientSigner.privateKey
    const clientPk = clientSigner.pubkey
    const serverSk = serverSigner.privateKey
    const serverPk = serverSigner.pubkey

    const transport = new BridgeTransport()
    const client = new NostrumClient({
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
        headers: { 'x-nostrum-error': 'route-not-enabled' },
        body: null,
      },
      clientPk,
      serverSk,
      60,
    )
    transport.inject(wrapped501)

    await expect(pending).rejects.toThrow(/NostrumStrictError/)
    expect(fetchCalls.length).toBe(0) // no HTTPS retry leaked
    await client.disconnect()
  })
})

describe('NostrumClient strictNostr (per-fetch override)', () => {
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

  test('per-fetch nostrumStrict:true overrides global false', async () => {
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 }) // strict=false default
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    // Non-strict call: HTTPS fallback works.
    await c.fetch('https://a.test/x')
    expect(fetchCalls.length).toBe(1)

    // Strict call to same origin (cached as notNostrum): should throw.
    await expect(
      c.fetch('https://a.test/y', { nostrumStrict: true }),
    ).rejects.toThrow(/NostrumStrictError/)
  })

  test('per-fetch nostrumStrict:false overrides global true', async () => {
    const c = new NostrumClient({
      secretKey: 'sk',
      ttl: 60,
      strictNostr: true,
    })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    // Global strict → would throw. Override with nostrumStrict:false → allows HTTPS.
    const res = await c.fetch('https://a.test/x', { nostrumStrict: false })
    expect(res.status).toBe(200)
    expect(fetchCalls.length).toBe(1)
  })
})
