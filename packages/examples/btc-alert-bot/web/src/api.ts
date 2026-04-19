import type { NostrTunClient } from '@nostr-tun/client'
import { buildNip98Header } from './nip98.js'
import { url } from './tunnel.js'

export type Price = { usd: number; change24hPct: number; fetchedAt: number }

export type Subscription = {
  id: string
  ownerPubkey: string
  notifyPubkey: string
  thresholdPct: number
  direction: 'up' | 'down' | 'both'
  windowSec: number
  baselineUsd: number
  baselineAt: number
  cooldownUntil: number
  createdAt: number
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export async function getPrice(client: NostrTunClient): Promise<Price> {
  const res = await client.fetch(url('/v1/price'))
  return json(res)
}

export async function listSubscriptions(
  client: NostrTunClient,
  sk: Uint8Array,
): Promise<Subscription[]> {
  const u = url('/v1/subscriptions')
  const res = await client.fetch(u, {
    headers: { authorization: buildNip98Header({ sk, method: 'GET', url: u }) },
  })
  const { items } = await json<{ items: Subscription[] }>(res)
  return items
}

export async function createSubscription(
  client: NostrTunClient,
  sk: Uint8Array,
  body: {
    threshold_pct: number
    direction: 'up' | 'down' | 'both'
    window_sec: number
    notify_pubkey?: string
  },
): Promise<Subscription> {
  const u = url('/v1/subscribe')
  const bodyText = JSON.stringify(body)
  const res = await client.fetch(u, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: buildNip98Header({ sk, method: 'POST', url: u, body: bodyText }),
    },
    body: bodyText,
  })
  return json(res)
}

export async function deleteSubscription(
  client: NostrTunClient,
  sk: Uint8Array,
  id: string,
): Promise<void> {
  const u = url(`/v1/subscribe/${encodeURIComponent(id)}`)
  const res = await client.fetch(u, {
    method: 'DELETE',
    headers: { authorization: buildNip98Header({ sk, method: 'DELETE', url: u }) },
  })
  await json(res)
}
