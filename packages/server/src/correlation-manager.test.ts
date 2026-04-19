import { describe, expect, test } from 'bun:test'
import type { NostrRequest } from '@nostrum/core'
import { CorrelationManager } from './correlation-manager.js'
import { InMemoryStorageAdapter } from './adapters/storage/in-memory.adapter.js'

const future = () => Math.floor(Date.now() / 1000) + 60
const past = () => Math.floor(Date.now() / 1000) - 1

function makeReq(overrides: Partial<NostrRequest> = {}): NostrRequest {
  return {
    id: 'a'.repeat(32),
    method: 'POST',
    path: '/x',
    headers: {},
    body: null,
    principal: 'client-pk',
    expiresAt: future(),
    ...overrides,
  }
}

describe('CorrelationManager', () => {
  test('register returns true for fresh, false for duplicate', async () => {
    const cm = new CorrelationManager(new InMemoryStorageAdapter())
    expect(await cm.register(makeReq())).toBe(true)
    expect(await cm.register(makeReq())).toBe(false)
  })

  test('resolve returns entry without deleting (TTL eviction is the cleaner)', async () => {
    const cm = new CorrelationManager(new InMemoryStorageAdapter())
    const req = makeReq()
    await cm.register(req)
    const entry = await cm.resolve(req.id)
    expect(entry).not.toBeNull()
    expect(entry!.principal).toBe('client-pk')
    expect(await cm.register(req)).toBe(false)
  })

  test('evictExpired removes stale entries', async () => {
    const storage = new InMemoryStorageAdapter()
    const cm = new CorrelationManager(storage)
    await cm.register(makeReq({ id: 'stale'.padEnd(32, 'x'), expiresAt: past() }))
    await cm.register(makeReq({ id: 'fresh'.padEnd(32, 'x'), expiresAt: future() }))
    await cm.evictExpired()
    expect(await cm.resolve('stale'.padEnd(32, 'x'))).toBeNull()
    expect(await cm.resolve('fresh'.padEnd(32, 'x'))).not.toBeNull()
  })
})
