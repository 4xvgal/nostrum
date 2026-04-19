import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { CryptoPort } from '@nostr-tun/core'
import { NostrTun } from './nostr-tun.js'
import { InMemoryStorageAdapter } from '../adapters/storage/in-memory.adapter.js'
import { HonoAdapter } from '../adapters/http/hono.adapter.js'
import type { RelayPort } from '../ports/relay.port.js'

class NoopRelay implements RelayPort {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  onEvent(): void {}
  async publish(): Promise<void> {}
}

function noopCrypto(): CryptoPort {
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

describe('NostrTun eviction timer', () => {
  test('periodically calls evictExpired, removing stale entries', async () => {
    const storage = new InMemoryStorageAdapter()
    const past = Math.floor(Date.now() / 1000) - 10
    await storage.set('stale-id', { principal: 'pk', expiresAt: past })
    const future = Math.floor(Date.now() / 1000) + 600
    await storage.set('fresh-id', { principal: 'pk', expiresAt: future })

    expect(await storage.get('stale-id')).toBeNull() // expired — get returns null
    // However internal map still contains it; evictExpired should truly remove.

    const tunnel = new NostrTun({
      relays: [],
      secretKey: 'sk',
      ttl: 1,
      pubkey: 'pk',
    })
      .useRelay(new NoopRelay())
      .useCrypto(noopCrypto())
      .useStorage(storage)
      .useHttp(new HonoAdapter())
      .attachApp(new Hono())

    await tunnel.connect()

    // Wait > ttl*1000 = 1000ms so interval fires at least once.
    await new Promise((r) => setTimeout(r, 1200))

    // Direct verification: evictExpired truly purged the stale key.
    // We check by re-setting the same id; if it was never evicted, setIfAbsent
    // would return false. After eviction it's gone, so setIfAbsent -> true.
    const recaptured = await storage.setIfAbsent('stale-id', {
      principal: 'new',
      expiresAt: future,
    })
    expect(recaptured).toBe(true)

    // Fresh entry untouched.
    expect(await storage.get('fresh-id')).not.toBeNull()

    await tunnel.disconnect()
  })

  test('disconnect stops the timer', async () => {
    const tunnel = new NostrTun({
      relays: [],
      secretKey: 'sk',
      ttl: 1,
      pubkey: 'pk',
    })
      .useRelay(new NoopRelay())
      .useCrypto(noopCrypto())
      .useStorage(new InMemoryStorageAdapter())
      .useHttp(new HonoAdapter())
      .attachApp(new Hono())

    await tunnel.connect()
    await tunnel.disconnect()
    // If timer weren't cleared, bun test would hang on exit.
    expect(true).toBe(true)
  })
})
