import { useEffect, useMemo, useState } from 'preact/hooks'
import type { NostrTunClient } from '@nostr-tun/client'
import { buildClient, config } from './tunnel.js'
import {
  clearNotifyOverride,
  importSecretKey,
  loadOrCreateIdentity,
  resetIdentity,
  setNotifyPubkey,
  type Identity,
} from './keys.js'
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

function Sparkline({ samples }: { samples: number[] }) {
  if (samples.length === 0) return <span class="dim">—</span>
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const span = max - min || 1
  return (
    <>
      {samples.map((v, i) => {
        const idx = Math.min(
          SPARK_CHARS.length - 1,
          Math.max(
            0,
            Math.round(((v - min) / span) * (SPARK_CHARS.length - 1)),
          ),
        )
        const prev = samples[i - 1]
        const cls =
          prev === undefined || v === prev ? 'dim' : v > prev ? 'up' : 'down'
        return <span class={cls}>{SPARK_CHARS[idx]}</span>
      })}
    </>
  )
}

function shortBech(s: string): string {
  return s.length <= 20 ? s : s.slice(0, 12) + '…' + s.slice(-6)
}

function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${(sec / 60).toFixed(sec % 60 ? 1 : 0)}m`
  if (sec < 86_400) return `${(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`
  return `${(sec / 86_400).toFixed(sec % 86_400 ? 1 : 0)}d`
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // clipboard API not available (e.g. insecure context) — ignore
  }
}

export function App() {
  const identity = useMemo<Identity>(() => loadOrCreateIdentity(), [])
  const [client, setClient] = useState<NostrTunClient | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [price, setPrice] = useState<Price | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [priceLog, setPriceLog] = useState<
    { at: number; usd: number; deltaPct: number | null }[]
  >([])
  const [subs, setSubs] = useState<Subscription[]>([])
  const [dms, setDms] = useState<IncomingDm[]>([])
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [threshold, setThreshold] = useState('5')
  const [direction, setDirection] = useState<'up' | 'down' | 'both'>('both')
  const [cooldownSec, setCooldownSec] = useState('1800')
  const [showNsec, setShowNsec] = useState(false)
  const [pollSec, setPollSec] = useState(() => {
    const saved = localStorage.getItem('btc-alert:poll-sec')
    return saved && Number(saved) >= 5 ? saved : '30'
  })
  const [nsecInput, setNsecInput] = useState('')
  const [notifyInput, setNotifyInput] = useState('')
  const [identityError, setIdentityError] = useState<string | null>(null)

  const logLine = (text: string): void =>
    setLog((prev) => [...prev.slice(-40), { at: Date.now(), text }])

  const applyPoll = (raw: string): void => {
    const n = Math.max(5, Math.floor(Number(raw)) || 5)
    const s = String(n)
    setPollSec(s)
    localStorage.setItem('btc-alert:poll-sec', s)
  }

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
        listSubscriptions(c, identity.sk),
      ])
      setPrice(p)
      setHistory((h) => [...h.slice(-47), p.usd])
      setPriceLog((prev) => {
        if (prev[0] && prev[0].at === p.fetchedAt) return prev
        const last = prev[0]
        const deltaPct = last ? ((p.usd - last.usd) / last.usd) * 100 : null
        return [{ at: p.fetchedAt, usd: p.usd, deltaPct }, ...prev].slice(0, 20)
      })
      setSubs(s)
    } catch (e) {
      logLine(`refresh failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    if (!client) return
    const n = Math.max(5, Math.floor(Number(pollSec)) || 30)
    logLine(`polling every ${n}s`)
    void refresh(client)
    const timer = setInterval(() => void refresh(client), n * 1000)
    return () => clearInterval(timer)
  }, [client, pollSec])

  useEffect(() => {
    if (!client) return
    if (identity.separateNotify) {
      logLine('notify pubkey differs from auth — DMs will not decrypt here')
      return
    }
    let cancel: (() => void) | undefined
    void (async () => {
      cancel = await subscribeDms({
        recipientSk: identity.sk,
        recipientPk: identity.notifyPk,
        onDm: (dm) => {
          setDms((prev) => [dm, ...prev].slice(0, 20))
          logLine(`dm ← ${shortBech(dm.from)}`)
        },
        onError: (e) =>
          logLine(`dm decrypt error: ${e instanceof Error ? e.message : String(e)}`),
      })
    })()
    return () => cancel?.()
  }, [client, identity.separateNotify])

  const onCreate = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!client) return
    setBusy(true)
    try {
      const th = Number(threshold)
      const cd = Number(cooldownSec)
      await createSubscription(client, identity.sk, {
        threshold_pct: th,
        direction,
        cooldown_sec: cd,
        ...(identity.separateNotify ? { notify_pubkey: identity.notifyPk } : {}),
      })
      logLine(`subscribed ±${th}% ${direction} · cooldown ${cd}s`)
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
      await deleteSubscription(client, identity.sk, id)
      logLine(`deleted ${id}`)
      await refresh(client)
    } catch (err) {
      logLine(`delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const onImportNsec = (e: Event): void => {
    e.preventDefault()
    setIdentityError(null)
    try {
      importSecretKey(nsecInput)
      location.reload()
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : String(err))
    }
  }

  const onSetNotify = (e: Event): void => {
    e.preventDefault()
    setIdentityError(null)
    try {
      setNotifyPubkey(notifyInput)
      location.reload()
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : String(err))
    }
  }

  const onClearNotify = (): void => {
    clearNotifyOverride()
    location.reload()
  }

  const onReset = (): void => {
    if (!confirm('Wipe local auth key and any notify override? Existing server-side subscriptions will become unmanageable from this browser.'))
      return
    resetIdentity()
    location.reload()
  }

  if (bootError) {
    return (
      <div class="panel">
        <div class="panel-title">boot-error</div>
        <div class="down">{bootError}</div>
      </div>
    )
  }

  const changeClass =
    price && price.change24hPct >= 0 ? 'up' : price ? 'down' : 'dim'
  const arrow = price && price.change24hPct >= 0 ? '▲' : price ? '▼' : '·'

  return (
    <div>
      <div class="top-row">
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
          <div>
            <Sparkline samples={history} />
          </div>
          <div class="muted">
            as-of {price ? new Date(price.fetchedAt).toLocaleTimeString() : '—'}
          </div>
          <div class="form-row" style="margin-top:6px">
            <span class="muted">poll</span>
            <input
              value={pollSec}
              onInput={(e) => setPollSec((e.target as HTMLInputElement).value)}
              onBlur={(e) => applyPoll((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyPoll((e.target as HTMLInputElement).value)
                }
              }}
              size={4}
              aria-label="poll interval seconds"
            />
            <span class="dim">sec (min 5)</span>
            {([['5s', 5], ['30s', 30], ['2m', 120]] as const).map(([label, s]) => (
              <span key={label} class="x" onClick={() => applyPoll(String(s))}>
                [{label}]
              </span>
            ))}
          </div>
        </section>

        <section class="panel alerts">
          <div class="panel-title">price log</div>
          {priceLog.length === 0 ? (
            <div class="muted">no polls yet</div>
          ) : (
            priceLog.slice(0, 6).map((row) => {
              const cls =
                row.deltaPct === null
                  ? 'dim'
                  : row.deltaPct > 0
                    ? 'up'
                    : row.deltaPct < 0
                      ? 'down'
                      : 'dim'
              const sign = row.deltaPct !== null && row.deltaPct > 0 ? '+' : ''
              return (
                <div key={row.at} class="alert-row">
                  <span class="muted">
                    {new Date(row.at).toLocaleTimeString()}
                  </span>
                  <span>${row.usd.toLocaleString()}</span>
                  <span class={cls}>
                    {row.deltaPct === null
                      ? '·'
                      : `${sign}${row.deltaPct.toFixed(2)}%`}
                  </span>
                </div>
              )
            })
          )}
        </section>
      </div>

      <section class="panel">
        <div class="panel-title">identity</div>
        <div class="sub-row">
          <span class="muted">auth npub:</span>
          <span>{shortBech(identity.authNpub)}</span>
          <span class="x" title="copy" onClick={() => void copy(identity.authNpub)}>
            [copy]
          </span>
        </div>
        <div class="sub-row">
          <span class="muted">auth nsec:</span>
          <span>{showNsec ? identity.authNsec : 'nsec1' + '•'.repeat(20)}</span>
          <span class="x" onClick={() => setShowNsec((v) => !v)}>
            [{showNsec ? 'hide' : 'show'}]
          </span>
          <span class="x" onClick={() => void copy(identity.authNsec)}>
            [copy]
          </span>
        </div>
        <div class="sub-row">
          <span class="muted">notify npub:</span>
          <span>
            {identity.separateNotify
              ? shortBech(identity.notifyNpub)
              : '(same as auth)'}
          </span>
          {identity.separateNotify ? (
            <>
              <span class="x" onClick={() => void copy(identity.notifyNpub)}>
                [copy]
              </span>
              <span class="x" onClick={onClearNotify}>
                [clear]
              </span>
            </>
          ) : null}
        </div>
        {identity.separateNotify ? (
          <div class="muted">
            DMs go to a pubkey this PWA has no secret for — open your Nostr
            client on that npub to read alerts.
          </div>
        ) : null}

        <form class="form-row" onSubmit={onImportNsec}>
          <span class="prompt">&gt;</span>
          <input
            value={nsecInput}
            onInput={(e) => setNsecInput((e.target as HTMLInputElement).value)}
            placeholder="paste nsec1… or 64-hex — full identity (recommended)"
            style="flex:1"
            aria-label="import nsec"
          />
          <button type="submit">[import nsec]</button>
        </form>
        <form class="form-row" onSubmit={onSetNotify}>
          <span class="prompt">&gt;</span>
          <input
            value={notifyInput}
            onInput={(e) => setNotifyInput((e.target as HTMLInputElement).value)}
            placeholder="paste npub1… or 64-hex — notify-only"
            style="flex:1"
            aria-label="set notify npub"
          />
          <button type="submit">[set notify]</button>
          <button type="button" onClick={onReset}>
            [reset]
          </button>
        </form>
        {identityError ? <div class="down">{identityError}</div> : null}
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
                ±{s.thresholdPct}% {s.direction} · cooldown {humanDuration(s.cooldownSec)}
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
          <span class="muted">±</span>
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
            <option value="up">up only</option>
            <option value="down">down only</option>
          </select>
          <span class="muted">cooldown</span>
          <input
            value={cooldownSec}
            onInput={(e) => setCooldownSec((e.target as HTMLInputElement).value)}
            size={6}
            aria-label="cooldown seconds"
          />
          <span class="dim">sec ({humanDuration(Number(cooldownSec))})</span>
          <button type="submit" disabled={busy || !client}>
            [n]ew
          </button>
        </form>
        <div class="form-row">
          <span class="muted">preset:</span>
          {([
            ['5m', 300],
            ['30m', 1800],
            ['2h', 7200],
          ] as const).map(([label, sec]) => (
            <span
              key={label}
              class="x"
              onClick={() => setCooldownSec(String(sec))}
            >
              [{label}]
            </span>
          ))}
        </div>
        <div class="muted" style="margin-top:6px; white-space:normal">
          DM when ±{threshold || '?'}% from baseline · baseline resets only
          after a fire · next alert silenced for {humanDuration(Number(cooldownSec))}.
        </div>
      </section>

      <section class="panel">
        <div class="panel-title">inbox</div>
        {identity.separateNotify ? (
          <div class="muted">
            inbox disabled — notify npub differs from auth (DMs won't decrypt
            here).
          </div>
        ) : dms.length === 0 ? (
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
          me: {shortBech(identity.authNpub)} · server: {shortBech(config.serverPubkey || '—')}
        </span>
      </div>
    </div>
  )
}
