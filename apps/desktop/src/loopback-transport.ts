/** Retry policy for idempotent requests to the owned loopback Host. */

import { setTimeout as delay } from 'node:timers/promises'

/** Socket failures a request can meet when a pooled loopback connection is torn down. */
export const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
])

/** Pause before the single retry; the Host is local, so a failed connection is already settled. */
export const TRANSIENT_RETRY_DELAY_MS = 50

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param error - rejection from a loopback request, possibly wrapped to name the request.
 * @returns whether the cause chain ends in a socket-level transport failure rather than an RPC result.
 */
export function transientTransportFailure(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!record(current)) return false
    const code = current.code
    if (typeof code === 'string' && TRANSIENT_TRANSPORT_CODES.has(code)) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/**
 * Run one idempotent Host request, retrying a socket-level transport failure once.
 *
 * The Host closes idle keep-alive connections on its own schedule, and the
 * authentication redirect is drained rather than cancelled, so a reused
 * loopback socket can still surface `ECONNRESET`. The retry reconnects instead
 * of reporting a startup failure the user cannot act on.
 * @param operation - request to attempt, re-invoked once after a transient failure.
 * @returns the first successful result.
 */
export async function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!transientTransportFailure(error)) throw error
    await delay(TRANSIENT_RETRY_DELAY_MS)
    return operation()
  }
}
