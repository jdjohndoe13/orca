import type { AppState } from '../../store/types'
import { readWorkspaceSessionRecord } from '../../store/workspace-session-key'

type ActiveTerminalChromeSelectorState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'canExpandPaneByTabId'
  | 'expandedPaneByTabId'
  | 'worktreesByRepo'
  | 'activeWorkspaceExecutionHostId'
>

export type ActiveTerminalChromeState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  tabCount: number
  effectiveActiveTabId: string | null
  activeTabCanExpand: boolean
  effectiveActiveTabExpanded: boolean
}

const EMPTY_TABS: NonNullable<AppState['tabsByWorktree'][string]> = []

// Why: every Zustand write reruns this app-shell selector, including title-only tab updates.
// The cache key is the resolved row key, not the bare id: a host switch on a contested id keeps
// the bare id but swaps the row, and a bare-id compare would serve the old host's chrome.
let activeTerminalChromeCache: {
  state: ActiveTerminalChromeState
  rowKey: string | undefined
} | null = null

export function selectActiveTerminalChromeState(
  state: ActiveTerminalChromeSelectorState
): ActiveTerminalChromeState {
  const activeRow = state.activeWorktreeId
    ? readWorkspaceSessionRecord(state, state.tabsByWorktree, state.activeWorktreeId)
    : undefined
  const tabs = activeRow?.entry ?? EMPTY_TABS
  const effectiveActiveTabId = state.activeTabId ?? tabs[0]?.id ?? null
  const activeTabCanExpand = effectiveActiveTabId
    ? (state.canExpandPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const effectiveActiveTabExpanded = effectiveActiveTabId
    ? (state.expandedPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const cached = activeTerminalChromeCache
  if (
    cached &&
    cached.rowKey === activeRow?.key &&
    cached.state.activeWorktreeId === state.activeWorktreeId &&
    cached.state.activeTabId === state.activeTabId &&
    cached.state.tabCount === tabs.length &&
    cached.state.effectiveActiveTabId === effectiveActiveTabId &&
    cached.state.activeTabCanExpand === activeTabCanExpand &&
    cached.state.effectiveActiveTabExpanded === effectiveActiveTabExpanded
  ) {
    return cached.state
  }

  const selected: ActiveTerminalChromeState = {
    activeWorktreeId: state.activeWorktreeId,
    activeTabId: state.activeTabId,
    tabCount: tabs.length,
    effectiveActiveTabId,
    activeTabCanExpand,
    effectiveActiveTabExpanded
  }
  activeTerminalChromeCache = { state: selected, rowKey: activeRow?.key }
  return selected
}
