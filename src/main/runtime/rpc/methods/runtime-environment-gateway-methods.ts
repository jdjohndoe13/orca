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
  isRelayForwardableRuntimeMethod,
  isRelayForwardableRuntimeStreamMethod,
  relayForbiddenError,
  RuntimeEnvironmentDownstreamListParamsSchema,
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewayCallResultSchema,
  RuntimeEnvironmentGatewaySubscribeParamsSchema,
  type RuntimeEnvironmentGatewayCallParams,
  type RuntimeEnvironmentGatewayCallResult,
  type RuntimeEnvironmentGatewaySubscribeParams
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { downstreamEnvironmentId } from '../../../../shared/runtime-environment-downstream-rows'
import { rewriteRelayCallParams } from './runtime-environment-relay-param-rewrite'
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
import { InvalidArgumentError, defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import { getRuntimeEnvironmentStatusSnapshots } from '../../../ipc/runtime-environment-request-connections'
import { subscribeRuntimeEnvironment } from '../../../ipc/runtime-environment-transport-routing'
import type { RemoteRuntimeSubscription } from '../../../../shared/remote-runtime-client'
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

export const RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF = defineStreamingMethod({
  name: RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  params: RuntimeEnvironmentGatewaySubscribeParamsSchema,
  handler: (params, ctx, emit) => relayRuntimeEnvironmentSubscribe(params, ctx, emit)
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
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF
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

/**
 * Phase-2 attached terminal streams over the chassis: `terminal.multiplex` and
 * friends already open subscription sockets against this host from this
 * desktop's renderer — the bridge runs the SAME machinery
 * (`subscribeRuntimeEnvironment`) and only re-emits its events on the guest's
 * streaming socket, so lifecycle, dedupe, and revision semantics cannot drift
 * from the local desktop's behavior. Binary frames are byte-verbatim in both
 * directions: the guest's renderer and the upstream host decode the same
 * TerminalStreamFrame headers, so framing never grazes the bridge.
 */
async function relayRuntimeEnvironmentSubscribe(
  params: RuntimeEnvironmentGatewaySubscribeParams,
  ctx: RpcContext,
  emit: (result: unknown) => void
): Promise<void> {
  assertRelayScopeClient(ctx)
  // Same pre-store gate as the call method: a junk method on a junk id must not
  // probe which environments exist for free.
  if (!isRelayForwardableRuntimeStreamMethod(params.method)) {
    throw relayForbiddenError(params.method)
  }
  // Assert-style guard on the stream vehicle: subscribe params carry no host
  // ids — the bridge forwards them verbatim, so a rewritten copy means a
  // smuggled self-row runtime host id, and a foreign one throws inside.
  if (
    rewriteRelayCallParams(
      params.method,
      params.params,
      downstreamEnvironmentId(params.gatewayEnvironmentId)
    ) !== params.params
  ) {
    throw relayForbiddenError(params.method)
  }
  const { runtime, connectionId, sendBinary, registerBinaryMessageHandler, signal } = ctx
  if (!connectionId || !sendBinary || !registerBinaryMessageHandler) {
    // Matches terminal.multiplex's fence semantics; one bridge owns the socket,
    // so raw registration stays conflict-free.
    throw new Error('binary_terminal_stream_required')
  }
  if (signal?.aborted) {
    return
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  const environment = resolveGatewayEnvironment(userDataPath, params)
  let upstreamSubscription: RemoteRuntimeSubscription | null = null
  let unregistered = false
  let resolveClosed = (): void => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const cleanup = (): void => {
    if (unregistered) {
      return
    }
    unregistered = true
    try {
      unregisterBinary()
    } finally {
      try {
        upstreamSubscription?.close()
      } finally {
        resolveClosed()
      }
    }
  }
  let unregisterBinary = (): void => {}
  try {
    upstreamSubscription = await subscribeRuntimeEnvironment(
      userDataPath,
      environment.id,
      params.method,
      params.params,
      undefined,
      {
        onEvent: (payload) => {
          if (payload.type === 'binary') {
            sendBinary(payload.bytes)
            return
          }
          if (payload.type === 'error') {
            emit({ type: 'error', code: payload.code, message: payload.message })
            return
          }
          if (payload.type === 'close') {
            // Corridor end: the forwarded close releases the guest's socket so
            // it re-attaches (the same recovery it runs for a direct stream).
            emit({ type: 'end' })
            resolveClosed()
            return
          }
          emit({ type: 'response', response: payload.response })
        },
        onClose: () => resolveClosed()
      }
    )
    if (signal?.aborted) {
      return
    }
    unregisterBinary = registerBinaryMessageHandler((bytes) => {
      // Raw bytes, no header stripping: the upstream host's binary router
      // parses TerminalStreamFrame headers exactly as it does for a local
      // desktop multiplexer.
      upstreamSubscription?.sendBinary(bytes)
    })
    runtime.registerSubscriptionCleanup(
      `runtime-environment.downstream.subscribe:${connectionId}`,
      cleanup,
      connectionId
    )
    signal?.addEventListener('abort', cleanup, { once: true })
    await closed
  } finally {
    signal?.removeEventListener('abort', cleanup)
    cleanup()
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
