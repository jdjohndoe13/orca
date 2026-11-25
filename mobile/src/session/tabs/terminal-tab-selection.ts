import { keepsTerminalPaneVisible } from '../../terminal/session/pane-layout/mobile-terminal-pane-layout'
import type { MobileSessionTab } from './mobile-session-tabs'
import '../../i18n/mobile-i18n'

export function getActiveTabIdForHandle(
  tabs: readonly { id: string; type: string; terminal?: string | null }[],
  terminalHandle: string | null
): string | null {
  if (!terminalHandle) {
    return null
  }
  return (
    tabs.find((tab) => tab.type === 'terminal' && tab.terminal === terminalHandle)?.id ??
    terminalHandle
  )
}

/** Point the active handle at the applied tab's terminal, releasing the previous handle when
 *  its pane no longer shows it. The handle being activated is exempt from the release, and an
 *  active tab without a string handle (file/browser) clears the handle the same way — the
 *  transient-empty-snapshot case relies on it: only an explicit successful close clears it. */
export function applyActiveTerminalHandle(
  active: MobileSessionTab | null,
  deps: {
    activeHandleRef: { current: string | null }
    visibleHandles: readonly string[] | undefined
    setActiveHandle: (handle: string | null) => void
    subscribeToTerminal: (handle: string) => void
    unsubscribeTerminal: (handle: string) => void
  }
): void {
  const {
    activeHandleRef,
    visibleHandles,
    setActiveHandle,
    subscribeToTerminal,
    unsubscribeTerminal
  } = deps
  if (!active) {
    return
  }
  const terminal =
    active.type === 'terminal' && typeof active.terminal === 'string' ? active.terminal : undefined
  const previous = activeHandleRef.current
  if (previous && previous !== terminal && !keepsTerminalPaneVisible(previous, visibleHandles)) {
    unsubscribeTerminal(previous)
  }
  if (terminal) {
    activeHandleRef.current = terminal
    setActiveHandle(terminal)
    subscribeToTerminal(terminal)
    return
  }
  activeHandleRef.current = null
  setActiveHandle(null)
}
