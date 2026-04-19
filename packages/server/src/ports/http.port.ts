import type { NostrRequest, NostrResponse } from '@nostrum/core'

export interface HttpPort {
  toRequest(req: NostrRequest): Request
  toNostrResponse(id: string, res: Response): Promise<NostrResponse>
}
