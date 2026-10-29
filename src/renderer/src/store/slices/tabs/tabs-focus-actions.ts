import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import {
  findTabAndWorktree,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { getWorkspaceIdFromSessionKey } from '../../../../../shared/workspace-session-worktree-key'
import { resolveWorkspaceSessionRowKey } from '../../workspace-session-key'

export function createTabsFocusActions(
  _set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'getTab' | 'getActiveTab' | 'findTabForEntityInGroup' | 'activateTab'> {
  const set = _set
  return {
    getTab: (tabId) => findTabAndWorktree(get().unifiedTabsByWorktree, tabId)?.tab ?? null,

    getActiveTab: (worktreeId) => {
      const state = get()
      const rowKey = resolveWorkspaceSessionRowKey(state, worktreeId)
      const groupId = state.activeGroupIdByWorktree[rowKey]
      const group = (state.groupsByWorktree[rowKey] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      if (!group?.activeTabId) {
        return null
      }
      return (
        (state.unifiedTabsByWorktree[rowKey] ?? []).find((tab) => tab.id === group.activeTabId) ??
        null
      )
    },

    findTabForEntityInGroup: (worktreeId, groupId, entityId, contentType) =>
      findTabByEntityInGroup(
        get().unifiedTabsByWorktree,
        resolveWorkspaceSessionRowKey(get(), worktreeId),
        groupId,
        entityId,
        contentType
      ),

    activateTab: (tabId, opts) => {
      set((state) => {
        const scopedWorktreeId = opts?.worktreeId
        let found: ReturnType<typeof findTabAndWorktree>
        if (scopedWorktreeId !== undefined) {
          // A caller names the workspace by its bare id; the record may key it `host|id`.
          const scopedKey = resolveWorkspaceSessionRowKey(state, scopedWorktreeId)
          const scopedTabs = Object.hasOwn(state.unifiedTabsByWorktree, scopedKey)
            ? state.unifiedTabsByWorktree[scopedKey]
            : []
          const scopedTab = scopedTabs.find((tab) => tab.id === tabId)
          found = scopedTab ? { tab: scopedTab, worktreeId: scopedKey } : null
        } else {
          found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        }
        if (!found) {
          return state
        }
        const { tab } = found
        const rowKey = found.worktreeId
        const worktreeId = getWorkspaceIdFromSessionKey(rowKey)
        // Why: activating a terminal tab dismisses its tab-level bell — the user has moved their eyes here.
        // Why (activeWorktree guard below): only when the tab is in the active worktree, else the unseen signal is lost (mirrors focusGroup).
        const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null
        const nextUnreadTerminalTabs =
          state.activeWorktreeId === worktreeId &&
          terminalEntityId &&
          state.unreadTerminalTabs[terminalEntityId]
            ? (() => {
                const copy = { ...state.unreadTerminalTabs }
                delete copy[terminalEntityId]
                return copy
              })()
            : state.unreadTerminalTabs
        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [rowKey]: (state.unifiedTabsByWorktree[rowKey] ?? []).map((item) =>
              item.id === tabId
                ? {
                    ...item,
                    isPreview: opts?.preservePreview ? item.isPreview : false,
                    ...(opts?.recordFocus === false ? {} : { lastFocusedAt: Date.now() })
                  }
                : item
            )
          },
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [rowKey]: (state.groupsByWorktree[rowKey] ?? []).map((group) =>
              group.id === tab.groupId
                ? {
                    ...group,
                    activeTabId: tabId,
                    // Why: track every activation in the group's MRU so closeUnifiedTab returns to the previous tab; sanitize to prune removed ids.
                    recentTabIds: pushRecentTabId(
                      sanitizeRecentTabIds(group.recentTabIds, group.tabOrder),
                      tabId
                    )
                  }
                : group
            )
          },
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            [rowKey]: tab.groupId
          },
          // Why: skip writing unreadTerminalTabs when the reference is unchanged, avoiding a no-op alloc that re-runs full-state selectors.
          ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {})
        }
      })
    }
  }
}
