import { Hono } from 'hono'
import {
  HonoAdapter,
  InMemoryStorageAdapter,
  NostrTun,
} from '@nostr-tun/server'
import {
  NostrToolsCryptoAdapter,
  NostrToolsRelayAdapter,
} from '@nostr-tun/nostr-tools-adapters'
import { env } from './env.js'
import { registerRoutes } from './routes.js'
import { startPoller } from './price.js'
import { startAlertDispatcher } from './alerts.js'
import { startAnnouncer } from './announce.js'

async function main(): Promise<void> {
  const app = new Hono()

  const tunnel = new NostrTun({
    relays: [env.relayUrl],
    secretKey: env.secretKey,
    pubkey: env.pubkey,
    ttl: 60,
  })
    .useRelay(new NostrToolsRelayAdapter(env.relayUrl, env.pubkey))
    .useCrypto(new NostrToolsCryptoAdapter())
    .useStorage(new InMemoryStorageAdapter())
    .useHttp(new HonoAdapter())
    .attachApp(app)

  app.use('*', tunnel.advertise())
  app.get('/.well-known/nostr-tun.json', tunnel.manifest())
  registerRoutes(app, tunnel.route())

  const stopPoller = startPoller()
  const stopAlerts = startAlertDispatcher()

  console.log('[btc-alert-bot]')
  console.log('  pubkey:    ', env.pubkey)
  console.log('  relay:     ', env.relayUrl)
  console.log('  bootstrap: ', env.bootstrapRelays.join(', '))
  console.log('  http:      ', `http://localhost:${env.httpPort}`)

  const httpServer = Bun.serve({ port: env.httpPort, fetch: app.fetch })
  console.log('[btc-alert-bot] tunnel.connect() →', env.relayUrl)
  const t0 = Date.now()
  await tunnel.connect()
  console.log(`[btc-alert-bot] tunnel connected in ${Date.now() - t0}ms`)
  const stopAnnouncer = startAnnouncer()

  const shutdown = async (): Promise<void> => {
    stopAnnouncer()
    stopAlerts()
    stopPoller()
    await tunnel.disconnect()
    httpServer.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((e) => {
  console.error('[btc-alert-bot] fatal', e)
  process.exit(1)
})
