import { type Stats, stats } from './bench-core.js'

/**
 * Raw relay RTT: opens one WS, then for each iteration sends a REQ and
 * measures time-to-EOSE. Closes each sub immediately after. This isolates
 * relay network + processing latency from the NostrTun wrap/unwrap path.
 */
export async function measureRelayRtt(
  relayUrl: string,
  n: number,
  warmup: number,
): Promise<Stats> {
  const ws = new WebSocket(relayUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error(`relay-rtt: WS error ${String(e)}`))
  })

  const waiters = new Map<string, () => void>()
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    if (msg[0] === 'EOSE' && typeof msg[1] === 'string') {
      const w = waiters.get(msg[1])
      if (w) {
        waiters.delete(msg[1])
        w()
      }
    }
  }

  const oneRtt = async (i: number): Promise<number> => {
    const sid = `rtt-${i}-${Math.random().toString(36).slice(2, 8)}`
    const t = performance.now()
    await new Promise<void>((resolve) => {
      waiters.set(sid, resolve)
      ws.send(JSON.stringify(['REQ', sid, { kinds: [1], limit: 1 }]))
    })
    const elapsed = performance.now() - t
    ws.send(JSON.stringify(['CLOSE', sid]))
    return elapsed
  }

  console.log(`[bench] Relay (REQ→EOSE): warmup ${warmup} iterations`)
  for (let i = 0; i < warmup; i++) await oneRtt(-1 - i)
  console.log(`[bench] Relay (REQ→EOSE): measuring ${n} iterations`)
  const times: number[] = []
  for (let i = 0; i < n; i++) times.push(await oneRtt(i))
  console.log(`[bench] Relay (REQ→EOSE) done (${n} iterations)`)

  ws.close()
  return stats(times)
}
