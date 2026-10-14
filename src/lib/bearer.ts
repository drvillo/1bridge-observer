import { timingSafeEqual } from 'node:crypto'

/** Keeps operator tokens out of URLs and rejects malformed or short credentials. */
export function authorizedBearer(request: Request, secret: string | undefined): boolean {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) return false
  const presented = request.headers.get('authorization')
  if (!presented?.startsWith('Bearer ')) return false
  const received = Buffer.from(presented.slice(7), 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}
