import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayout } from './tabs-layout'
import { buildActiveSurfacePatch } from './tabs-surface'
import {
  dedupeTabOrder,
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { getWorkspaceIdFromSessionKey } from '../../../../../shared/workspace-session-worktree-key'

export function createTabsMoveActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'moveUnifiedTabToGroup'> {
  return {
    moveUnifiedTabToGroup: (tabId, targetGroupId, opts) => {
      let moved = false
      set((state) => {
        const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        const foundTarget = findGroupAndWorktree(state.groupsByWorktree, targetGroupId)
        if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
          return state
        }
        // Both lookups walked the records, so the id they hand back is the row key — `host|id` for
        // a contested workspace id (STA-4343). Comparing the two is still the right ownership test.
        const { tab } = foundTab
        const rowKey = foundTab.worktreeId
        const worktreeId = getWorkspaceIdFromSessionKey(rowKey)
        if (tab.groupId === targetGroupId) {
          return state
        }
        const sourceGroup = findGroupForTab(state.groupsByWorktree, rowKey, tab.groupId)
        const targetGroup = foundTarget.group
        if (!sourceGroup) {
          return state
        }
        moved = true

        const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
        const sourceOrder = dedupeTabOrder(dedupedSourceGroupOrder.filter((id) => id !== tabId))
        // Why: defensive dedupe so target order can't grow a duplicate id (stale state); see dropUnifiedTab for the same guard.
        const targetOrder = dedupeTabOrder(targetGroup.tabOrder.filter((id) => id !== tabId))
        const targetIndex = Math.max(
          0,
          Math.min(opts?.index ?? targetOrder.length, targetOrder.length)
        )
        targetOrder.splice(targetIndex, 0, tabId)
        const nextActiveGroupIdByWorktree = {
          ...state.activeGroupIdByWorktree,
          [rowKey]: opts?.activate ? targetGroupId : state.activeGroupIdByWorktree[rowKey]
        }
        const sourceRecentTabIds = sanitizeRecentTabIds(
          (sourceGroup.recentTabIds ?? []).filter((id) => id !== tabId),
          sourceOrder
        )
        const nextGroups = (state.groupsByWorktree[rowKey] ?? []).map((group) => {
          if (group.id === sourceGroup.id) {
            return {
              ...group,
              activeTabId:
                group.activeTabId === tabId
                  ? // Why: keep MRU-aware selection so the user lands on their previously-focused tab, not a visual neighbor.
                    pickNextActiveTab(dedupedSourceGroupOrder, sourceGroup.recentTabIds, tabId)
                  : group.activeTabId,
              tabOrder: sourceOrder,
              recentTabIds: sourceRecentTabIds
            }
          }
          if (group.id === targetGroupId) {
            const sanitizedTargetRecent = sanitizeRecentTabIds(group.recentTabIds, targetOrder)
            return {
              ...group,
              activeTabId: opts?.activate ? tabId : group.activeTabId,
              tabOrder: targetOrder,
              recentTabIds: opts?.activate
                ? pushRecentTabId(sanitizedTargetRecent, tabId)
                : sanitizedTargetRecent
            }
          }
          return group
        })
        let nextLayoutByWorktree = state.layoutByWorktree
        let nextActiveGroupIdByWorktreeResolved = nextActiveGroupIdByWorktree
        let filteredGroups = nextGroups
        if (sourceOrder.length === 0) {
          filteredGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
          const collapsedState = collapseGroupLayout(
            nextLayoutByWorktree,
            nextActiveGroupIdByWorktreeResolved,
            worktreeId,
            sourceGroup.id,
            targetGroupId,
            rowKey
          )
          nextLayoutByWorktree = collapsedState.layoutByWorktree
          nextActiveGroupIdByWorktreeResolved = collapsedState.activeGroupIdByWorktree
        }
        const nextGroupsByWorktree = {
          ...state.groupsByWorktree,
          [rowKey]: filteredGroups
        }
        const nextUnifiedTabsByWorktree = {
          ...state.unifiedTabsByWorktree,
          [rowKey]: (state.unifiedTabsByWorktree[rowKey] ?? []).map((candidate) =>
            candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
          )
        }
        return {
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved,
          ...(state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch(
                {
                  ...state,
                  unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
                  groupsByWorktree: nextGroupsByWorktree,
                  layoutByWorktree: nextLayoutByWorktree,
                  activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved
                },
                worktreeId,
                nextActiveGroupIdByWorktreeResolved[rowKey] ?? null,
                rowKey
              )
            : {})
        }
      })
      if (moved && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('tab-splits')
      }
      return moved
    }
  }
}
