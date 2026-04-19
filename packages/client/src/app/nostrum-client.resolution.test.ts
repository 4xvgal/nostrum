import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  CryptoPort,
  NostrResponse,
  ServerInfo,
} from '@nostrum/core'
import { KINDS_NIP80 } from '@nostrum/core'
import type { TransportPort } from '../ports/transport.port.js'
import type { DiscoveryPort } from '../ports/discovery.port.js'
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

class RecordingTransport implements TransportPort {
  publishes: Uint8Array[] = []
  async connect(): Promise<void> {}
  onEvent(): void {}
  async publish(b: Uint8Array): Promise<void> {
    this.publishes.push(b)
  }
  async disconnect(): Promise<void> {}
}

function makeManifestResponse(kindSet: 'nostrum' | 'nip80' | object): Response {
  const body = {
    version: '0.1',
    pubkey: 'learned-pk',
    relays: ['wss://learned.example.com'],
    ttl: 300,
    capabilities: { kindSet, chunking: false },
    routes: [{ method: 'POST', path: '/v1/known', kind: 'literal' }],
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchArgs = [input: string, init?: RequestInit]

describe('NostrumClient resolution order', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: FetchArgs[]
  let responder: (url: string) => Response

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    responder = () => new Response('ok', { status: 200 })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push([url, init])
      return responder(url)
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('pinned origin bypasses cache/discovery and goes to Nostr', async () => {
    const transport = new RecordingTransport()
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(stubCrypto())
      .pin('https://a.test', { pubkey: 'pinned-pk', relays: [] })

    void c.fetch('https://a.test/x').catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    expect(transport.publishes.length).toBe(1)
    expect(fetchCalls.length).toBe(0)
    await c.disconnect()
  })

  test('learnFromAdvertisement: false — Nostrum-Location header ignored', async () => {
    responder = () =>
      new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location': 'pubkey=learned; relays=wss://r.example; ma=300',
        },
      })

    const c = new NostrumClient({
      secretKey: 'sk',
      ttl: 60,
      learnFromAdvertisement: false,
    })
      .useTransport(new RecordingTransport())
      .useCrypto(stubCrypto())

    await c.fetch('https://a.test/x')
    await c.fetch('https://a.test/y')
    // Both calls fell back to HTTPS; cache never populated.
    expect(fetchCalls.length).toBe(2)
  })

  test('manifest miss marks (method, path) disabled for subsequent calls', async () => {
    responder = (url) => {
      if (url.endsWith('/.well-known/nostrum.json')) {
        return makeManifestResponse('nostrum')
      }
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location': 'pubkey=pk; relays=wss://r.example; ma=300',
        },
      })
    }

    const transport = new RecordingTransport()
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(stubCrypto())

    // 1st call: HTTPS learn + background manifest fetch.
    await c.fetch('https://a.test/v1/unknown', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 30))

    // 2nd call: cache has manifest, /v1/unknown not listed → HTTPS + disabled.
    await c.fetch('https://a.test/v1/unknown', { method: 'POST' })
    // 3rd call: same, still HTTPS (no re-check on manifest since disabled).
    await c.fetch('https://a.test/v1/unknown', { method: 'POST' })

    // 3 user calls + 1 manifest bg fetch = 4 HTTPS calls. transport.publish never called.
    expect(fetchCalls.length).toBe(4)
    expect(transport.publishes.length).toBe(0)
  })

  test('manifest hit + kindSet compatible → Nostr path', async () => {
    responder = (url) => {
      if (url.endsWith('/.well-known/nostrum.json')) {
        return makeManifestResponse('nostrum')
      }
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location': 'pubkey=pk; relays=wss://r.example; ma=300',
        },
      })
    }

    const transport = new RecordingTransport()
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(stubCrypto())

    await c.fetch('https://a.test/v1/known', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 30))
    void c.fetch('https://a.test/v1/known', { method: 'POST' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    expect(transport.publishes.length).toBe(1)
    await c.disconnect()
  })

  test('kindSet mismatch → HTTPS fallback', async () => {
    responder = (url) => {
      if (url.endsWith('/.well-known/nostrum.json')) {
        return makeManifestResponse('nip80')
      }
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location': 'pubkey=pk; relays=wss://r.example; ma=300',
        },
      })
    }

    const transport = new RecordingTransport()
    // Client configured for KINDS_NOSTRUM (default), server declares nip80.
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(stubCrypto())

    await c.fetch('https://a.test/v1/known', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 30))
    await c.fetch('https://a.test/v1/known', { method: 'POST' })

    expect(transport.publishes.length).toBe(0)
  })

  test('kindSet nip80 matches when client configured with KINDS_NIP80', async () => {
    responder = (url) => {
      if (url.endsWith('/.well-known/nostrum.json')) {
        return makeManifestResponse('nip80')
      }
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location': 'pubkey=pk; relays=wss://r.example; ma=300',
        },
      })
    }

    const transport = new RecordingTransport()
    const c = new NostrumClient({
      secretKey: 'sk',
      ttl: 60,
      kinds: KINDS_NIP80,
    })
      .useTransport(transport)
      .useCrypto(stubCrypto())

    await c.fetch('https://a.test/v1/known', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 30))
    void c.fetch('https://a.test/v1/known', { method: 'POST' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    expect(transport.publishes.length).toBe(1)
    await c.disconnect()
  })

  test('discovery adapter populates cache when called', async () => {
    const transport = new RecordingTransport()
    const discovery: DiscoveryPort = {
      async resolve(origin: string): Promise<ServerInfo | null> {
        if (origin === 'https://a.test') {
          return { pubkey: 'disc-pk', relays: ['wss://disc.example'] }
        }
        return null
      },
    }
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(stubCrypto())
      .useDiscovery(discovery)

    void c.fetch('https://a.test/v1/x').catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    // Discovery returned info → Nostr path taken, no HTTPS call.
    expect(transport.publishes.length).toBe(1)
    expect(fetchCalls.length).toBe(0)
    await c.disconnect()
  })

  // Silence unused import warning — NostrResponse re-exported via NostrumClient internals.
  void ({} as NostrResponse)
})
