import {
  toVisibleTabType,
  type Tab
} from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type {
  BuildSearchableWorkspaceTabsOptions,
  WorkspaceTabContentType
} from './workspace-tab-search-types'

/**
 * `rowKey` is the worktree's SESSION ROW KEY (STA-4343): a contested id's rows live under
 * `host|id`, so a bare-id read shows both claimants nothing. An uncontested id keeps the bare key.
 */
export function getActiveUnifiedTabId({
  rowKey,
  isCurrentWorktree,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  'activeGroupIdByWorktree' | 'activeTabType' | 'groupsByWorktree'
> & { rowKey: string; isCurrentWorktree: boolean }): string | null {
  if (!isCurrentWorktree) {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[rowKey]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[rowKey] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  const activeUnifiedTabId = activeGroup?.activeTabId ?? null
  return activeTabType === 'terminal' ||
    activeTabType === 'editor' ||
    activeTabType === 'agent-session'
    ? activeUnifiedTabId
    : null
}

export function isCurrentWorkspaceTab({
  tab,
  rowKey,
  isCurrentWorktree,
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  activeUnifiedTabId
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
> & {
  tab: Tab & { contentType: WorkspaceTabContentType }
  rowKey: string
  isCurrentWorktree: boolean
  activeUnifiedTabId: string | null
}): boolean {
  if (!isCurrentWorktree) {
    return false
  }
  if (activeUnifiedTabId) {
    return activeUnifiedTabId === tab.id
  }
  const visibleType = toVisibleTabType(tab.contentType)
  // `rowKey` (not the bare `tab.worktreeId`) so the stored-type lookup reads the same host's
  // row the palette is showing for a contested id (STA-4343).
  const storedType = activeTabTypeByWorktree[rowKey] ?? activeTabType
  // A chat is only current through its group's active tab id, handled above.
  if (storedType !== visibleType || visibleType === 'agent-session') {
    return false
  }
  return visibleType === 'terminal'
    ? (activeTabIdByWorktree[rowKey] ?? activeTabId) === tab.entityId
    : (activeFileIdByWorktree[rowKey] ?? activeFileId) === tab.entityId
}
