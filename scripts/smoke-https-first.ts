#!/usr/bin/env bun
/**
 * (B) HTTPS-first bootstrap smoke test.
 *
 * No pin. First call goes HTTP (learns Nostr-Tun-Location), second call
 * auto-switches to Nostr based on the manifest.
 */
import { ORIGIN, setupEnv } from './lib/setup.js'

function log(step: string, ...rest: unknown[]): void {
  console.log(`[smoke-https-first] ${step}`, ...rest)
}

async function main(): Promise<void> {
  const env = await setupEnv()

  log('first call — no pin, expect HTTP + learn')
  const t1 = Date.now()
  const r1 = await env.client.fetch(`${ORIGIN}/v1/echo`, {
    method: 'POST',
    body: 'call-1',
  })
  const e1 = Date.now() - t1
  const d1 = (await r1.json()) as { echoed: string; principal: string | null }
  log('result', { via: env.transports.at(-1), elapsedMs: e1, echoed: d1.echoed })

  // wait for background manifest fetch to complete
  log('waiting for background manifest fetch')
  await new Promise((r) => setTimeout(r, 800))

  log('second call — expect Nostr')
  const t2 = Date.now()
  const r2 = await env.client.fetch(`${ORIGIN}/v1/echo`, {
    method: 'POST',
    body: 'call-2',
  })
  const e2 = Date.now() - t2
  const d2 = (await r2.json()) as { echoed: string; principal: string | null }
  log('result', { via: env.transports.at(-1), elapsedMs: e2, echoed: d2.echoed })

  const ok =
    env.transports[0] === 'http' &&
    env.transports[1] === 'nostr' &&
    d1.echoed === 'call-1' &&
    d2.echoed === 'call-2' &&
    d2.principal === env.keys.clientPk

  await env.shutdown()
  if (!ok) {
    log('FAIL', env.transports)
    process.exit(1)
  }
  log('PASS ✓  HTTPS-first → Nostr auto-upgrade')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[smoke-https-first] ERROR', e)
  try {
    await Bun.spawn(['docker', 'compose', 'down', '-v'], {
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited
  } catch {}
  process.exit(1)
})
