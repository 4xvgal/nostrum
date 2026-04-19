#!/usr/bin/env bun
/**
 * Latency comparison: bare HTTP vs Nostr round-trip against nostr-rs-relay.
 */
import { ORIGIN, RELAY_URL, setupEnv } from './lib/setup.js'
import { benchOne } from './lib/bench-core.js'

const N = Number(process.env.BENCH_N ?? 100)
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5)

async function main(): Promise<void> {
  const env = await setupEnv()
  env.client.pin(ORIGIN, {
    pubkey: env.keys.serverPk,
    relays: [RELAY_URL],
  })

  console.log(
    `[bench] N=${N} warmup=${WARMUP}  relay=${RELAY_URL}  origin=${ORIGIN}`,
  )

  const httpStats = await benchOne(
    'HTTP (bare)',
    (i) =>
      globalThis.fetch(`${ORIGIN}/v1/echo`, {
        method: 'POST',
        body: `bare-${i}`,
      }),
    N,
    WARMUP,
  )

  const nostrStats = await benchOne(
    'Nostr (wrap → relay → unwrap)',
    (i) =>
      env.client.fetch(`${ORIGIN}/v1/echo`, {
        method: 'POST',
        body: `nostr-${i}`,
      }),
    N,
    WARMUP,
  )

  console.log('\nLatency (ms):')
  console.table({ HTTP: httpStats, Nostr: nostrStats })
  const ratio = nostrStats.mean / httpStats.mean
  console.log(
    `Nostr overhead vs HTTP: ${ratio.toFixed(1)}x  (${(
      nostrStats.mean - httpStats.mean
    ).toFixed(1)}ms per req mean delta)`,
  )

  await env.shutdown()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[bench] ERROR', e)
  try {
    await Bun.spawn(['docker', 'compose', 'down', '-v'], {
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited
  } catch {}
  process.exit(1)
})
