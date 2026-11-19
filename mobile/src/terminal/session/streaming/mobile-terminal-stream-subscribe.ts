import type { RelayTabsSource } from '../../../session/mobile-remote-runtime-session-tabs'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { TerminalWebViewHandle } from '../../webview/terminal-webview-contract'

/** A retired stream stays retired even when a cache clear reuses its numeric sequence. */
export function createMobileTerminalStreamLifetime(args: {
  isSubscriptionCurrent: () => boolean
  currentTerminal: () => TerminalWebViewHandle | undefined
  scheduleDelayedAction: (fn: () => void, ms: number) => void
  onEnd: () => void
}) {
  let ended = false
  let pendingFit = 0
  const isCurrent = () => !ended && args.isSubscriptionCurrent()
  return {
    isCurrent,
    end() {
      if (!ended) {
        ended = true
        args.onEnd()
      }
    },
    wrapUnsubscribe(unsubscribe: () => void) {
      return () => {
        ended = true
        unsubscribe()
      }
    },
    scheduleSettledFit(ref: TerminalWebViewHandle | undefined) {
      const requestedFit = ++pendingFit
      if (!ref) {
        return
      }
      // Only the latest accepted layout may refit the same document after settling.
      args.scheduleDelayedAction(() => {
        if (isCurrent() && pendingFit === requestedFit && args.currentTerminal() === ref) {
          ref.resetZoom()
        }
      }, 200)
    }
  }
}

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
    // Synchronous subscribe failures still need to release the subscribing marker.
    onSynchronousError()
    return () => {}
  }
}
