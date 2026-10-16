export interface SourceRequestOptions { timeoutMs?: number }

export class SourceHttpError extends Error {
  constructor(readonly status: number) { super(`Source HTTP ${status}`) }
}

export class SourceProtocolError extends Error {}
export class SourceTransportError extends Error {}
