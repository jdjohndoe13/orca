import type { RelayTabsSource } from './mobile-remote-runtime-session-tabs'
import type { RpcClient } from '../transport/rpc-client'

/**
 * Opens the terminal's output stream, or its gateway bridge when the workspace
 * is mirrored (runtime-backed). The bridge is the same `terminal.subscribe`
 * wrapped in the `downstream.subscribe` vehicle: the gateway re-emits the
 * upstream host's events unwrapped and forwards its binary frames, so the
 * caller's event handler sees the same stream either way.
 */
export function subscribeMobileTerminalSafely(
  client: Pick<RpcClient, 'subscribe'>,
  params: unknown,
  onData: Parameters<RpcClient['subscribe']>[2],
  onSynchronousError: () => void,
  relay?: RelayTabsSource | null
): () => void {
  const bridge =
    relay?.mode === 'relay'
      ? {
          gatewayEnvironmentId: relay.gatewayEnvironmentId,
          method: 'terminal.subscribe',
          params
        }
      : null
  try {
    return bridge
      ? client.subscribe('runtimeEnvironment.downstream.subscribe', bridge, onData)
      : client.subscribe('terminal.subscribe', params, onData)
  } catch {
    // Why: a transport mock or closing socket can reject before returning an
    // unsubscribe handle; callers must still release their subscribing marker.
    onSynchronousError()
    return () => {}
  }
}
