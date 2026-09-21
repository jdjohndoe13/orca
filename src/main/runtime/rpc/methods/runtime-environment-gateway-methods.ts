import {
  RuntimeEnvironmentDownstreamListResultSchema,
  type RuntimeEnvironmentDownstreamListResult,
  type RuntimeEnvironmentDownstreamRow,
  type RuntimeEnvironmentDownstreamState
} from '../../../../shared/rpc-contract/runtime-environment-downstream-list-rows'
import {
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  isRemoteRuntimeRelayPhase1Method,
  runtimeEnvironmentRelayPhase1AllowlistMessage,
  RuntimeEnvironmentDownstreamListParamsSchema,
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewayCallResultSchema,
  type RuntimeEnvironmentGatewayCallParams,
  type RuntimeEnvironmentGatewayCallResult
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { isEphemeralVmRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  listEnvironments,
  resolveEnvironment,
  RuntimeEnvironmentStoreError
} from '../../../../shared/runtime-environment-store'
import { InvalidArgumentError, defineMethod, type RpcContext } from '../core'
import { getRuntimeEnvironmentStatusSnapshots } from '../../../ipc/runtime-environment-request-connections'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'

export const RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF = defineMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  params: RuntimeEnvironmentDownstreamListParamsSchema,
  handler: (_params, ctx) => listGatewayDownstreamEnvironments(ctx)
})

export const RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF = defineMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_METHOD,
  params: RuntimeEnvironmentGatewayCallParamsSchema,
  handler: async (params, ctx) => relayRuntimeEnvironmentCall(params, ctx)
})

/**
 * The Phase-1 gateway surface: one census RPC plus the forwarding RPC. Both are
 * reads and neither mints local state, so the family registers statically
 * beside the capability that advertises it. Guests address rows by the id each
 * row carries in this host's own store (`gatewayEnvironmentId`); any other
 * spelling is refused here instead of forwarded.
 */
export const RUNTIME_ENVIRONMENT_GATEWAY_METHODS = [
  RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF,
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF
]

async function listGatewayDownstreamEnvironments(
  ctx: RpcContext
): Promise<RuntimeEnvironmentDownstreamListResult> {
  assertRelayScopeClient(ctx)
  const userDataPath = getAppEnvironment().getPath('userData')
  const snapshotsById = new Map(
    getRuntimeEnvironmentStatusSnapshots().map((snapshot) => [snapshot.environmentId, snapshot])
  )
  const environments: RuntimeEnvironmentDownstreamRow[] = [
    {
      gatewayEnvironmentId: null,
      name: LOCAL_EXECUTION_HOST_ID,
      upstreamRuntimeId: ctx.runtime.getRuntimeId(),
      state: 'connected',
      capabilities: [...RUNTIME_CAPABILITIES]
    }
  ]
  for (const environment of listEnvironments(userDataPath)) {
    // Machine-local workspaces and this host's own relay-view rows stay off the
    // list: guests dial only directly paired hosts (Phase 1 has no nested relay).
    if (isEphemeralVmRuntimeEnvironment(environment) || environment.gatewayEnvironmentId) {
      continue
    }
    const snapshot = snapshotsById.get(environment.id) ?? null
    environments.push({
      gatewayEnvironmentId: environment.id,
      name: environment.name,
      upstreamRuntimeId: environment.runtimeId,
      state: gatewayDownstreamStateFor(snapshot),
      capabilities: snapshot?.status?.capabilities ?? null
    })
  }
  return RuntimeEnvironmentDownstreamListResultSchema.parse({ environments })
}

async function relayRuntimeEnvironmentCall(
  params: RuntimeEnvironmentGatewayCallParams,
  ctx: RpcContext
): Promise<RuntimeEnvironmentGatewayCallResult> {
  assertRelayScopeClient(ctx)
  // Why the allowlist gates before the store lookup: junk ids carrying junk
  // methods must not probe which environments exist for free.
  if (!isRemoteRuntimeRelayPhase1Method(params.method)) {
    throw relayPhase1ForbiddenError(params.method)
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  const environment = resolveGatewayEnvironment(userDataPath, params)
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await relayEnvironmentTransport(ctx).call(
      environment.id,
      params.method,
      params.params
    )
  } catch (error) {
    response = relayUnavailableResponse(params.method, error)
  }
  return RuntimeEnvironmentGatewayCallResultSchema.parse({
    response,
    _meta: { gatewayEnvironmentId: params.gatewayEnvironmentId }
  })
}

function resolveGatewayEnvironment(
  userDataPath: string,
  params: RuntimeEnvironmentGatewayCallParams
): ReturnType<typeof resolveEnvironment> {
  let environment: ReturnType<typeof resolveEnvironment>
  try {
    environment = resolveEnvironment(userDataPath, params.gatewayEnvironmentId)
  } catch (error) {
    if (error instanceof RuntimeEnvironmentStoreError) {
      throw new InvalidArgumentError(`Unknown gateway environment: ${params.gatewayEnvironmentId}`)
    }
    throw error
  }
  // A stored relay-view row is an address only in the guest's own store; it can
  // never name an upstream host from the gateway's side of the wire.
  if (environment.gatewayEnvironmentId) {
    throw new InvalidArgumentError(`Unknown gateway environment: ${params.gatewayEnvironmentId}`)
  }
  return environment
}

function relayEnvironmentTransport(ctx: RpcContext): OrchestrationEnvironmentTransport {
  const transport = ctx.runtime.getOrchestrationEnvironmentTransport()
  if (!transport) {
    // Same passthrough code the desktop transport answers with when a saved
    // environment cannot be dialed: mapping is centralized in rpc/errors.
    throw Object.assign(new Error('runtime_unavailable'), { code: 'runtime_unavailable' })
  }
  return transport
}

function relayUnavailableResponse(method: string, error: unknown): RuntimeRpcResponse<unknown> {
  return {
    id: method,
    ok: false,
    error: {
      // A guest deserves an answer, not a replay of this host's transport throw:
      // lost contact is never evidence of process death, so no code here claims it.
      code: 'remote_runtime_unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function gatewayDownstreamStateFor(
  snapshot: RuntimeHostStatusSnapshot | null
): RuntimeEnvironmentDownstreamState {
  if (!snapshot || snapshot.checkedAt === 0) {
    return 'unknown'
  }
  if (snapshot.status && snapshot.verification === 'verified') {
    return 'connected'
  }
  // Lost contact, retry in flight, or a positive refusal — none of these make
  // this gateway able to vouch, and none of them prove the host died.
  return 'unreachable'
}

function assertRelayScopeClient(ctx: RpcContext): void {
  // Why a second fence: the websocket gate refuses non-allowlisted methods for
  // mobile scopes ahead of dispatch, so this only fires for transports that skip
  // that gate — same pattern as the paired-only write refusals.
  if (ctx.clientKind === 'mobile') {
    throw Object.assign(new Error('Runtime relay methods are runtime-scope only.'), {
      code: 'forbidden'
    })
  }
}

function relayPhase1ForbiddenError(method: string): Error {
  return Object.assign(new Error(runtimeEnvironmentRelayPhase1AllowlistMessage(method)), {
    code: 'forbidden'
  })
}
