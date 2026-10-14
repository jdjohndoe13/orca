import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams
} from './rpc-client-terminal-subscription'

export type StreamUnsubscribe = { method: string; params: Record<string, unknown> }

/** The host cleanup slot an unsubscribe names; the rest of its params never identify a sibling. */
export function unsubscribeSlot({ method, params }: StreamUnsubscribe): string | null {
  if (!('subscriptionId' in params)) {
    return null
  }
  const client =
    'client' in params && typeof params.client === 'object' && params.client !== null
      ? params.client
      : null
  const clientId = client && 'id' in client ? client.id : null
  return JSON.stringify([method, params.subscriptionId, clientId])
}

/** Unsubscribe derived from the subscribe params alone (no server-assigned id). */
export function buildParamsUnsubscribe(
  method: string,
  params: unknown,
  requestId: string
): StreamUnsubscribe | null {
  if (method === 'terminal.subscribe') {
    const unsubscribeParams = buildTerminalUnsubscribeParams(params)
    return unsubscribeParams ? { method: 'terminal.unsubscribe', params: unsubscribeParams } : null
  }
  return buildStreamUnsubscribe(method, params, requestId)
}
