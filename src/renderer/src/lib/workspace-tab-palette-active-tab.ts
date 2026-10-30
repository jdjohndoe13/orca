import type { Tab } from '../../../shared/tab-types'
import type {
  BuildSearchableWorkspaceTabsOptions,
  WorkspaceTabContentType
} from './workspace-tab-palette-search'

/**
 * The active-tab lookups of the workspace-tab palette, resolved by the worktree's
 * SESSION ROW KEY (STA-4343): a contested id's rows live under `host|id`, so a
 * bare-id read shows both claimants nothing. An uncontested id keeps the bare key.
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
  return activeTabType === 'terminal' || activeTabType === 'editor' ? activeUnifiedTabId : null
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
  const visibleType = tab.contentType === 'terminal' ? 'terminal' : 'editor'
  const storedType = activeTabTypeByWorktree[rowKey] ?? activeTabType
  if (storedType !== visibleType) {
    return false
  }
  return visibleType === 'terminal'
    ? (activeTabIdByWorktree[rowKey] ?? activeTabId) === tab.entityId
    : (activeFileIdByWorktree[rowKey] ?? activeFileId) === tab.entityId
}
