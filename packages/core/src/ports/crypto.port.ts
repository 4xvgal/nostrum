import type { NostrRequest, NostrResponse } from '../types/index.js'

export interface CryptoPort {
  unwrapRequest(
    wrappedBytes: Uint8Array,
    callerSecretKey: string,
  ): Promise<NostrRequest | null>

  unwrapResponse(
    wrappedBytes: Uint8Array,
    callerSecretKey: string,
  ): Promise<NostrResponse | null>

  wrap(
    payload: NostrRequest | NostrResponse,
    recipientPubkey: string,
    callerSecretKey: string,
    ttl: number,
  ): Promise<Uint8Array>
}
