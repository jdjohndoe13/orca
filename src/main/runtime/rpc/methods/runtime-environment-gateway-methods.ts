import {
  RuntimeEnvironmentDownstreamListResultSchema,
  type RuntimeEnvironmentDownstreamListResult,
  type RuntimeEnvironmentDownstreamRow,
  type RuntimeEnvironmentDownstreamState
} from '../../../../shared/rpc-contract/runtime-environment-downstream-list-rows'
import {
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD,
  isRelayForwardableRuntimeMethod,
  relayForbiddenError,
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewayCallResultSchema,
  RuntimeEnvironmentGatewaySubscribeParamsSchema,
  RuntimeEnvironmentGatewayUnsubscribeParamsSchema,
  type RuntimeEnvironmentGatewayCallParams,
  type RuntimeEnvironmentGatewayCallResult
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { downstreamEnvironmentId } from '../../../../shared/runtime-environment-downstream-rows'
import { rewriteRelayCallParams } from './runtime-environment-relay-param-rewrite'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { RUNTIME_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { isEphemeralVmRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { withSpan, type ActiveSpan } from '../../../observability/tracer'
import { getRuntimeEnvironmentStatusSnapshots } from '../../../ipc/runtime-environments/connections/runtime-environment-request-connections'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/federation/environment-transport'
import {
  assertRelayScopeClient,
  resolveGatewayEnvironment
} from './runtime-environment-gateway-relay-scope'
import { relayRuntimeEnvironmentSubscribe } from './runtime-environment-gateway-terminal-bridge'

export { MOBILE_RELAY_VEHICLE_METHODS } from './runtime-environment-gateway-relay-scope'

export const RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF = defineMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  permission: 'workspace',
  // Why null: the census takes no params; a looseObject({}) would admit unknown keys
  // that the send-side fence cannot express.
  params: null,
  handler: (_params, ctx) =>
    withSpan(
      'runtime-environment.gateway.downstream-list',
      (span) =>
        listGatewayDownstreamEnvironments(ctx).then((result) => {
          span.setAttribute('environmentCount', result.environments.length)
          return result
        }),
      { attributes: { connectionId: ctx.connectionId ?? null } }
    )
})

export const RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF = defineMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_METHOD,
  permission: 'workspace',
  params: RuntimeEnvironmentGatewayCallParamsSchema,
  handler: (params, ctx) =>
    withSpan(
      'runtime-environment.gateway.call',
      (span) => relayRuntimeEnvironmentCall(params, ctx, span),
      {
        attributes: {
          gatewayEnvironmentId: params.gatewayEnvironmentId,
          method: params.method,
          connectionId: ctx.connectionId ?? null
        }
      }
    )
})

export const RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF = defineStreamingMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  permission: 'workspace',
  params: RuntimeEnvironmentGatewaySubscribeParamsSchema,
  handler: (params, ctx, emit) =>
    withSpan(
      'runtime-environment.gateway.downstream-subscribe',
      (span) => relayRuntimeEnvironmentSubscribe(params, ctx, emit, span),
      {
        attributes: {
          gatewayEnvironmentId: params.gatewayEnvironmentId,
          method: params.method,
          connectionId: ctx.connectionId ?? null
        }
      }
    )
})

export const RUNTIME_ENVIRONMENT_GATEWAY_UNSUBSCRIBE_METHOD_DEF = defineMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD,
  permission: 'workspace',
  params: RuntimeEnvironmentGatewayUnsubscribeParamsSchema,
  handler: (params, ctx) =>
    withSpan(
      'runtime-environment.gateway.downstream-unsubscribe',
      () => {
        assertRelayScopeClient(ctx, RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD)
        // The phone's socket is shared, so it cannot close its way out of a bridge;
        // the request id that opened the bridge is the only safe address. An
        // unknown or already-ended request is a no-op, never a slot eviction.
        ctx.runtime.releaseSubscriptionByRequest(ctx.connectionId, params.requestId)
        return { released: true }
      },
      {
        attributes: {
          requestId: params.requestId,
          connectionId: ctx.connectionId ?? null
        }
      }
    )
})

/**
 * The Phase-1 gateway surface plus its Phase-2 attached-terminal vehicle: one
 * census RPC, the forwarding call, and one stream bridge. Guests address rows
 * by the id each row carries in this host's own store
 * (`gatewayEnvironmentId`); any other spelling is refused here instead of
 * forwarded.
 */
export const RUNTIME_ENVIRONMENT_GATEWAY_METHODS = [
  RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF,
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF,
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF,
  RUNTIME_ENVIRONMENT_GATEWAY_UNSUBSCRIBE_METHOD_DEF
]

async function listGatewayDownstreamEnvironments(
  ctx: RpcContext
): Promise<RuntimeEnvironmentDownstreamListResult> {
  assertRelayScopeClient(ctx, RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD)
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
  ctx: RpcContext,
  span?: ActiveSpan
): Promise<RuntimeEnvironmentGatewayCallResult> {
  assertRelayScopeClient(ctx, RUNTIME_ENVIRONMENT_RELAY_METHOD)
  // Why the allowlist gates before the store lookup: junk ids carrying junk
  // methods must not probe which environments exist for free.
  if (!isRelayForwardableRuntimeMethod(params.method)) {
    throw relayForbiddenError(params.method)
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  const environment = resolveGatewayEnvironment(userDataPath, params)
  // Why that relay row id: the guest's renderer embeds ITS OWN row id
  // (`relay-<gatewayEnvironmentId>`) inside runtime host ids, so the gateway
  // reconstructs that exact spelling for the self-match. Outside the dial's
  // try: a host-id refusal is a fence, not a transport hiccup.
  const forwardedParams = rewriteRelayCallParams(
    params.method,
    params.params,
    downstreamEnvironmentId(params.gatewayEnvironmentId)
  )
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await relayEnvironmentTransport(ctx).call(
      environment.id,
      params.method,
      forwardedParams
    )
  } catch (error) {
    response = relayUnavailableResponse(params.method, error)
  }
  span?.setAttribute('forwardedOk', response.ok)
  if (!response.ok) {
    span?.setAttribute('forwardedErrorCode', response.error.code)
  }
  return RuntimeEnvironmentGatewayCallResultSchema.parse({
    response,
    _meta: { gatewayEnvironmentId: params.gatewayEnvironmentId }
  })
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
