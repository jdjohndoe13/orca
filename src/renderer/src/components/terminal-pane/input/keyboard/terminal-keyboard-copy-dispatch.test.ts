// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'

const terminalSelectionCopyMocks = vi.hoisted(() => ({
  // Why: the dispatch chains .catch on the copy call.
  copyTerminalSelection: vi.fn(() => Promise.resolve())
}))
vi.mock('../../clipboard/terminal-selection-copy', () => ({
  copyTerminalSelection: terminalSelectionCopyMocks.copyTerminalSelection
}))

type CopyPaneOverrides = {
  selection?: string
  mouseReporting?: boolean
  kittyFlags?: number
  transport?: unknown
}

function createCopyDispatchContext({
  selection = '',
  mouseReporting = false,
  kittyFlags = 0,
  transport
}: CopyPaneOverrides = {}) {
  const pane = {
    id: 1,
    terminal: {
      getSelection: () => selection,
      ...(mouseReporting
        ? {
            // Why: XTERM_MOUSE_REPORTING_CLASS is what the pane reads; the stub only has classList.
            element: { classList: { contains: (name: string) => name === 'enable-mouse-events' } }
          }
        : {})
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PaneManager's private fields make an object literal structurally uninhabitable; stub members mirror the real signature returns, and copy dispatch touches only getActivePane/getPanes.
  const manager = {
    getActivePane: () => pane,
    getPanes: () => [pane]
  } as PaneManager
  const transports = new Map<number, PtyTransport>()
  if (transport) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy-interrupt path reaches only the PTY-input writer's sendInput/sendInputAccepted; no other transport member is invoked.
    transports.set(pane.id, transport as PtyTransport)
  }
  const context: Parameters<typeof dispatchTerminalShortcutAction>[3] = {
    tabId: 'tab-1',
    worktreeId: 'folder-1',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: false },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: { current: transports },
    paneCwdRef: { current: new Map() },
    managerRef: { current: manager },
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    getKittyKeyboardFlagsActivePane: () => kittyFlags,
    armNativeOnlyShortcut: vi.fn()
  }
  return { manager, context, pane, transports }
}

function createCopyInsertEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'Insert',
    code: 'Insert',
    ctrlKey: true,
    cancelable: true
  })
}

describe('terminal copy shortcut dispatch', () => {
  it('keeps a copy chord with no selection an inert no-op in a plain shell', () => {
    // Why not just policy matching: the no-selection branch must not preventDefault
    // either, so nothing downstream (xterm encoder or browser default) re-fires it.
    const { manager, context } = createCopyDispatchContext({ mouseReporting: false })
    const event = createCopyInsertEvent()

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(false)
  })

  it('delivers ctrl+C interrupt bytes when a mouse-reporting TUI holds no selection', () => {
    // Why: TUIs copy their internal selection on Ctrl+C; the chord must claim
    // (preventDefault) and reach the PTY as the encoding a real Ctrl+C produces.
    const sendInput = vi.fn(() => true)
    const { manager, context } = createCopyDispatchContext({
      mouseReporting: true,
      kittyFlags: 0,
      transport: { sendInput }
    })
    const event = createCopyInsertEvent()

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x03', 'driving')
    expect(terminalSelectionCopyMocks.copyTerminalSelection).not.toHaveBeenCalled()
  })

  it('delivers the kitty CSI-u ctrl+C encoding when the pane negotiated kitty', () => {
    // Why: disambiguate-flag panes receive ESC[99;5u for a real Ctrl+C keydown.
    const sendInput = vi.fn(() => true)
    const { manager, context } = createCopyDispatchContext({
      mouseReporting: true,
      kittyFlags: 0b00001,
      transport: { sendInput }
    })
    const event = createCopyInsertEvent()

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b[99;5u', 'driving')
  })

  it('leaves an unclaimed copy chord alone when the pane is not mouse-reporting', () => {
    const sendInput = vi.fn(() => true)
    const { manager, context } = createCopyDispatchContext({
      mouseReporting: false,
      transport: { sendInput }
    })
    const event = createCopyInsertEvent()

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('keeps the native copy path for a real selection without PTY writes', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch reads only the preload clipboard writer; the stub keeps real clipboard access out of the test DOM.
    window.api = { ui: { writeTerminalClipboardText: vi.fn() } } as never
    const sendInput = vi.fn(() => true)
    const { manager, context } = createCopyDispatchContext({
      selection: 'copied text',
      mouseReporting: true,
      transport: { sendInput }
    })
    const event = createCopyInsertEvent()

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(true)
    expect(sendInput).not.toHaveBeenCalled()
    expect(terminalSelectionCopyMocks.copyTerminalSelection).toHaveBeenCalledTimes(1)
  })
})
