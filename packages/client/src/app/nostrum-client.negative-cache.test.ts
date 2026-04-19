import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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

describe('NostrumClient negative caching', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    // Responder: plain HTTPS, no Nostrum-Location header.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('first HTTPS call with no Nostrum-Location → cached as notNostrum', async () => {
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await c.fetch('https://non-nostrum.test/x')
    expect(fetchCalls.length).toBe(1)
    // Second call: no manifest fetch attempted (would appear in fetchCalls as .well-known).
    await c.fetch('https://non-nostrum.test/y')
    expect(fetchCalls.length).toBe(2) // only the user fetch, not a manifest probe
    expect(
      fetchCalls.some((u) => u.endsWith('/.well-known/nostrum.json')),
    ).toBe(false)
  })

  test('second call on cached notNostrum origin bypasses Nostrum-Location re-check', async () => {
    const c = new NostrumClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())

    await c.fetch('https://non-nostrum.test/a')
    const headerReadsBefore = fetchCalls.length
    void headerReadsBefore

    // Mutate responder to add Nostrum-Location — we should NOT relearn.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push(url)
      return new Response('ok', {
        status: 200,
        headers: {
          'Nostrum-Location':
            'pubkey=pk; relays=wss://r.example.com; ma=300',
        },
      })
    }) as typeof globalThis.fetch

    await c.fetch('https://non-nostrum.test/b')
    // Even though headers now include Nostrum-Location, resolveTarget went
    // directly to {https} because cache entry is notNostrum and still valid.
    // No background manifest fetch because learn path never ran.
    expect(
      fetchCalls.some((u) => u.endsWith('/.well-known/nostrum.json')),
    ).toBe(false)
  })
})
