// Fork split: the relay streams module's pure unsubscribe helpers, moved out so the
// registry class stays inside its max-lines budget.
import type { RpcEnvelopeFields } from '../rpc/rpc-envelope-fields'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams
} from '../rpc/rpc-client-terminal-subscription'

export type StreamUnsubscribe = { method: string; params: Record<string, unknown> }

// Include the whole envelope in cleanup-slot identity; sort keys so equivalent routing names the same slot.
export function unsubscribeSlot(
  { method, params }: StreamUnsubscribe,
  envelope: RpcEnvelopeFields | undefined
): string | null {
  if (!('subscriptionId' in params)) {
    return null
  }
  const client =
    'client' in params && typeof params.client === 'object' && params.client !== null
      ? params.client
      : null
  const clientId = client && 'id' in client ? client.id : null
  const routing = envelope ? Object.entries(envelope).sort(([a], [b]) => (a < b ? -1 : 1)) : null
  return JSON.stringify([method, params.subscriptionId, clientId, routing])
}

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
