import type { ServerInfo } from '@nostrum/core'

export interface DiscoveryPort {
  resolve(origin: string): Promise<ServerInfo | null>
}
