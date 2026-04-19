import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { KINDS_NIP80 } from '@nostrum/core'
import { Nostrum } from './nostrum.js'

type ManifestDoc = {
  version: string
  pubkey: string
  relays: string[]
  ttl: number
  capabilities: { kindSet: string | object; chunking: boolean }
  routes: Array<{ method: string; path: string; kind: 'literal' | 'pattern' }>
}

function buildApp(nostrum: Nostrum): Hono {
  const app = new Hono()
  app.get('/.well-known/nostrum.json', nostrum.manifest())
  app.post('/v1/echo', nostrum.route(), (c) => c.text('echo'))
  app.get('/v1/users/:id', nostrum.route(), (c) => c.text('u'))
  app.post('/v1/hidden', (c) => c.text('no-route-marker'))
  nostrum.attachApp(app)
  return app
}

async function fetchManifest(app: Hono): Promise<{
  res: Response
  body: ManifestDoc
}> {
  const res = await app.fetch(
    new Request('http://_/.well-known/nostrum.json'),
  )
  const body = (await res.json()) as ManifestDoc
  return { res, body }
}

describe('Nostrum.manifest()', () => {
  test('includes only routes mounted with route(); excludes plain HTTP routes', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://r.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    const pairs = body.routes.map((r) => `${r.method} ${r.path}`)
    expect(pairs).toContain('POST /v1/echo')
    expect(pairs).toContain('GET /v1/users/:id')
    expect(pairs).not.toContain('POST /v1/hidden')
  })

  test('classifies literal vs pattern paths', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://r.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    const echo = body.routes.find((r) => r.path === '/v1/echo')!
    const users = body.routes.find((r) => r.path === '/v1/users/:id')!
    expect(echo.kind).toBe('literal')
    expect(users.kind).toBe('pattern')
  })

  test('sets Cache-Control public, max-age=<ttl>', async () => {
    const nostrum = new Nostrum({
      relays: [],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
      advertiseTtl: 1800,
    })
    const { res } = await fetchManifest(buildApp(nostrum))
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=1800')
  })

  test('capabilities.kindSet = "nostrum" by default', async () => {
    const nostrum = new Nostrum({
      relays: [],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    expect(body.capabilities.kindSet).toBe('nostrum')
    expect(body.capabilities.chunking).toBe(false)
  })

  test('capabilities.kindSet = "nip80" when KINDS_NIP80 injected', async () => {
    const nostrum = new Nostrum({
      relays: [],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
      kinds: KINDS_NIP80,
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    expect(body.capabilities.kindSet).toBe('nip80')
  })

  test('custom KindSet serialized as object verbatim', async () => {
    const custom = { requestRumor: 9000, responseRumor: 9001, wrap: 9002 }
    const nostrum = new Nostrum({
      relays: [],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'pk',
      kinds: custom,
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    expect(body.capabilities.kindSet).toEqual(custom)
  })

  test('manifest.pubkey/relays/ttl reflect config', async () => {
    const nostrum = new Nostrum({
      relays: ['wss://a.example.com', 'wss://b.example.com'],
      secretKey: 'sk',
      ttl: 60,
      pubkey: 'abcdef',
      advertiseTtl: 900,
    })
    const { body } = await fetchManifest(buildApp(nostrum))
    expect(body.pubkey).toBe('abcdef')
    expect(body.relays).toEqual(['wss://a.example.com', 'wss://b.example.com'])
    expect(body.ttl).toBe(900)
  })
})
