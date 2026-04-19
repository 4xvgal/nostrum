export type Stats = {
  n: number
  min: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const pct = (q: number): number => s[Math.floor((s.length - 1) * q)]!
  return {
    n: xs.length,
    min: +s[0]!.toFixed(3),
    mean: +mean.toFixed(3),
    p50: +pct(0.5).toFixed(3),
    p95: +pct(0.95).toFixed(3),
    p99: +pct(0.99).toFixed(3),
    max: +s.at(-1)!.toFixed(3),
  }
}

async function timedCall(
  call: (i: number) => Promise<Response>,
  i: number,
  stallAfterMs: number,
  label: string,
): Promise<{ elapsed: number }> {
  const started = performance.now()
  let stallWarned = false
  const stallTimer = setTimeout(() => {
    stallWarned = true
    console.warn(
      `[bench] ${label} iteration ${i} still running after ${stallAfterMs}ms`,
    )
  }, stallAfterMs)
  try {
    const r = await call(i)
    await r.text()
    clearTimeout(stallTimer)
    if (stallWarned) {
      console.log(
        `[bench] ${label} iteration ${i} eventually completed after ${(
          performance.now() - started
        ).toFixed(0)}ms`,
      )
    }
    return { elapsed: performance.now() - started }
  } catch (e) {
    clearTimeout(stallTimer)
    throw e
  }
}

export async function benchOne(
  label: string,
  call: (i: number) => Promise<Response>,
  n: number,
  warmup: number,
): Promise<Stats> {
  console.log(`[bench] ${label}: warmup ${warmup} iterations`)
  for (let i = 0; i < warmup; i++) {
    await timedCall(call, i, 5000, `${label} warmup`)
  }
  console.log(`[bench] ${label}: measuring ${n} iterations`)
  const times: number[] = []
  const everyN = Math.max(Math.floor(n / 5), 1)
  for (let i = 0; i < n; i++) {
    const r = await timedCall(call, i, 5000, label)
    times.push(r.elapsed)
    if ((i + 1) % everyN === 0 || i === n - 1) {
      console.log(`[bench] ${label}: ${i + 1}/${n}`)
    }
  }
  console.log(`[bench] ${label} done (${n} iterations)`)
  return stats(times)
}
