import { describe, expect, test } from 'bun:test'
import type {
  CryptoPort,
  NostrRequest,
  NostrResponse,
  ServerInfo,
} from '@nostr-tun/core'
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

describe('NostrTunClient (unit)', () => {
  test('fetch throws when useTransport/useCrypto not set', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 10 })
    await expect(c.fetch('https://a.test/x')).rejects.toThrow(
      /useTransport\/useCrypto/,
    )
  })

  test('unpinned origin falls back to HTTPS via globalThis.fetch', async () => {
    const originalFetch = globalThis.fetch
    let calledUrl: string | null = null
    globalThis.fetch = (async (input: string | URL | Request) => {
      calledUrl = typeof input === 'string' ? input : input.toString()
      return new Response('ok', { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const c = new NostrTunClient({ secretKey: 'sk', ttl: 10 })
        .useTransport(stubTransport())
        .useCrypto(stubCrypto())
      const res = await c.fetch('https://unpinned.test/x')
      expect(calledUrl).toBe('https://unpinned.test/x')
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('pin overwrites previous ServerInfo for same origin', async () => {
    const captured: NostrRequest[] = []
    const crypto: CryptoPort = {
      async wrap(payload, recipientPubkey) {
        captured.push({ ...(payload as NostrRequest), principal: recipientPubkey })
        return new Uint8Array()
      },
      async unwrapRequest() {
        return null
      },
      async unwrapResponse() {
        return null
      },
    }
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 10 })
      .useTransport(stubTransport())
      .useCrypto(crypto)
      .pin('https://a.test', { pubkey: 'pk1', relays: [] })
      .pin('https://a.test', { pubkey: 'pk2', relays: [] })

    // Kick off a fetch; we don't await it (no response will come).
    // The wrap call captures the recipientPubkey synchronously before publish.
    void c.fetch('https://a.test/x').catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    expect(captured[0]!.principal).toBe('pk2')
    await c.disconnect()
  })

  test('disconnect rejects all pending with error and clears the map', async () => {
    const wrapped = new Uint8Array([1, 2, 3])
    const crypto: CryptoPort = {
      async wrap() {
        return wrapped
      },
      async unwrapRequest() {
        return null
      },
      async unwrapResponse() {
        return null
      },
    }
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(stubTransport())
      .useCrypto(crypto)
      .pin('https://a.test', { pubkey: 'pk', relays: [] })

    const f1 = c.fetch('https://a.test/x')
    const f2 = c.fetch('https://a.test/y')
    await new Promise((r) => setTimeout(r, 10))
    await c.disconnect()
    await expect(f1).rejects.toThrow(/disconnected/)
    await expect(f2).rejects.toThrow(/disconnected/)
  })

  test('unknown correlation id events are silently dropped', async () => {
    let handler: ((b: Uint8Array) => void) | null = null
    const transport: TransportPort = {
      async connect() {},
      onEvent(h) {
        handler = h
      },
      async publish() {},
      async disconnect() {},
    }
    const crypto: CryptoPort = {
      async wrap() {
        return new Uint8Array()
      },
      async unwrapRequest() {
        return null
      },
      async unwrapResponse(bytes): Promise<NostrResponse | null> {
        return {
          id: new TextDecoder().decode(bytes),
          status: 200,
          headers: {},
          body: null,
        }
      },
    }
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 60 })
      .useTransport(transport)
      .useCrypto(crypto)
      .pin('https://a.test', { pubkey: 'pk', relays: [] })

    const pending = c.fetch('https://a.test/x').catch(() => 'rejected')
    await new Promise((r) => setTimeout(r, 20))

    // Inject a response with a stranger id — pending map doesn't contain it.
    handler!(new TextEncoder().encode('stranger'.padEnd(32, 'x')))
    await new Promise((r) => setTimeout(r, 20))

    // In-flight pending is still pending (not corrupted).
    await c.disconnect()
    expect(await pending).toBe('rejected') // disconnect rejected it, not the stranger event
  })

  test('unsupported body type throws TypeError', async () => {
    const c = new NostrTunClient({ secretKey: 'sk', ttl: 10 })
      .useTransport(stubTransport())
      .useCrypto(stubCrypto())
      .pin('https://a.test', { pubkey: 'pk', relays: [] })
    const blob = new Blob(['hi'])
    await expect(
      c.fetch('https://a.test/x', { method: 'POST', body: blob }),
    ).rejects.toThrow(/unsupported body type/)
    void ({} as ServerInfo)
  })
})
