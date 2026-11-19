import { forwardOrLocal } from '../../session/mobile-remote-runtime-forwarded-call'
import type { RelayTabsSource } from '../../session/mobile-remote-runtime-session-tabs'
import { terminalViewportUpdate } from '../host-operations/mobile-terminal-operations'
import {
  resolveTerminalUpdateViewportCapability,
  type TerminalUpdateViewportCapability
} from './terminal-viewport-refit-state'
import type { TerminalWebViewHandle } from '../webview/terminal-webview-contract'
import type { TerminalFrame } from '../webview/terminal-webview-messages'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

export type TerminalViewportUpdateAttempt = {
  rpc: RpcClient
  deviceToken: string
  capability: TerminalUpdateViewportCapability
  handle: string
  dims: { cols: number; rows: number }
  frame: TerminalFrame
  ref: TerminalWebViewHandle
  sessionRelay: RelayTabsSource | null | undefined
  // The trigger re-checks staleness after every await; the caller owns the answer.
  isCurrentTarget: () => boolean
  // Reports the resolved capability back so the caller can cache `unsupported`.
  onCapability: (capability: TerminalUpdateViewportCapability) => void
}

export type TerminalViewportUpdateOutcome =
  /** The PTY was resized in place; scrollback was reflowed when it could be. */
  | { kind: 'updated' }
  /** The target went stale mid-flight; the caller must not resubscribe. */
  | { kind: 'stale' }
  /** The in-place update is unavailable or refused; the caller must resubscribe. */
  | { kind: 'fallthrough' }

/**
 * Prefer an in-place `terminal.updateViewport` over resubscribe so the mobile
 * subscriber record stays alive (docs/mobile-presence-lock.md). Mirrored rows
 * send it through the gateway relay.
 */
export async function attemptTerminalViewportUpdate(
  options: TerminalViewportUpdateAttempt
): Promise<TerminalViewportUpdateOutcome> {
  const { rpc, deviceToken, capability, handle, dims, frame, ref, sessionRelay } = options
  if (capability === 'unsupported') {
    return { kind: 'fallthrough' }
  }
  try {
    const reply = await forwardOrLocal(
      rpc,
      sessionRelay,
      'terminal.updateViewport',
      {
        terminal: handle,
        client: { id: deviceToken, type: 'mobile' as const },
        viewport: dims
      },
      () =>
        terminalViewportUpdate.request(rpc, {
          terminal: handle,
          client: { id: deviceToken, type: 'mobile' as const },
          viewport: dims
        })
    )
    if (!options.isCurrentTarget()) {
      return { kind: 'stale' }
    }
    options.onCapability(resolveTerminalUpdateViewportCapability(reply))
    const outcome = terminalViewportUpdate.interpret(reply)
    if (outcome?.updated) {
      rpc.updateTerminalSubscriptionViewport(handle, dims)
      // Why: updateViewport re-streams only the visible screen, so local
      // scrollback stays wrapped at the old width — reflow it locally.
      if (outcome.applied) {
        ref.reflow(dims.cols, dims.rows, frame)
      }
      return { kind: 'updated' }
    }
  } catch {
    // Fall through to legacy resubscribe.
  }
  return { kind: 'fallthrough' }
}
