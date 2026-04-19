#!/usr/bin/env bun
/**
 * Latency bench against a remote Nostr relay (no docker).
 *
 *   RELAY_URL=wss://testrelay.era21.space bun run scripts/bench-remote.ts
 *
 * Override via RELAY_URL
 * env. SKIP_DOCKER is forced on so setupEnv doesn't try to spin local docker.
 */
import { benchOne } from './lib/bench-core.js'
import { ORIGIN, RELAY_URL, setupEnv } from './lib/setup.js'

const N = Number(process.env.BENCH_N ?? 30)
const WARMUP = Number(process.env.BENCH_WARMUP ?? 3)

async function main(): Promise<void> {
  console.log(`[bench-remote] relay=${RELAY_URL}  N=${N} warmup=${WARMUP}`)
  const env = await setupEnv()
  env.client.pin(ORIGIN, {
    pubkey: env.keys.serverPk,
    relays: [RELAY_URL],
  })

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
    `Nostr (wrap → ${RELAY_URL} → unwrap)`,
    (i) =>
      env.client.fetch(`${ORIGIN}/v1/echo`, {
        method: 'POST',
        body: `nostr-${i}`,
      }),
    N,
    WARMUP,
  )

  console.log(`\nLatency (ms) — remote relay ${RELAY_URL}:`)
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

main().catch((e) => {
  console.error('[bench-remote] ERROR', e)
  process.exit(1)
})
