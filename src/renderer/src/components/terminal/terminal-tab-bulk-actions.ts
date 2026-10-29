import type { TabContentType } from '../../../../shared/tab-types'
import {
  hasUnroutableTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { closeWebRuntimeSessionTab, isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import { resolveWorktreeSessionRowKeyFromStore } from '../terminal-workspace-session-row'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'

const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalTabBulkActionState = ReturnType<typeof useAppStore.getState>

function isPinnedVisibleTab(
  state: TerminalTabBulkActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  // Why the row key: these are the session rows the strip shows, and a contested id's rows live
  // under `host|id` — a bare read would close the other host's tabs.
  const rowKey = resolveWorktreeSessionRowKeyFromStore(activeWorktreeId)
  const currentTabs = state.tabsByWorktree[rowKey] ?? []
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id === tabId || isPinnedVisibleTab(state, rowKey, tab.id)) {
      continue
    }
    if (closeHostTerminalTabs) {
      // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
      closeLocalTerminalTabState(tab.id, { remoteCloseOwnedByHost: true })
      void closeWebRuntimeSessionTab({
        worktreeId: activeWorktreeId,
        tabId: tab.id,
        environmentId: runtimeEnvironmentId,
        reason: 'user'
      })
    } else {
      state.closeTab(tab.id)
    }
  }
}

export function closeTerminalTabsToRight(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const rowKey = resolveWorktreeSessionRowKeyFromStore(activeWorktreeId)
  const currentTerminalTabs = state.tabsByWorktree[rowKey] ?? []
  const currentEditorFiles = state.openFiles.filter((file) => file.worktreeId === activeWorktreeId)
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  const terminalIds = currentTerminalTabs.map((tab) => tab.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[rowKey],
    terminalIds,
    currentEditorFiles.map((file) => file.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  for (const id of orderedIds.slice(index + 1)) {
    if (isPinnedVisibleTab(state, rowKey, id)) {
      continue
    }
    if (terminalIdSet.has(id)) {
      if (closeHostTerminalTabs) {
        // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
        closeLocalTerminalTabState(id, { remoteCloseOwnedByHost: true })
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      } else {
        state.closeTab(id)
      }
      continue
    }
    const unifiedTab = (state.unifiedTabsByWorktree?.[rowKey] ?? []).find(
      (tab) => tab.entityId === id && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType)
    )
    if (!unifiedTab?.isPinned) {
      useAppStore.getState().closeFile(id)
    }
  }
}
