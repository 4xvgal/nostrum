import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Nostrum } from './nostrum.js'

function buildApp(): Hono {
  const nostrum = new Nostrum({
    relays: [],
    secretKey: 'sk',
    ttl: 60,
    pubkey: 'server-pk',
  })
  const app = new Hono()
  app.post('/echo', nostrum.route(), (c) =>
    c.json({
      principal: c.req.header('x-nostrum-principal') ?? 'anon',
    }),
  )
  nostrum.attachApp(app)
  return app
}

describe('route() spoofing defense', () => {
  test('plain HTTP: x-nostrum-principal header is stripped before handler', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://_/echo', {
        method: 'POST',
        headers: { 'x-nostrum-principal': 'attacker-pk' },
      }),
    )
    const body = (await res.json()) as { principal: string }
    expect(body.principal).toBe('anon')
  })

  test('Nostr dispatch (executionCtx marker): header preserved', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://_/echo', {
        method: 'POST',
        headers: { 'x-nostrum-principal': 'verified-pk' },
      }),
      undefined,
      { nostrumDispatch: true } as never,
    )
    const body = (await res.json()) as { principal: string }
    expect(body.principal).toBe('verified-pk')
  })

  test('plain HTTP without header: still returns anon', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://_/echo', { method: 'POST' }))
    const body = (await res.json()) as { principal: string }
    expect(body.principal).toBe('anon')
  })
})
