import { env } from './env.js'

export type PriceSnapshot = {
  usd: number
  change24hPct: number
  fetchedAt: number
}

let latest: PriceSnapshot | null = null
const listeners = new Set<(s: PriceSnapshot, prev: PriceSnapshot | null) => void>()

export function currentPrice(): PriceSnapshot | null {
  return latest
}

export function onPriceUpdate(
  fn: (s: PriceSnapshot, prev: PriceSnapshot | null) => void,
): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function fetchPrice(): Promise<PriceSnapshot | null> {
  try {
    const res = await fetch(env.priceSourceUrl, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      bitcoin?: { usd?: number; usd_24h_change?: number }
    }
    const usd = json.bitcoin?.usd
    const change24hPct = json.bitcoin?.usd_24h_change
    if (typeof usd !== 'number' || typeof change24hPct !== 'number') return null
    return { usd, change24hPct, fetchedAt: Date.now() }
  } catch {
    return null
  }
}

export function startPoller(): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    const snap = await fetchPrice()
    if (stopped) return
    if (snap) {
      const prev = latest
      latest = snap
      for (const fn of listeners) {
        try {
          fn(snap, prev)
        } catch {
          // isolate listener failures
        }
      }
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), env.pollIntervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
