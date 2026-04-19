import { createMiddleware } from 'hono/factory'
import { verifyEvent } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const MAX_SKEW_SEC = 60
const NIP98_KIND = 27235

type AuthEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function tag(event: AuthEvent, name: string): string | null {
  for (const t of event.tags) {
    if (t[0] === name && typeof t[1] === 'string') return t[1]
  }
  return null
}

async function hashBody(bodyText: string): Promise<string> {
  if (bodyText.length === 0) return ''
  return bytesToHex(sha256(new TextEncoder().encode(bodyText)))
}

function pathAndSearch(raw: string): string {
  try {
    const parsed = new URL(raw)
    return parsed.pathname + parsed.search
  } catch {
    const q = raw.indexOf('?')
    return q === -1 ? raw : raw.slice(raw.indexOf('/', 0))
  }
}

/**
 * NIP-98 HTTP Auth middleware. On success sets c.var.nip98Pubkey.
 *
 * Verifies:
 *  - kind 27235, valid signature
 *  - `u` tag matches request URL (scheme+host ignored, path+query matched)
 *  - `method` tag matches request method
 *  - `created_at` within ±60s
 *  - `payload` tag (sha256 hex of body) matches, if body is non-empty
 */
export const nip98 = createMiddleware<{
  Variables: { nip98Pubkey: string }
}>(async (c, next) => {
  const authz = c.req.header('authorization') ?? ''
  if (!authz.toLowerCase().startsWith('nostr ')) {
    return c.json({ error: 'missing-nostr-auth' }, 401)
  }
  let event: AuthEvent
  try {
    const b64 = authz.slice(6).trim()
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
    )
    event = JSON.parse(json) as AuthEvent
  } catch {
    return c.json({ error: 'malformed-auth' }, 401)
  }

  if (event.kind !== NIP98_KIND) {
    return c.json({ error: 'wrong-kind' }, 401)
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - event.created_at) > MAX_SKEW_SEC) {
    return c.json({ error: 'stale-auth' }, 401)
  }
  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    return c.json({ error: 'bad-sig' }, 401)
  }
  const method = tag(event, 'method')?.toUpperCase()
  if (method !== c.req.method.toUpperCase()) {
    return c.json({ error: 'method-mismatch' }, 401)
  }
  const expected = pathAndSearch(c.req.url)
  const urlTag = tag(event, 'u') ?? ''
  const got = pathAndSearch(urlTag)
  if (got !== expected) {
    return c.json({ error: 'url-mismatch', expected, got }, 401)
  }

  const bodyText = await c.req.text().catch(() => '')
  if (bodyText.length > 0) {
    const payloadTag = tag(event, 'payload') ?? ''
    const actual = await hashBody(bodyText)
    if (payloadTag !== actual) {
      return c.json({ error: 'payload-hash-mismatch' }, 401)
    }
  }

  c.set('nip98Pubkey', event.pubkey)
  await next()
})
