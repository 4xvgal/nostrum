import type { Hono, MiddlewareHandler } from 'hono'
import { nip98 } from './nip98.js'
import { currentPrice } from './price.js'
import { getById, insert, listByPubkey, remove } from './store.js'
import type { Direction, Subscription } from './store.js'

function newId(): string {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  )
}

function parseDirection(v: unknown): Direction {
  if (v === 'up' || v === 'down' || v === 'both') return v
  return 'both'
}

function parseWindowSec(v: unknown): number {
  if (typeof v === 'number' && v > 0 && v <= 7 * 24 * 3600) return v
  return 24 * 3600
}

function parseThreshold(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v) || v <= 0 || v > 100) return null
  return v
}

/**
 * Registers BTC alert bot routes onto the given Hono app. The tunnel.route()
 * middleware is passed in so each route is gated on the nostr-tun dispatch path.
 */
export function registerRoutes(app: Hono, route: MiddlewareHandler): void {
  app.get('/v1/price', route, (c) => {
    const p = currentPrice()
    if (!p) return c.json({ error: 'warming-up' }, 503)
    return c.json(p)
  })

  app.post('/v1/subscribe', route, nip98, async (c) => {
    const pubkey = c.get('nip98Pubkey')
    const body = (await c.req.json().catch(() => null)) as
      | {
          threshold_pct?: number
          direction?: string
          window_sec?: number
        }
      | null
    const threshold = parseThreshold(body?.threshold_pct)
    if (threshold === null) {
      return c.json({ error: 'invalid-threshold' }, 400)
    }
    const price = currentPrice()
    if (!price) return c.json({ error: 'warming-up' }, 503)

    const sub: Subscription = {
      id: newId(),
      notifyPubkey: pubkey,
      thresholdPct: threshold,
      direction: parseDirection(body?.direction),
      windowSec: parseWindowSec(body?.window_sec),
      baselineUsd: price.usd,
      baselineAt: price.fetchedAt,
      cooldownUntil: 0,
      createdAt: Date.now(),
    }
    insert(sub)
    return c.json(sub, 201)
  })

  app.get('/v1/subscriptions', route, nip98, (c) => {
    const pubkey = c.get('nip98Pubkey')
    return c.json({ items: listByPubkey(pubkey) })
  })

  app.delete('/v1/subscribe/:id', route, nip98, (c) => {
    const pubkey = c.get('nip98Pubkey')
    const id = c.req.param('id')
    const sub = getById(id)
    if (!sub) return c.json({ error: 'not-found' }, 404)
    if (sub.notifyPubkey !== pubkey) {
      return c.json({ error: 'forbidden' }, 403)
    }
    remove(id)
    return c.json({ ok: true })
  })
}
