import type { KindSet } from './kinds.js'

/**
 * Parameterized-replaceable event kind for NostrTun service announcements.
 *
 * Shape (provisional, v0):
 *   kind    = KIND_SERVICE_ANNOUNCEMENT
 *   pubkey  = server identity (hex)
 *   tags    = [
 *     ['d',     '<origin>'],                     // parameterizer
 *     ['relay', 'wss://...'],                    // one per relay
 *     ['alt',   'nostr-tun service manifest'],   // NIP-31
 *   ]
 *   content = JSON.stringify(ServiceAnnouncementContent)
 *
 * The client discovers a server given ONLY its hex pubkey by querying a
 * small set of public bootstrap relays for the most recent event of this
 * kind authored by that pubkey.
 */
export const KIND_SERVICE_ANNOUNCEMENT = 31910

export type ServiceAnnouncementRoute = {
  method: string
  path: string
  kind: 'literal' | 'pattern'
}

export type ServiceAnnouncementContent = {
  version: '0.1'
  ttl: number
  capabilities: {
    kindSet: 'nostr-tun' | 'nip80' | KindSet
    chunking: boolean
  }
  routes: ServiceAnnouncementRoute[]
}

export type ServiceAnnouncement = {
  pubkey: string
  origin: string
  relays: string[]
  content: ServiceAnnouncementContent
}
