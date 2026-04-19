#!/usr/bin/env bun
/**
 * Generate a fresh keypair for the btc-alert-bot server.
 *
 *   bun --cwd packages/examples/btc-alert-bot/server run gen-keys
 *
 * Prints hex + bech32 forms. The hex secret key is what you put in
 * `server/.env` as BOT_SECRET_KEY; the hex public key is what the PWA
 * pins as VITE_SERVER_PUBKEY.
 *
 * Use the sibling `gen-keys:env` script to append directly to server/.env
 * (creates the file if missing, refuses to overwrite an existing
 * BOT_SECRET_KEY line).
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { bytesToHex } from '@noble/hashes/utils'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sk = generateSecretKey()
const skHex = bytesToHex(sk)
const pkHex = getPublicKey(sk)
const nsec = nip19.nsecEncode(sk)
const npub = nip19.npubEncode(pkHex)

console.log('')
console.log('  nostr-tun btc-alert-bot — generated keypair')
console.log('')
console.log('  secret (hex) : ' + skHex)
console.log('  secret (nsec): ' + nsec)
console.log('  public (hex) : ' + pkHex)
console.log('  public (npub): ' + npub)
console.log('')

const writeEnv = process.argv.includes('--env')
if (!writeEnv) {
  console.log('  next:')
  console.log('    echo "BOT_SECRET_KEY=' + skHex + '" >> server/.env')
  console.log('    # then put the hex public key into web/.env.local as VITE_SERVER_PUBKEY')
  console.log('')
  process.exit(0)
}

const envPath = resolve(import.meta.dir, '..', '.env')
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
if (/^BOT_SECRET_KEY=/m.test(existing)) {
  console.error(
    '[gen-keys] refusing to overwrite: BOT_SECRET_KEY already set in ' +
      envPath,
  )
  process.exit(2)
}
const appended = (existing.endsWith('\n') || existing.length === 0 ? existing : existing + '\n') +
  `BOT_SECRET_KEY=${skHex}\n`
writeFileSync(envPath, appended)
console.log('[gen-keys] wrote BOT_SECRET_KEY to ' + envPath)
console.log('[gen-keys] paste this into web/.env.local → VITE_SERVER_PUBKEY=' + pkHex)
