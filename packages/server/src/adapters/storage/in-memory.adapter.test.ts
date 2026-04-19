import { describe, expect, test } from 'bun:test'
import { InMemoryStorageAdapter } from './in-memory.adapter.js'

const future = () => Math.floor(Date.now() / 1000) + 60
const past = () => Math.floor(Date.now() / 1000) - 1

describe('InMemoryStorageAdapter', () => {
  test('setIfAbsent returns true on first set, false on second', async () => {
    const s = new InMemoryStorageAdapter()
    expect(
      await s.setIfAbsent('id1', { principal: 'pk', expiresAt: future() }),
    ).toBe(true)
    expect(
      await s.setIfAbsent('id1', { principal: 'pk', expiresAt: future() }),
    ).toBe(false)
  })

  test('setIfAbsent does not overwrite; set does', async () => {
    const s = new InMemoryStorageAdapter()
    await s.setIfAbsent('id1', { principal: 'a', expiresAt: future() })
    await s.setIfAbsent('id1', { principal: 'b', expiresAt: future() })
    expect((await s.get('id1'))!.principal).toBe('a')

    await s.set('id1', { principal: 'c', expiresAt: future() })
    expect((await s.get('id1'))!.principal).toBe('c')
  })

  test('get returns null for expired entries', async () => {
    const s = new InMemoryStorageAdapter()
    await s.set('id1', { principal: 'pk', expiresAt: past() })
    expect(await s.get('id1')).toBeNull()
  })

  test('get returns entry when expiresAt is 0 (no expiry)', async () => {
    const s = new InMemoryStorageAdapter()
    await s.set('id1', { principal: 'pk', expiresAt: 0 })
    expect(await s.get('id1')).not.toBeNull()
  })

  test('delete removes entry', async () => {
    const s = new InMemoryStorageAdapter()
    await s.set('id1', { principal: 'pk', expiresAt: future() })
    await s.delete('id1')
    expect(await s.get('id1')).toBeNull()
  })

  test('evictExpired drops stale entries, keeps fresh', async () => {
    const s = new InMemoryStorageAdapter()
    await s.set('stale', { principal: 'pk', expiresAt: past() })
    await s.set('fresh', { principal: 'pk', expiresAt: future() })
    await s.evictExpired(Math.floor(Date.now() / 1000))
    expect(await s.get('stale')).toBeNull()
    expect(await s.get('fresh')).not.toBeNull()
  })
})
