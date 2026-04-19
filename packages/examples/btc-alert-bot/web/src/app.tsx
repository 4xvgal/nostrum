import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { NostrTunClient } from '@nostr-tun/client'
import { buildClient, config } from './tunnel.js'
import { loadOrCreateKeys } from './keys.js'
import {
  createSubscription,
  deleteSubscription,
  getPrice,
  listSubscriptions,
  type Price,
  type Subscription,
} from './api.js'
import { subscribeDms, type IncomingDm } from './dm.js'

type LogEntry = { at: number; text: string }

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

function sparkline(samples: number[]): string {
  if (samples.length === 0) return ''
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const span = max - min || 1
  return samples
    .map((v) => {
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.round(((v - min) / span) * (SPARK_CHARS.length - 1))),
      )
      return SPARK_CHARS[idx]
    })
    .join('')
}

function shortPk(pk: string): string {
  return pk.slice(0, 8) + '…' + pk.slice(-4)
}

export function App() {
  const keys = useMemo(() => loadOrCreateKeys(), [])
  const [client, setClient] = useState<NostrTunClient | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [price, setPrice] = useState<Price | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [subs, setSubs] = useState<Subscription[]>([])
  const [dms, setDms] = useState<IncomingDm[]>([])
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [threshold, setThreshold] = useState('5')
  const [direction, setDirection] = useState<'up' | 'down' | 'both'>('both')
  const [windowSec, setWindowSec] = useState('86400')

  const logLine = (text: string): void =>
    setLog((prev) => [...prev.slice(-40), { at: Date.now(), text }])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c = await buildClient()
        if (!cancelled) setClient(c)
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = async (c: NostrTunClient): Promise<void> => {
    try {
      const [p, s] = await Promise.all([
        getPrice(c),
        listSubscriptions(c, keys.sk),
      ])
      setPrice(p)
      setHistory((h) => [...h.slice(-47), p.usd])
      setSubs(s)
    } catch (e) {
      logLine(`refresh failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    if (!client) return
    logLine('tunnel ready — fetching initial state')
    void refresh(client)
    const timer = setInterval(() => void refresh(client), 30_000)
    return () => clearInterval(timer)
  }, [client])

  useEffect(() => {
    if (!client) return
    let cancel: (() => void) | undefined
    void (async () => {
      cancel = await subscribeDms({
        recipientSk: keys.sk,
        recipientPk: keys.pk,
        onDm: (dm) => {
          setDms((prev) => [dm, ...prev].slice(0, 20))
          logLine(`dm ← ${shortPk(dm.from)}`)
        },
        onError: (e) =>
          logLine(`dm decrypt error: ${e instanceof Error ? e.message : String(e)}`),
      })
    })()
    return () => cancel?.()
  }, [client])

  const onCreate = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!client) return
    setBusy(true)
    try {
      const th = Number(threshold)
      const ws = Number(windowSec)
      await createSubscription(client, keys.sk, {
        threshold_pct: th,
        direction,
        window_sec: ws,
      })
      logLine(`subscribed ±${th}% ${direction} over ${ws}s`)
      await refresh(client)
    } catch (err) {
      logLine(`subscribe failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    if (!client) return
    setBusy(true)
    try {
      await deleteSubscription(client, keys.sk, id)
      logLine(`deleted ${id}`)
      await refresh(client)
    } catch (err) {
      logLine(`delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (bootError) {
    return (
      <div class="panel">
        <div class="panel-title">boot-error</div>
        <div class="down">{bootError}</div>
        <div class="muted">
          Create <code>web/.env.local</code> with:
          {'\n'}
          VITE_SERVER_PUBKEY=&lt;bot pubkey printed at server startup&gt;
          {'\n'}
          VITE_RELAY_URL=ws://localhost:7777
        </div>
      </div>
    )
  }

  const changeClass =
    price && price.change24hPct >= 0 ? 'up' : price ? 'down' : 'dim'
  const arrow = price && price.change24hPct >= 0 ? '▲' : price ? '▼' : '·'

  return (
    <div>
      <section class="panel">
        <div class="panel-title">btc-alert</div>
        <div class="price-line">
          BTC/USD <span class={changeClass}>{arrow}</span>{' '}
          {price ? `$${price.usd.toLocaleString()}` : '—'}{' '}
          <span class={changeClass}>
            {price
              ? `${price.change24hPct >= 0 ? '+' : ''}${price.change24hPct.toFixed(2)}%`
              : ''}
          </span>
        </div>
        <div class="dim">{sparkline(history) || '—'}</div>
        <div class="muted">
          as-of {price ? new Date(price.fetchedAt).toLocaleTimeString() : '—'}
        </div>
      </section>

      <section class="panel">
        <div class="panel-title">subscriptions</div>
        {subs.length === 0 ? (
          <div class="muted">no subscriptions</div>
        ) : (
          subs.map((s) => (
            <div key={s.id} class="sub-row">
              <span class="muted">[{s.id.slice(0, 8)}]</span>
              <span>
                ±{s.thresholdPct}% {s.direction} / {s.windowSec}s
              </span>
              <span class="dim">
                base ${s.baselineUsd.toLocaleString()}
              </span>
              <span
                class="x"
                onClick={() => void onDelete(s.id)}
                title="delete"
              >
                [x]
              </span>
            </div>
          ))
        )}
        <form class="form-row" onSubmit={onCreate}>
          <span class="prompt">&gt;</span>
          <input
            value={threshold}
            onInput={(e) => setThreshold((e.target as HTMLInputElement).value)}
            size={4}
            aria-label="threshold percent"
          />
          <span class="dim">%</span>
          <select
            value={direction}
            onChange={(e) =>
              setDirection((e.target as HTMLSelectElement).value as 'up' | 'down' | 'both')
            }
          >
            <option value="both">both</option>
            <option value="up">up</option>
            <option value="down">down</option>
          </select>
          <input
            value={windowSec}
            onInput={(e) => setWindowSec((e.target as HTMLInputElement).value)}
            size={8}
            aria-label="window seconds"
          />
          <span class="dim">sec</span>
          <button type="submit" disabled={busy || !client}>
            [n]ew
          </button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-title">inbox</div>
        {dms.length === 0 ? (
          <div class="muted">no alerts received yet</div>
        ) : (
          dms.map((d) => (
            <div key={d.id} class="dim">
              {new Date(d.createdAt * 1000).toLocaleTimeString()}  {d.text.split('\n')[0]}
            </div>
          ))
        )}
      </section>

      <section class="panel">
        <div class="panel-title">log</div>
        <div class="log">
          {log.length === 0
            ? '—'
            : log
                .slice()
                .reverse()
                .map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`)
                .join('\n')}
        </div>
      </section>

      <div class="statusbar">
        <span>
          <span class={client ? 'dot' : 'dot off'}>●</span>{' '}
          {config.resolvedRelays[0] ?? `discovering via ${config.bootstrapRelays.length} relay(s)…`}
        </span>
        <span class="muted">
          me: {shortPk(keys.pk)} · server: {shortPk(config.serverPubkey || '—')}
        </span>
      </div>
    </div>
  )
}
