import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Nostrum } from './nostrum.js'

describe('Nostrum.advertise()', () => {
  test('injects Nostrum-Location header with pubkey/relays/ma', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://r1.example.com', 'wss://r2.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'abc123',
      advertiseTtl: 600,
    })
    const app = new Hono()
    app.use('*', nostrum.advertise())
    app.get('/x', (c) => c.text('ok'))

    const res = await app.fetch(new Request('http://_/x'))
    expect(res.headers.get('Nostrum-Location')).toBe(
      'pubkey=abc123; relays=wss://r1.example.com,wss://r2.example.com; ma=600',
    )
  })

  test('defaults ma= to 300 when advertiseTtl omitted', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://r.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'deadbeef',
    })
    const app = new Hono()
    app.use('*', nostrum.advertise())
    app.get('/', (c) => c.text('ok'))

    const res = await app.fetch(new Request('http://_/'))
    expect(res.headers.get('Nostrum-Location')).toContain('ma=300')
  })

  test('advertise does not block handler execution', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://r.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
    })
    const app = new Hono()
    app.use('*', nostrum.advertise())
    app.get('/', (c) => c.text('hello'))

    const res = await app.fetch(new Request('http://_/'))
    expect(await res.text()).toBe('hello')
  })
})
