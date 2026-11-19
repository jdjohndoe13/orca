import { resolveActiveTabOwnerWorktreeId } from '../ownership/active-tab-owner-worktree'
import { getTerminalTabOwnerWorktreeId } from '../ownership/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from '../terminal-state'
import { ownsGlobalSelection } from '../../workspaces/selection/global-selection-owner'
import { replaceTabBuckets } from '../../record-transitions/keyed-record-transitions'
import { getWorkspaceIdFromSessionKey } from '../../../../../shared/workspace-session-worktree-key'
import { resolveWorkspaceSessionRowKey } from '../../workspace-session-key'

export function createTerminalTabNavigationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'reorderTabs'
  | 'setTabBarOrder'
  | 'setActiveTab'
  | 'setActiveTabForWorktree'
  | 'getTerminalTabOwnerWorktreeId'
> {
  return {
    reorderTabs: (worktreeId, tabIds) => {
      set((s) => {
        const rowKey = resolveWorkspaceSessionRowKey(s, worktreeId)
        const tabs = s.tabsByWorktree[rowKey] ?? []
        const tabMap = new Map(tabs.map((t) => [t.id, t]))
        const orderedSet = new Set(tabIds)
        const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))
        const reordered = [
          ...tabIds.map((id) => tabMap.get(id)!).filter(Boolean),
          ...missingTabs
        ].map((tab, i) => ({ ...tab, sortOrder: i }))
        return {
          tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, [[rowKey, reordered]])
        }
      })
    },
    setTabBarOrder: (worktreeId, order) => {
      set((s) => {
        const rowKey = resolveWorkspaceSessionRowKey(s, worktreeId)
        // Update unified visual order
        const newTabBarOrder = { ...s.tabBarOrderByWorktree, [rowKey]: order }
        // Keep terminal tab sortOrder in sync for persistence
        const tabs = s.tabsByWorktree[rowKey]
        if (!tabs) {
          return { tabBarOrderByWorktree: newTabBarOrder }
        }
        const tabMap = new Map(tabs.map((t) => [t.id, t]))
        const terminalIdsInOrder = order.filter((id) => tabMap.has(id))
        const orderedSet = new Set(terminalIdsInOrder)
        const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))
        const updatedTabs = [
          ...terminalIdsInOrder.map((id) => tabMap.get(id)!).filter(Boolean),
          ...missingTabs
        ].map((tab, i) => ({ ...tab, sortOrder: i }))
        return {
          tabBarOrderByWorktree: newTabBarOrder,
          tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, [[rowKey, updatedTabs]])
        }
      })
    },
    setActiveTab: (tabId) => {
      let tabOwnerWorktreeId: string | null = null
      set((s) => {
        // Why: clear bells only for visible tabs; background bells must persist.
        // The owner lookup scans the record, so it names the row key — `host|id` for a contested
        // workspace id (STA-4343). The maps below are keyed by that; the global selection is
        // compared against the bare id, which is what `activeWorktreeId` holds.
        tabOwnerWorktreeId = resolveActiveTabOwnerWorktreeId(
          s.tabsByWorktree,
          s.activeWorktreeId ? resolveWorkspaceSessionRowKey(s, s.activeWorktreeId) : null,
          tabId
        )
        const isActiveWorktreeTab =
          tabOwnerWorktreeId !== null &&
          ownsGlobalSelection(s, getWorkspaceIdFromSessionKey(tabOwnerWorktreeId))
        // Why: activeTabId marks the visible tab, so background bells remain unread.
        const nextUnreadTerminalTabs =
          isActiveWorktreeTab && s.unreadTerminalTabs[tabId]
            ? (() => {
                const copy = { ...s.unreadTerminalTabs }
                delete copy[tabId]
                return copy
              })()
            : s.unreadTerminalTabs
        const activeTabId = isActiveWorktreeTab ? tabId : s.activeTabId
        // Preserve map identity on redundant activation; duplicate tab IDs can prevent convergence and retrigger Terminal’s repair effect into React #185.
        const activeTabIdByWorktree =
          tabOwnerWorktreeId !== null && s.activeTabIdByWorktree[tabOwnerWorktreeId] !== tabId
            ? { ...s.activeTabIdByWorktree, [tabOwnerWorktreeId]: tabId }
            : s.activeTabIdByWorktree
        // Unchanged selection publishes nothing; every publication wakes every store subscriber.
        return activeTabId === s.activeTabId &&
          activeTabIdByWorktree === s.activeTabIdByWorktree &&
          nextUnreadTerminalTabs === s.unreadTerminalTabs
          ? s
          : { activeTabId, activeTabIdByWorktree, unreadTerminalTabs: nextUnreadTerminalTabs }
      })
      const state = get()
      const ownerUnifiedTabs =
        tabOwnerWorktreeId !== null &&
        Object.hasOwn(state.unifiedTabsByWorktree, tabOwnerWorktreeId)
          ? state.unifiedTabsByWorktree[tabOwnerWorktreeId]
          : []
      // Duplicate entity IDs must use the owner chosen above.
      const item =
        ownerUnifiedTabs.find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        ) ??
        Object.values(state.unifiedTabsByWorktree)
          .flat()
          .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
      if (item) {
        state.activateTab(
          item.id,
          tabOwnerWorktreeId !== null ? { worktreeId: tabOwnerWorktreeId } : undefined
        )
      }
    },
    getTerminalTabOwnerWorktreeId: (tabId) =>
      getTerminalTabOwnerWorktreeId(get().tabsByWorktree, tabId),
    setActiveTabForWorktree: (worktreeId, tabId) => {
      set((s) => ({
        activeTabIdByWorktree: {
          ...s.activeTabIdByWorktree,
          [resolveWorkspaceSessionRowKey(s, worktreeId)]: tabId
        }
      }))
    }
  }
}
