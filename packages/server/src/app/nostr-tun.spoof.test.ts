import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { NostrTun } from './nostr-tun.js'

function buildApp(): Hono {
  const tunnel = new NostrTun({
    relays: [],
    secretKey: 'sk',
    ttl: 60,
    pubkey: 'server-pk',
  })
  const app = new Hono()
  app.post('/echo', tunnel.route(), (c) =>
    c.json({
      principal: c.req.header('x-nostr-tun-principal') ?? 'anon',
    }),
  )
  tunnel.attachApp(app)
  return app
}

describe('route() spoofing defense', () => {
  test('plain HTTP: x-nostr-tun-principal header is stripped before handler', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://_/echo', {
        method: 'POST',
        headers: { 'x-nostr-tun-principal': 'attacker-pk' },
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
        headers: { 'x-nostr-tun-principal': 'verified-pk' },
      }),
      undefined,
      { nostrTunDispatch: true } as never,
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
