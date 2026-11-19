import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { AppState } from '../../../types'
import {
  replaceRecordEntries,
  replaceTabBuckets
} from '../../../record-transitions/keyed-record-transitions'

type InPlaceTabState = Pick<
  AppState,
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'tabBarOrderByWorktree'
  | 'unifiedTabsByWorktree'
>

/** Reown inside a workspace by ID change only, preserving group/order/focus; cross-workspace moves append as new tabs. */
export function rekeyRestoredEditorTabsInPlace(
  s: InPlaceTabState,
  worktreeId: string,
  fileIdMigrations: ReadonlyMap<string, string>,
  tabIdMigrations: ReadonlyMap<string, string>,
  executionHostId: ExecutionHostId,
  /**
   * Where this workspace's rows live, `host|id` for a contested id (STA-4343). The tab's own
   * `worktreeId` field keeps the bare id, so it is passed separately.
   */
  rowKey = worktreeId
): InPlaceTabState {
  const tabId = (id: string): string => tabIdMigrations.get(id) ?? id
  const fileId = (id: string): string => fileIdMigrations.get(id) ?? id
  const activeFileId = s.activeFileIdByWorktree[rowKey]
  return {
    activeFileIdByWorktree: {
      ...s.activeFileIdByWorktree,
      [rowKey]: activeFileId ? fileId(activeFileId) : activeFileId
    },
    activeGroupIdByWorktree: s.activeGroupIdByWorktree,
    activeTabTypeByWorktree: s.activeTabTypeByWorktree,
    layoutByWorktree: s.layoutByWorktree,
    groupsByWorktree: replaceRecordEntries(s.groupsByWorktree, [
      [
        rowKey,
        (s.groupsByWorktree[rowKey] ?? []).map((group) => ({
          ...group,
          activeTabId: group.activeTabId ? tabId(group.activeTabId) : group.activeTabId,
          tabOrder: group.tabOrder.map(tabId),
          ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(tabId) } : {})
        }))
      ]
    ]),
    unifiedTabsByWorktree: replaceTabBuckets(s.unifiedTabsByWorktree, [
      [
        rowKey,
        (s.unifiedTabsByWorktree[rowKey] ?? []).map((tab) =>
          tabIdMigrations.has(tab.id) || fileIdMigrations.has(tab.entityId)
            ? {
                ...tab,
                id: tabId(tab.id),
                entityId: fileId(tab.entityId),
                ...(tab.executionHostId ? { executionHostId } : {})
              }
            : tab
        )
      ]
    ]),
    tabBarOrderByWorktree: {
      ...s.tabBarOrderByWorktree,
      [rowKey]: (s.tabBarOrderByWorktree[rowKey] ?? []).map(fileId)
    }
  }
}
