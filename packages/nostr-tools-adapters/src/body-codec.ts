export type BodyEncoding = 'utf8' | 'base64' | null

export function encodeBody(body: Uint8Array | null): {
  body: string | null
  bodyEncoding: BodyEncoding
} {
  if (body === null) return { body: null, bodyEncoding: null }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return { body: text, bodyEncoding: 'utf8' }
  } catch {
    return { body: u8ToBase64(body), bodyEncoding: 'base64' }
  }
}

export function decodeBody(
  body: string | null | undefined,
  bodyEncoding: string | null | undefined,
): Uint8Array | null {
  if (body === null || body === undefined || bodyEncoding == null) return null

  if (bodyEncoding === 'utf8') {
    return new TextEncoder().encode(body)
  }
  if (bodyEncoding === 'base64') {
    return base64ToU8(body)
  }
  return null
}

function u8ToBase64(u8: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!)
  return btoa(bin)
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}
