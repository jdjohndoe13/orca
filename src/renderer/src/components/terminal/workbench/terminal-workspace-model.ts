import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { KeybindingContext } from '../../../../../shared/keybindings/types'
import { useAppStore } from '../../../store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { resolveWorktreeSessionRowKey } from '../../terminal-workspace-session-row'

export const CLOSE_DIALOG_DEBOUNCE_MS = 200

type TerminalStoreSnapshot = ReturnType<typeof useAppStore.getState>

export function haveSameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

/**
 * The row key of `worktreeId` in `state`.
 *
 * These helpers take the whole snapshot and a bare worktree id, so the key is resolved here rather
 * than at every caller — a contested id's unified rows live under `host|id`, and a bare read would
 * pin/close the other host's tab.
 */
function rowKeyOf(state: TerminalStoreSnapshot, worktreeId: string): string {
  return resolveWorktreeSessionRowKey(state, worktreeId)
}


function findActiveUnifiedTab(state: TerminalStoreSnapshot, worktreeId: string): Tab | null {
  const rowKey = rowKeyOf(state, worktreeId)
  const activeGroupId = state.activeGroupIdByWorktree[rowKey]
  const group =
    (state.groupsByWorktree[rowKey] ?? []).find((candidate) => candidate.id === activeGroupId) ??
    null
  if (!group?.activeTabId) {
    return null
  }
  return (
    (state.unifiedTabsByWorktree[rowKey] ?? []).find((tab) => tab.id === group.activeTabId) ?? null
  )
}

export function getActiveWorktreeRuntimeEnvironmentId(worktreeId: string | null): string | null {
  return runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
}

export function isPinnedActiveEditorTab(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  fileId: string
): boolean {
  const activeTab = findActiveUnifiedTab(state, worktreeId)
  if (activeTab) {
    return (
      activeTab.entityId === fileId &&
      isEditorTabContentType(activeTab.contentType) &&
      activeTab.isPinned === true
    )
  }
  return (
    (state.unifiedTabsByWorktree[rowKeyOf(state, worktreeId)] ?? []).some(
      (tab) =>
        tab.entityId === fileId && isEditorTabContentType(tab.contentType) && tab.isPinned === true
    ) ?? false
  )
}

export function isPinnedEditorFileTab(
  state: TerminalStoreSnapshot,
  worktreeId: string,
  fileId: string
): boolean {
  return (state.unifiedTabsByWorktree[rowKeyOf(state, worktreeId)] ?? []).some(
    (tab) => tab.entityId === fileId && isEditorTabContentType(tab.contentType) && tab.isPinned
  )
}

export function getKeybindingContext(target: EventTarget | null): KeybindingContext {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
    ? 'terminal'
    : 'app'
}
