export type Direction = 'up' | 'down' | 'both'

export type Subscription = {
  id: string
  notifyPubkey: string
  thresholdPct: number
  direction: Direction
  windowSec: number
  baselineUsd: number
  baselineAt: number
  cooldownUntil: number
  createdAt: number
}

const subs = new Map<string, Subscription>()

export function listByPubkey(pubkey: string): Subscription[] {
  const out: Subscription[] = []
  for (const s of subs.values()) if (s.notifyPubkey === pubkey) out.push(s)
  return out
}

export function listAll(): Subscription[] {
  return [...subs.values()]
}

export function getById(id: string): Subscription | null {
  return subs.get(id) ?? null
}

export function insert(sub: Subscription): void {
  subs.set(sub.id, sub)
}

export function update(id: string, patch: Partial<Subscription>): void {
  const cur = subs.get(id)
  if (!cur) return
  subs.set(id, { ...cur, ...patch })
}

export function remove(id: string): boolean {
  return subs.delete(id)
}
