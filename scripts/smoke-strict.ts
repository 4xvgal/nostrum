#!/usr/bin/env bun
/**
 * (C) strictNostr smoke test.
 *
 * Unpinned origin + strictNostr:true → must throw NostrumStrictError
 * (no HTTPS bootstrap leak).
 */
import { ORIGIN, setupEnv } from './lib/setup.js'

function log(step: string, ...rest: unknown[]): void {
  console.log(`[smoke-strict] ${step}`, ...rest)
}

async function main(): Promise<void> {
  const env = await setupEnv({ ttl: 30, strictNostr: true })

  log('strict=true, no pin → expect NostrumStrictError')
  let threw = false
  let errName = ''
  try {
    await env.client.fetch(`${ORIGIN}/v1/echo`, {
      method: 'POST',
      body: 'should-not-reach',
    })
  } catch (e) {
    threw = true
    errName = e instanceof Error ? e.name : String(e)
    log('caught', errName, e instanceof Error ? e.message : '')
  }

  const ok = threw && errName === 'NostrumStrictError' && env.transports.length === 0

  await env.shutdown()
  if (!ok) {
    log('FAIL', { threw, errName, handlerCalls: env.transports.length })
    process.exit(1)
  }
  log('PASS ✓  strictNostr blocked HTTPS bootstrap')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[smoke-strict] ERROR', e)
  try {
    await Bun.spawn(['docker', 'compose', 'down', '-v'], {
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited
  } catch {}
  process.exit(1)
})
