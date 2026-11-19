import {
  isRelayForwardableRuntimeStreamMethod,
  relayForbiddenError,
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  type RuntimeEnvironmentGatewaySubscribeParams
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { downstreamEnvironmentId } from '../../../../shared/runtime-environment-downstream-rows'
import { rewriteRelayCallParams } from './runtime-environment-relay-param-rewrite'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { subscribeRuntimeEnvironment } from '../../../ipc/runtime-environments/requests/runtime-environment-subscription-routing'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { RpcContext } from '../core'
import {
  assertRelayScopeClient,
  resolveGatewayEnvironment
} from './runtime-environment-gateway-relay-scope'
import type { ActiveSpan } from '../../../observability/tracer'

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
export async function relayRuntimeEnvironmentSubscribe(
  params: RuntimeEnvironmentGatewaySubscribeParams,
  ctx: RpcContext,
  emit: (result: unknown) => void,
  span?: ActiveSpan
): Promise<void> {
  assertRelayScopeClient(ctx, RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD)
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
  if (!connectionId || !sendBinary) {
    // Matches terminal.multiplex's fence semantics; one bridge owns the socket,
    // so raw registration stays conflict-free.
    throw new Error('binary_terminal_stream_required')
  }
  // Why mobile skips the raw handler: the phone's local terminal streams already
  // own this connection's binary router in per-stream mode, and registering a
  // raw handler would throw binary_handler_mode_conflict (and vice versa). The
  // phone's terminal input is JSON-only (terminal.send over the call vehicle),
  // so the inbound raw path is dead weight for it — the phone only ever
  // receives, and receiving rides sendBinary, never the router.
  const bridgesBinaryInbound = ctx.clientKind !== 'mobile'
  if (bridgesBinaryInbound && !registerBinaryMessageHandler) {
    throw new Error('binary_terminal_stream_required')
  }
  const registerRawHandler = bridgesBinaryInbound ? registerBinaryMessageHandler : null
  if (signal?.aborted) {
    return
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  const environment = resolveGatewayEnvironment(userDataPath, params)
  let upstreamSubscription: RemoteRuntimeTransportSubscription | null = null
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
    span?.addEvent('cleanup')
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
            span?.addEvent('upstream-error', { code: payload.code })
            emit({ type: 'error', code: payload.code, message: payload.message })
            return
          }
          if (payload.type === 'close') {
            // Corridor end: the forwarded close releases the guest's socket so
            // it re-attaches (the same recovery it runs for a direct stream).
            span?.addEvent('upstream-close')
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
    span?.setAttribute('environmentId', environment.id)
    span?.addEvent('upstream-subscribed')
    if (registerRawHandler) {
      // Raw bytes, no header stripping: the upstream host's binary router
      // parses TerminalStreamFrame headers exactly as it does for a local
      // desktop multiplexer.
      unregisterBinary = registerRawHandler((bytes) => {
        upstreamSubscription?.sendBinary(bytes)
      })
    }
    runtime.registerSubscriptionCleanup(
      `runtime-environment.downstream.subscribe:${connectionId}`,
      cleanup,
      connectionId,
      ctx.requestId
    )
    signal?.addEventListener('abort', cleanup, { once: true })
    await closed
  } finally {
    signal?.removeEventListener('abort', cleanup)
    cleanup()
  }
}
