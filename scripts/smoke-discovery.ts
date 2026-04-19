#!/usr/bin/env bun
/**
 * E2E smoke test for kind-31910 service announcement + discovery.
 *
 * Flow:
 *   1. Generate a fresh bot keypair.
 *   2. Spawn the btc-alert-bot server subprocess with that key, pointing
 *      at a public relay for wraps and a public bootstrap set for the
 *      announcement.
 *   3. Wait for stdout to report that the kind-31910 announcement was
 *      published.
 *   4. Build a client that knows ONLY the server pubkey — no relay URL.
 *      Resolve via NostrServiceDiscoveryAdapter.
 *   5. client.fetch('nostr://<pubkey>/v1/price') — retry while 503
 *      warming-up — and assert a 200 with a plausible BTC price.
 *
 *   bun run smoke:discovery
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { NostrTunClient } from '@nostr-tun/client'
import {
  NostrServiceDiscoveryAdapter,
  NostrToolsCryptoAdapter,
  NostrToolsTransportAdapter,
} from '@nostr-tun/nostr-tools-adapters'

const BOOTSTRAP = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]
const SERVER_RELAY = 'wss://relay.damus.io'
const ANNOUNCE_TIMEOUT_MS = 30_000
const PRICE_READY_TIMEOUT_MS = 45_000

function log(step: string, ...rest: unknown[]): void {
  console.log(`[smoke-discovery] ${step}`, ...rest)
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout: ${label}`)
}

async function main(): Promise<void> {
  const botSk = generateSecretKey()
  const botSkHex = bytesToHex(botSk)
  const botPk = getPublicKey(botSk)
  log('generated bot keypair', botPk.slice(0, 16) + '…')

  log('spawning server subprocess')
  const server = Bun.spawn({
    cmd: [
      'bun',
      'run',
      'packages/examples/btc-alert-bot/server/src/index.ts',
    ],
    env: {
      ...process.env,
      BOT_SECRET_KEY: botSkHex,
      RELAY_URL: SERVER_RELAY,
      BOOTSTRAP_RELAYS: BOOTSTRAP.join(','),
      HTTP_PORT: '3199',
      POLL_INTERVAL_MS: '10000',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let announced = false
  const dec = new TextDecoder()
  const readStdout = (async () => {
    for await (const chunk of server.stdout as ReadableStream<Uint8Array>) {
      const text = dec.decode(chunk)
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        console.log('  [bot] ' + line)
        if (/kind-31910 published/.test(line)) announced = true
      }
    }
  })()
  const readStderr = (async () => {
    for await (const chunk of server.stderr as ReadableStream<Uint8Array>) {
      process.stderr.write('  [bot:err] ' + dec.decode(chunk))
    }
  })()

  const cleanup = async (): Promise<void> => {
    try {
      server.kill()
    } catch {}
    try {
      await server.exited
    } catch {}
    await Promise.allSettled([readStdout, readStderr])
  }

  try {
    await waitFor(
      () => announced,
      ANNOUNCE_TIMEOUT_MS,
      'server failed to report kind-31910 announcement',
    )
    log('✓ server announced kind-31910')

    log('resolving server by pubkey via bootstrap relays')
    const discovery = new NostrServiceDiscoveryAdapter({
      bootstrapRelays: BOOTSTRAP,
    })
    const origin = `nostr://${botPk}`
    const info = await discovery.resolve(origin)
    if (!info || info.relays.length === 0) {
      throw new Error(
        'discovery returned null — announcement not found on bootstrap relays',
      )
    }
    log('✓ discovery resolved', { relays: info.relays })
    if (!info.relays.includes(SERVER_RELAY)) {
      throw new Error(
        `discovery relays [${info.relays.join(',')}] do not include ${SERVER_RELAY}`,
      )
    }

    const clientSkBytes = generateSecretKey()
    const clientSk = bytesToHex(clientSkBytes)
    const clientPk = getPublicKey(clientSkBytes)
    const client = new NostrTunClient({
      secretKey: clientSk,
      ttl: 20,
      strictNostr: true,
    })
      .useTransport(new NostrToolsTransportAdapter(info.relays[0]!, clientPk))
      .useCrypto(new NostrToolsCryptoAdapter())
      .useDiscovery(discovery)
      .pin(origin, info)

    log('client.fetch GET /v1/price (retrying while 503 warming-up)')
    const deadline = Date.now() + PRICE_READY_TIMEOUT_MS
    let lastStatus = 0
    let data: { usd: number; change24hPct: number; fetchedAt: number } | null =
      null
    while (Date.now() < deadline) {
      try {
        const res = await client.fetch(`${origin}/v1/price`)
        lastStatus = res.status
        if (res.status === 200) {
          data = (await res.json()) as typeof data
          break
        }
      } catch (e) {
        log('fetch error', (e as Error).message)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (!data) {
      throw new Error(
        `price endpoint never returned 200 (last status ${lastStatus})`,
      )
    }
    log('✓ RPC round-trip', {
      usd: data.usd,
      change24hPct: data.change24hPct.toFixed(2) + '%',
    })
    await client.disconnect()
    log('PASS ✓  npub-only end-to-end')
  } finally {
    await cleanup()
  }
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[smoke-discovery] FAIL', e)
  process.exit(1)
})
