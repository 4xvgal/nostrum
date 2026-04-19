export type NostrRequest = {
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: Uint8Array | null
  principal: string
  expiresAt: number
}

export type NostrResponse = {
  id: string
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

export type ServerInfo = {
  pubkey: string
  relays: string[]
}
