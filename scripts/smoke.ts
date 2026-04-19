#!/usr/bin/env bun
/**
 * (A) pin-based E2E smoke test against a real relay.
 *
 * Self-managed docker lifecycle — brings the relay up with a clean volume,
 * runs the round-trip, tears everything down (including the volume).
 *
 *   bun run smoke
 */
import { ORIGIN, RELAY_URL, setupEnv } from './lib/setup.js'

function log(step: string, ...rest: unknown[]): void {
  console.log(`[smoke] ${step}`, ...rest)
}

async function main(): Promise<void> {
  const env = await setupEnv()
  env.client.pin(ORIGIN, {
    pubkey: env.keys.serverPk,
    relays: [RELAY_URL],
  })

  log('client.fetch() — pin-based round-trip')
  const started = Date.now()
  const res = await env.client.fetch(`${ORIGIN}/v1/echo`, {
    method: 'POST',
    body: 'hello-from-smoke',
  })
  const elapsedMs = Date.now() - started
  const data = (await res.json()) as { echoed: string; principal: string }
  log('response', { status: res.status, elapsedMs, echoed: data.echoed })

  const ok =
    res.status === 200 &&
    data.echoed === 'hello-from-smoke' &&
    data.principal === env.keys.clientPk &&
    env.transports.length === 1 &&
    env.transports[0] === 'nostr'

  await env.shutdown()

  if (!ok) {
    log('FAIL', { status: res.status, echoed: data.echoed, transports: env.transports })
    process.exit(1)
  }
  log('PASS ✓  full round-trip against real relay')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[smoke] ERROR', e)
  // Best-effort teardown if setup partially completed.
  try {
    await Bun.spawn(['docker', 'compose', 'down', '-v'], {
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited
  } catch {}
  process.exit(1)
})
