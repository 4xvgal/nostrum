import { onPriceUpdate, type PriceSnapshot } from './price.js'
import { listAll, update } from './store.js'
import { sendDm } from './dm.js'

function formatAlert(
  sub: { thresholdPct: number; direction: string; baselineUsd: number },
  snap: PriceSnapshot,
  deltaPct: number,
): string {
  const sign = deltaPct > 0 ? '+' : ''
  return [
    `[btc-alert] BTC ${sign}${deltaPct.toFixed(2)}% (>= +-${sub.thresholdPct}%)`,
    `  price:    $${snap.usd.toLocaleString()}`,
    `  baseline: $${sub.baselineUsd.toLocaleString()}`,
    `  at:       ${new Date(snap.fetchedAt).toISOString()}`,
  ].join('\n')
}

/**
 * Wire price updates -> subscription evaluation -> DM dispatch.
 *
 * Baseline resets only after a trigger fires. Between fires the sub is
 * silenced for `sub.cooldownSec` seconds.
 */
export function startAlertDispatcher(): () => void {
  return onPriceUpdate((snap) => {
    const now = Date.now()
    for (const sub of listAll()) {
      if (sub.cooldownUntil > now) continue
      const deltaPct = ((snap.usd - sub.baselineUsd) / sub.baselineUsd) * 100
      const hit =
        (sub.direction === 'up' && deltaPct >= sub.thresholdPct) ||
        (sub.direction === 'down' && deltaPct <= -sub.thresholdPct) ||
        (sub.direction === 'both' && Math.abs(deltaPct) >= sub.thresholdPct)
      if (!hit) continue

      void sendDm(sub.notifyPubkey, formatAlert(sub, snap, deltaPct)).catch(
        (e) => console.warn('[dm-send-failed]', sub.id, e),
      )
      update(sub.id, {
        cooldownUntil: now + sub.cooldownSec * 1000,
        baselineUsd: snap.usd,
        baselineAt: snap.fetchedAt,
      })
    }
  })
}
