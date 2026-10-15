/** Shared reports are public, noncredentialed browser-readable evidence. */
export const PUBLIC_REPORT_HEADERS = {
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
} as const
