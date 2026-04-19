import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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

describe('NostrTunClient negative caching', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    // Responder: plain HTTPS, no Nostr-Tun-Location header.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('first HTTPS call with no Nostr-Tun-Location → cached as notNostrTun', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await c.fetch('https://non-nostr-tun.test/x')
    expect(fetchCalls.length).toBe(1)
    // Second call: no manifest fetch attempted (would appear in fetchCalls as .well-known).
    await c.fetch('https://non-nostr-tun.test/y')
    expect(fetchCalls.length).toBe(2) // only the user fetch, not a manifest probe
    expect(
      fetchCalls.some((u) => u.endsWith('/.well-known/nostr-tun.json')),
    ).toBe(false)
  })

  test('second call on cached notNostrTun origin bypasses Nostr-Tun-Location re-check', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await c.fetch('https://non-nostr-tun.test/a')
    const headerReadsBefore = fetchCalls.length
    void headerReadsBefore

    // Mutate responder to add Nostr-Tun-Location — we should NOT relearn.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostr-Tun-Location':
            'pubkey=pk; relays=wss://r.example.com; ma=300',
        },
      })
    }) as typeof globalThis.fetch

    await c.fetch('https://non-nostr-tun.test/b')
    // Even though headers now include Nostr-Tun-Location, resolveTarget went
    // directly to {https} because cache entry is notNostrTun and still valid.
    // No background manifest fetch because learn path never ran.
    expect(
      fetchCalls.some((u) => u.endsWith('/.well-known/nostr-tun.json')),
    ).toBe(false)
  })
})
