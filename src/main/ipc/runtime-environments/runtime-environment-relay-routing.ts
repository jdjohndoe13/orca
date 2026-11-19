import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  isRelayForwardableRuntimeMethod,
  runtimeEnvironmentRelayPhase1AllowlistMessage,
  RuntimeEnvironmentGatewayCallResultSchema
} from '../../../shared/rpc-contract/runtime-environment-relay-params'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { markEnvironmentUsed } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'

export const DOWNSTREAM_RUNTIME_UNAVAILABLE_CODE = 'remote_runtime_unavailable'

type DownstreamEnvironmentCallArgs = {
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

/** Throws carry codes (timeout, revision guard, queue overload); anything else
 *  is a lost gateway, which must never read as evidence the upstream died. */
function relayFailureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return DOWNSTREAM_RUNTIME_UNAVAILABLE_CODE
  }
  const { code } = error
  if (typeof code === 'string' && code !== '') {
    return code
  }
  return DOWNSTREAM_RUNTIME_UNAVAILABLE_CODE
}

/**
 * Route a downstream view row's call through its gateway. A view row's own
 * endpoints exist so the durable store schema holds and name its gateway's
 * pairing offer; the dial is always the relay method, so:
 *
 * - the renderer sees the upstream host's envelope verbatim (capability and
 *   status probes bind C1, never the gateway host itself);
 * - methods outside the Phase-1 read + Phase-2 attached-operation allowlist are
 *   refused here without a round-trip, mirroring the gateway's own gate;
 * - a gateway that answers `runtimeEnvironment.call` wraps failures inside the
 *   relay result, so no relay hop can present this renderer a lost host.
 */
export async function callDownstreamEnvironment(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  args: DownstreamEnvironmentCallArgs
): Promise<RuntimeRpcResponse<unknown>> {
  const gatewayEnvironmentId = environment.gatewayEnvironmentId
  if (!gatewayEnvironmentId) {
    throw new Error('not_a_downstream_environment')
  }
  if (!isRelayForwardableRuntimeMethod(args.method)) {
    return {
      id: args.method,
      ok: false,
      error: {
        code: 'forbidden',
        message: runtimeEnvironmentRelayPhase1AllowlistMessage(args.method)
      },
      _meta: { runtimeId: environment.runtimeId }
    }
  }
  try {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environment.id,
      RUNTIME_ENVIRONMENT_RELAY_METHOD,
      { gatewayEnvironmentId, method: args.method, params: args.params },
      args.timeoutMs,
      args.expectedEnvironmentPairingRevision,
      undefined,
      { expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId }
    )
    return claimDownstreamEnvironment(response, userDataPath, environment)
  } catch (error) {
    // The renderer reads envelopes, not throws: a lost gateway or an interrupted
    // dial resolves as one failure envelope carrying the real reason.
    return {
      id: args.method,
      ok: false,
      error: {
        code: relayFailureCode(error),
        message: error instanceof Error ? error.message : String(error)
      },
      _meta: { runtimeId: environment.runtimeId }
    }
  }
}

/**
 * Unwrap the relay result for this host's renderer: the inner envelope is what
 * callers actually asked for. A successful outer envelope also binds this view
 * row to the upstream host's runtimeId, so pairing identity follows the machine
 * the guest is looking at, not the gateway.
 */
function claimDownstreamEnvironment(
  response: RuntimeRpcResponse<unknown>,
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): RuntimeRpcResponse<unknown> {
  if (response.ok === false) {
    // The gateway itself failed (method_not_found on an old host, revision
    // guard, transport): the outer envelope is already the truest answer.
    return response
  }
  const parsed = RuntimeEnvironmentGatewayCallResultSchema.safeParse(response.result)
  if (!parsed.success) {
    return {
      id: response.id,
      ok: false,
      // Same code the runtime answers unreadable upstream envelopes with.
      error: {
        code: 'invalid_runtime_response',
        message: 'The connected server returned an unreadable relay response.'
      },
      _meta: { runtimeId: environment.runtimeId }
    }
  }
  const { response: upstream } = parsed.data
  if (isKeepaliveFrame(upstream)) {
    // Keepalive is transport framing; it is never a valid relay reply.
    return {
      id: response.id,
      ok: false,
      error: {
        code: 'invalid_runtime_response',
        message: 'The connected server returned an unreadable relay response.'
      },
      _meta: { runtimeId: environment.runtimeId }
    }
  }
  if (upstream.ok) {
    markEnvironmentUsed(userDataPath, environment.id, { runtimeId: upstream._meta.runtimeId })
  }
  return upstream
}
