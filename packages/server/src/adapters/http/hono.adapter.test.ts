import { describe, expect, test } from 'bun:test'
import type { NostrRequest } from '@nostrum/core'
import { HonoAdapter } from './hono.adapter.js'

function makeReq(overrides: Partial<NostrRequest> = {}): NostrRequest {
  return {
    id: 'a'.repeat(32),
    method: 'POST',
    path: '/v1/x',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{"a":1}'),
    principal: 'client-pk',
    expiresAt: 0,
    ...overrides,
  }
}

describe('HonoAdapter', () => {
  const adapter = new HonoAdapter()

  test('toRequest injects x-nostrum-principal header', () => {
    const req = adapter.toRequest(makeReq())
    expect(req.headers.get('x-nostrum-principal')).toBe('client-pk')
  })

  test('toRequest overwrites inbound x-nostrum-principal with trusted value', () => {
    const req = adapter.toRequest(
      makeReq({
        headers: { 'x-nostrum-principal': 'spoofed-pk' },
        principal: 'trusted-pk',
      }),
    )
    expect(req.headers.get('x-nostrum-principal')).toBe('trusted-pk')
  })

  test('toRequest builds URL with correct path', () => {
    const req = adapter.toRequest(makeReq({ path: '/v1/echo' }))
    expect(new URL(req.url).pathname).toBe('/v1/echo')
  })

  test('toRequest attaches body for POST', async () => {
    const req = adapter.toRequest(makeReq({ body: new TextEncoder().encode('hi') }))
    expect(await req.text()).toBe('hi')
  })

  test('toRequest omits body for GET', () => {
    const req = adapter.toRequest(
      makeReq({ method: 'GET', body: null, headers: {} }),
    )
    expect(req.method).toBe('GET')
    expect(req.body).toBeNull()
  })

  test('toNostrResponse maps status/headers/body', async () => {
    const res = new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
    const nostrRes = await adapter.toNostrResponse('abc', res)
    expect(nostrRes.id).toBe('abc')
    expect(nostrRes.status).toBe(201)
    expect(nostrRes.headers['content-type']).toBe('application/json')
    expect(new TextDecoder().decode(nostrRes.body!)).toBe('{"ok":true}')
  })

  test('toNostrResponse returns null body for empty response', async () => {
    const res = new Response(null, { status: 204 })
    const nostrRes = await adapter.toNostrResponse('abc', res)
    expect(nostrRes.body).toBeNull()
  })
})
