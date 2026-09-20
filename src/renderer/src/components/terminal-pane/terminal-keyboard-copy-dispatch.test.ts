// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'

function createCopyDispatchContext() {
  // Why '' not null: Terminal#getSelection returns text, so falsy '' is the no-selection signal.
  const noSelectionPane = { terminal: { getSelection: () => '' } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PaneManager's private fields make an object literal structurally uninhabitable; stub members mirror the real signature returns, and the no-copy path touches only getActivePane/getPanes.
  const manager = {
    getActivePane: () => noSelectionPane,
    getPanes: () => [noSelectionPane]
  } as PaneManager
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
    paneTransportsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    managerRef: { current: manager },
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: vi.fn()
  }
  return { manager, context }
}

describe('terminal copy shortcut dispatch', () => {
  it('keeps a copy chord with no selection an inert no-op', () => {
    // Why not just policy matching: the no-selection branch must not preventDefault
    // either, so nothing downstream (xterm encoder or browser default) re-fires it.
    const { manager, context } = createCopyDispatchContext()
    const event = new KeyboardEvent('keydown', {
      key: 'Insert',
      code: 'Insert',
      ctrlKey: true,
      cancelable: true
    })

    dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)

    expect(event.defaultPrevented).toBe(false)
  })
})
