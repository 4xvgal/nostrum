import type { ServerInfo } from '@nostr-tun/core'

export interface DiscoveryPort {
  resolve(origin: string): Promise<ServerInfo | null>
}
