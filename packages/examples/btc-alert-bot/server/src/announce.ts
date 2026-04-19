import { publishServiceAnnouncement } from '@nostr-tun/nostr-tools-adapters'
import type { ServiceAnnouncementContent } from '@nostr-tun/core'
import { env } from './env.js'

const REPUBLISH_INTERVAL_MS = 10 * 60 * 1000

// Keep this list in sync with the routes registered by `registerRoutes`.
// Example-level duplication is acceptable; a future iteration could expose
// `NostrTun.getManifest()` and reuse the server's own introspection.
const content: ServiceAnnouncementContent = {
  version: '0.1',
  ttl: 60,
  capabilities: { kindSet: 'nostr-tun', chunking: false },
  routes: [
    { method: 'GET', path: '/v1/price', kind: 'literal' },
    { method: 'POST', path: '/v1/subscribe', kind: 'literal' },
    { method: 'GET', path: '/v1/subscriptions', kind: 'literal' },
    { method: 'DELETE', path: '/v1/subscribe/:id', kind: 'pattern' },
  ],
}

export function startAnnouncer(): () => void {
  let stopped = false
  const publish = async (): Promise<void> => {
    if (stopped) return
    console.log(
      '[announce] publishing kind-31910 to',
      env.bootstrapRelays.length,
      'bootstrap relay(s):',
      env.bootstrapRelays.join(', '),
    )
    const startedAt = Date.now()
    try {
      await publishServiceAnnouncement({
        secretKey: env.secretKey,
        origin: 'nostr-tun',
        relays: [env.relayUrl],
        content,
        bootstrapRelays: env.bootstrapRelays,
      })
      console.log(
        `[announce] kind-31910 published in ${Date.now() - startedAt}ms`,
      )
    } catch (e) {
      console.warn('[announce] publish failed', e)
    }
  }
  void publish()
  const timer = setInterval(() => void publish(), REPUBLISH_INTERVAL_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
