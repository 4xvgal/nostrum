import type { Hono, MiddlewareHandler } from 'hono'
import { nip98 } from './nip98.js'
import { currentPrice } from './price.js'
import { getById, insert, listByOwner, remove } from './store.js'
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

function parseCooldownSec(v: unknown): number {
  const MIN = 60
  const MAX = 7 * 24 * 3600
  const DEFAULT = 1800
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT
  return Math.max(MIN, Math.min(MAX, Math.floor(v)))
}

function parseThreshold(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v) || v <= 0 || v > 100) return null
  return v
}

function parseNotifyPubkey(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') return null
  const lower = v.toLowerCase()
  return /^[0-9a-f]{64}$/.test(lower) ? lower : null
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
    const owner = c.get('nip98Pubkey')
    const body = (await c.req.json().catch(() => null)) as
      | {
          threshold_pct?: number
          direction?: string
          cooldown_sec?: number
          notify_pubkey?: string
        }
      | null
    const threshold = parseThreshold(body?.threshold_pct)
    if (threshold === null) {
      return c.json({ error: 'invalid-threshold' }, 400)
    }
    const notifyParsed = parseNotifyPubkey(body?.notify_pubkey)
    if (notifyParsed === null) {
      return c.json({ error: 'invalid-notify-pubkey' }, 400)
    }
    const notifyPubkey = notifyParsed ?? owner
    const price = currentPrice()
    if (!price) return c.json({ error: 'warming-up' }, 503)

    const sub: Subscription = {
      id: newId(),
      ownerPubkey: owner,
      notifyPubkey,
      thresholdPct: threshold,
      direction: parseDirection(body?.direction),
      cooldownSec: parseCooldownSec(body?.cooldown_sec),
      baselineUsd: price.usd,
      baselineAt: price.fetchedAt,
      cooldownUntil: 0,
      createdAt: Date.now(),
    }
    insert(sub)
    return c.json(sub, 201)
  })

  app.get('/v1/subscriptions', route, nip98, (c) => {
    const owner = c.get('nip98Pubkey')
    return c.json({ items: listByOwner(owner) })
  })

  app.delete('/v1/subscribe/:id', route, nip98, (c) => {
    const owner = c.get('nip98Pubkey')
    const id = c.req.param('id')
    const sub = getById(id)
    if (!sub) return c.json({ error: 'not-found' }, 404)
    if (sub.ownerPubkey !== owner) {
      return c.json({ error: 'forbidden' }, 403)
    }
    remove(id)
    return c.json({ ok: true })
  })
}
