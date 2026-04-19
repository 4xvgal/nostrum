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
    return { body: Buffer.from(body).toString('base64'), bodyEncoding: 'base64' }
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
    const buf = Buffer.from(body, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  return null
}
