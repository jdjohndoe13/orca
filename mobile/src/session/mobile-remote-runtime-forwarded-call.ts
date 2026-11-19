import { runtimeEnvironmentCallRead } from './mobile-session-read-operations'
import type { RelayTabsSource } from './mobile-remote-runtime-session-tabs'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

// A mirrored (runtime-backed) workspace's session screen reads the upstream host's
// one-shot methods through the gateway's `runtimeEnvironment.call` vehicle. Each
// forwarded reply is `{ response: <upstream envelope> }`, so the caller unwraps it
// into the same `RpcResponse` a local call answers and runs its own operation's
// acceptance over it unchanged.

type ForwardedReply = {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

/** Derived from the operation's own sender parameter so this file never names the raw port. */
type ForwardedCallSender = Parameters<typeof runtimeEnvironmentCallRead.request>[0]

/**
 * The forwarded read for a mirrored workspace, unwrapped into the reply shape the
 * local method answers so the caller's `interpret` runs unchanged. Any refusal —
 * the call's own, the gateway's transport, or the upstream host's — arrives as a
 * `remote_runtime_unavailable` failure so the screen degrades instead of mistaking
 * an unreachable host for an empty answer.
 */
export async function forwardedRuntimeCall(
  client: ForwardedCallSender,
  gatewayEnvironmentId: string,
  method: string,
  params: unknown
): Promise<RpcResponse> {
  const response = await runtimeEnvironmentCallRead.request(client, {
    gatewayEnvironmentId,
    method,
    params
  })
  if (!response.ok) {
    return {
      id: response.id,
      ok: false,
      error: { code: 'remote_runtime_unavailable', message: response.error.message }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gateway's call result is `{ response: <upstream reply> }`; reading the member off the unknown payload is the contract's own shape.
  const forwarded = (response.result as { response?: ForwardedReply } | undefined)?.response
  if (!forwarded?.ok) {
    return {
      id: response.id,
      ok: false,
      error: {
        code: 'remote_runtime_unavailable',
        message: forwarded?.error?.message ?? 'remote runtime call unavailable'
      }
    }
  }
  return { id: response.id, ok: true, result: forwarded.result }
}

/**
 * The local-or-relay read for a one-shot method: the relay call when the row is
 * mirrored, otherwise the caller's own local request. Branching here rather than
 * at each operation keeps the local path's promise identity intact.
 */
export function forwardOrLocal(
  client: ForwardedCallSender,
  relay: RelayTabsSource | null | undefined,
  method: string,
  params: unknown,
  local: () => Promise<RpcResponse>
): Promise<RpcResponse> {
  if (relay?.mode === 'relay') {
    return forwardedRuntimeCall(client, relay.gatewayEnvironmentId, method, params)
  }
  return local()
}
