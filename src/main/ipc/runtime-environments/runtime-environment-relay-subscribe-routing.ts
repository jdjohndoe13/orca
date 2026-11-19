import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  getPreferredPairedRuntimeConnection,
  getPreferredPairingOffer
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { isKeepaliveFrame, type RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RuntimeEnvironmentGatewaySubscribeEventSchema,
  isRelayForwardableRuntimeStreamMethod,
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from '../../../shared/rpc-contract/runtime-environment-relay-params'

type SubscribeCallbacks = {
  onEvent: (
    payload:
      | { type: 'response'; response: RuntimeRpcResponse<unknown> }
      | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
      | { type: 'error'; code: string; message: string }
      | { type: 'close' }
  ) => void
  onClose: () => void
}

/**
 * Phase-2 attached terminals over a relay view row. The outer subscription
 * carries one stream: `runtimeEnvironment.downstream.subscribe` on the row's
 * gateway, streaming one envelope payload per forwarded upstream event; binary
 * PTY frames transfer byte-verbatim on the same socket. The forwardable-method
 * set and its refusal wording live with the call allowlist they extend, so all
 * relay fences refuse with one voice.
 */
export async function subscribeRelayDownstreamEnvironment(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  method: string
  params: unknown
  timeoutMs: number
  callbacks: SubscribeCallbacks
  markUsedOnce: (runtimeId: string) => void
}): Promise<RemoteRuntimeTransportSubscription> {
  const gatewayEnvironmentId = args.environment.gatewayEnvironmentId
  if (!gatewayEnvironmentId) {
    throw new Error('not_a_downstream_environment')
  }
  if (!isRelayForwardableRuntimeStreamMethod(args.method)) {
    throw new Error(runtimeEnvironmentRelayPhase1AllowlistMessage(args.method))
  }
  const pairing = getPreferredPairingOffer(args.environment)
  const connection = getPreferredPairedRuntimeConnection(args.environment)
  let closedForwarded = false
  let openSubscription: RemoteRuntimeTransportSubscription | null = null
  const forwardClose = (): void => {
    if (closedForwarded) {
      return
    }
    closedForwarded = true
    args.callbacks.onEvent({ type: 'close' as const })
    args.callbacks.onClose()
    // A finished or dropped stream releases the outer socket here, the same
    // way a normal dedicated subscription socket closes once its consumer is
    // gone — the gateway reaps the bridged upstream subscription on socket
    // teardown or unsubscribe.
    void openSubscription?.close()
  }
  const outerCallbacks = {
    onResponse: (response: RuntimeRpcResponse<unknown>) => {
      if (response.ok === false) {
        // The outer vehicle answered with a failure envelope instead of a
        // refusal throw (disconnected route, an old gateway answering
        // method_not_found). The renderer's normal subscription path unwraps
        // response envelopes, so it rides as-is.
        args.callbacks.onEvent({ type: 'response' as const, response })
        return
      }
      const event = RuntimeEnvironmentGatewaySubscribeEventSchema.safeParse(response.result)
      if (!event.success) {
        args.callbacks.onEvent({
          type: 'error' as const,
          code: 'invalid_runtime_response',
          message: 'The connected server returned an unreadable relay response.'
        })
        return
      }
      if (event.data.type === 'end') {
        forwardClose()
        return
      }
      if (event.data.type === 'error') {
        // A lost bridged subscription is not evidence the upstream died; the
        // subscribers re-attach and the tailscale hint keeps both hops in view.
        args.callbacks.onEvent({
          type: 'error' as const,
          code: event.data.code,
          message: withRemoteRuntimeTailscaleHint(event.data.message, pairing.endpoint)
        })
        return
      }
      if (isKeepaliveFrame(event.data.response)) {
        return
      }
      if (event.data.response.ok === true) {
        // Bind the view row to the upstream host's runtimeId — the same claim
        // the call branch makes from a forwarded response envelope.
        args.markUsedOnce(event.data.response._meta.runtimeId)
      }
      args.callbacks.onEvent({ type: 'response' as const, response: event.data.response })
    },
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) =>
      args.callbacks.onEvent({ type: 'binary' as const, bytes }),
    onError: (error: { code: string; message: string }) =>
      args.callbacks.onEvent({
        type: 'error' as const,
        code: error.code,
        message: withRemoteRuntimeTailscaleHint(error.message, pairing.endpoint)
      }),
    onClose: forwardClose
  }
  try {
    const subscription = await subscribeRemoteRuntimeTransport(
      connection,
      RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
      { gatewayEnvironmentId, method: args.method, params: args.params },
      args.timeoutMs,
      outerCallbacks,
      { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
    )
    openSubscription = subscription
    return subscription
  } catch (error) {
    if (error instanceof Error) {
      error.message = withRemoteRuntimeTailscaleHint(error.message, pairing.endpoint)
    }
    throw error
  }
}
