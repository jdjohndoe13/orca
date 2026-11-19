import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { TabSplitTarget, TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { activeSurfacePatchMatchesState, buildActiveSurfacePatch } from './tabs-surface'
import type {
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  buildSplitNode,
  collapseGroupLayout,
  replaceLeaf
} from '../../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import { workspaceRootGroupId } from '../../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import { insertTabIdIntoOrder } from '../../../../../shared/workspace-layout/tab-groups/tab-order'
import { resolveUnifiedTabCreatePlacement } from './tabs-create-placement'
import { ownsGlobalSelection } from '../../workspaces/selection/global-selection-owner'
import { replaceRecordEntries } from '../../record-transitions/keyed-record-transitions'
import { resolveWorkspaceSessionRowKey } from '../../workspace-session-key'

type SplitGroupState = Pick<
  TabsSlice,
  'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'
>

/** Places `newGroup` beside the target's source group; callers that fill it do so in the same update. */
export function insertSplitGroup(
  state: SplitGroupState,
  worktreeId: string,
  target: TabSplitTarget,
  newGroup: TabGroup,
  // Where this workspace's rows live: `host|id` for a contested id (STA-4343).
  rowKey: string = worktreeId
): SplitGroupState {
  const split = splitGroupEntries(state, worktreeId, target, newGroup, rowKey)
  return {
    groupsByWorktree: replaceRecordEntries(state.groupsByWorktree, [[rowKey, split.groups]]),
    layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [[rowKey, split.layout]]),
    activeGroupIdByWorktree:
      split.activeGroupId === null
        ? state.activeGroupIdByWorktree
        : replaceRecordEntries(state.activeGroupIdByWorktree, [[rowKey, split.activeGroupId]])
  }
}

/** insertSplitGroup's values for its one worktree; a null active group id leaves the entry unwritten. */
export function splitGroupEntries(
  state: SplitGroupState,
  worktreeId: string,
  target: TabSplitTarget,
  newGroup: TabGroup,
  rowKey: string = worktreeId
): { groups: TabGroup[]; layout: TabGroupLayoutNode; activeGroupId: string | null } {
  const { sourceGroupId, splitDirection } = target
  const currentLayout =
    state.layoutByWorktree[rowKey] ?? ({ type: 'leaf', groupId: sourceGroupId } as const)
  const replacement = buildSplitNode(
    sourceGroupId,
    newGroup.id,
    splitDirection === 'left' || splitDirection === 'right' ? 'horizontal' : 'vertical',
    splitDirection === 'left' || splitDirection === 'up' ? 'first' : 'second'
  )
  return {
    groups: [...(state.groupsByWorktree[rowKey] ?? []), newGroup],
    layout: replaceLeaf(currentLayout, sourceGroupId, replacement),
    activeGroupId: target.activate === false ? null : newGroup.id
  }
}

export function emptySplitGroup(worktreeId: string, groupId: string): TabGroup {
  return { id: groupId, worktreeId, activeTabId: null, tabOrder: [] }
}

export function createTabsGroupActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  'ensureWorktreeRootGroup' | 'focusGroup' | 'closeEmptyGroup' | 'createEmptySplitGroup'
> {
  return {
    ensureWorktreeRootGroup: (worktreeId, orderSlot) => {
      // Why the row key: a contested workspace id keys its session rows `host|id` (STA-4343), and
      // the read path asks for that key — the group has to live where the layout is read from.
      // The group's own `worktreeId` field stays the bare id: it is an entity reference that
      // survives into the per-host partition, where only the bare spelling exists.
      const rowKey = resolveWorkspaceSessionRowKey(get(), worktreeId)
      const existingGroups = get().groupsByWorktree[rowKey] ?? []
      if (!orderSlot && existingGroups.length > 0) {
        return get().activeGroupIdByWorktree[rowKey] ?? existingGroups[0].id
      }

      let groupId = workspaceRootGroupId(worktreeId)
      set((state) => {
        const groups = state.groupsByWorktree[rowKey] ?? []
        const reserved =
          orderSlot && groups.find((group) => group.tabOrder.includes(orderSlot.tabId))
        if (reserved) {
          groupId = reserved.id
          return state
        }
        const tabs = state.unifiedTabsByWorktree[rowKey] ?? []
        const placement = resolveUnifiedTabCreatePlacement({
          groups,
          tabs,
          activeGroupId: state.activeGroupIdByWorktree[rowKey],
          targetGroupId: orderSlot?.targetGroupId,
          lookupWorktrees: () => []
        })
        const group =
          groups.find((entry) => entry.id === placement.groupId) ??
          groups[0] ??
          emptySplitGroup(worktreeId, groupId)
        groupId = group.id
        let tabOrder = group.tabOrder
        if (orderSlot) {
          const { tabId, precedingTabIds } = orderSlot
          const preceding = new Set(precedingTabIds)
          const anchor = tabOrder.findLast((id) => preceding.has(id))
          tabOrder = insertTabIdIntoOrder(tabOrder, tabs, tabId, false, anchor)
          if (!anchor && precedingTabIds.length === 0) {
            tabOrder.splice(tabOrder.indexOf(tabId), 1)
            const firstUnpinned = tabOrder.findIndex(
              (id) => !tabs.find((tab) => tab.id === id)?.isPinned
            )
            tabOrder.splice(firstUnpinned === -1 ? tabOrder.length : firstUnpinned, 0, tabId)
          }
        }
        // A new root and its first order member must become observable together.
        const nextGroup = { ...group, tabOrder }
        return {
          groupsByWorktree: replaceRecordEntries(state.groupsByWorktree, [
            [
              rowKey,
              groups.length
                ? groups.map((entry) => (entry.id === groupId ? nextGroup : entry))
                : [nextGroup]
            ]
          ]),
          layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [
            [
              rowKey,
              (orderSlot && state.layoutByWorktree[rowKey]) || {
                type: 'leaf',
                groupId
              }
            ]
          ]),
          activeGroupIdByWorktree: groups.length
            ? state.activeGroupIdByWorktree
            : replaceRecordEntries(state.activeGroupIdByWorktree, [[rowKey, groupId]])
        }
      })
      return groupId
    },

    focusGroup: (worktreeId, groupId) =>
      set((state) => {
        const rowKey = resolveWorkspaceSessionRowKey(state, worktreeId)
        const groupAlreadyFocused = state.activeGroupIdByWorktree[rowKey] === groupId
        const nextActiveGroupIdByWorktree = groupAlreadyFocused
          ? state.activeGroupIdByWorktree
          : replaceRecordEntries(state.activeGroupIdByWorktree, [[rowKey, groupId]])
        // Only surface tabs of the active workspace; focusing an unseen group must not consume its bell.
        if (state.activeWorktreeId !== worktreeId) {
          if (groupAlreadyFocused) {
            return state
          }
          return {
            activeGroupIdByWorktree: nextActiveGroupIdByWorktree
          }
        }
        const activeSurfacePatch = buildActiveSurfacePatch(
          {
            ...state,
            activeGroupIdByWorktree: nextActiveGroupIdByWorktree
          },
          worktreeId,
          groupId,
          rowKey
        )
        if (
          groupAlreadyFocused &&
          activeSurfacePatchMatchesState(state, worktreeId, activeSurfacePatch, rowKey)
        ) {
          return state
        }
        return {
          ...(groupAlreadyFocused ? {} : { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }),
          ...activeSurfacePatch
        }
      }),

    closeEmptyGroup: (worktreeId, groupId) => {
      const rowKey = resolveWorkspaceSessionRowKey(get(), worktreeId)
      const state = get()
      const group = (state.groupsByWorktree[rowKey] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      // Why: ownership is tab.groupId (what the strip draws); tabOrder can hold ghost, sibling-owned or missing ids.
      const ownsTab = (state.unifiedTabsByWorktree[rowKey] ?? []).some(
        (tab) => tab.groupId === groupId
      )
      if (!group || ownsTab) {
        return false
      }
      set((current) => {
        const remainingGroups = (current.groupsByWorktree[rowKey] ?? []).filter(
          (candidate) => candidate.id !== groupId
        )
        const collapsedState = collapseGroupLayout(
          current.layoutByWorktree,
          current.activeGroupIdByWorktree,
          rowKey,
          groupId,
          remainingGroups[0]?.id ?? null,
          replaceRecordEntries
        )
        const nextGroupsByWorktree = replaceRecordEntries(current.groupsByWorktree, [
          [rowKey, remainingGroups]
        ])
        // Why: drop the dead group's recent-quick-command entry so the map can't grow unbounded as groups open/close.
        const { [groupId]: _droppedRecent, ...remainingRecent } =
          current.recentQuickCommandIdByGroup
        return {
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: collapsedState.layoutByWorktree,
          activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree,
          recentQuickCommandIdByGroup: remainingRecent,
          ...(ownsGlobalSelection(current, worktreeId)
            ? buildActiveSurfacePatch(
                {
                  ...current,
                  groupsByWorktree: nextGroupsByWorktree,
                  layoutByWorktree: collapsedState.layoutByWorktree,
                  activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree
                },
                worktreeId,
                collapsedState.activeGroupIdByWorktree[rowKey] ?? null,
                rowKey
              )
            : {})
        }
      })
      return true
    },

    createEmptySplitGroup: (worktreeId, sourceGroupId, direction, opts) => {
      const newGroupId = createBrowserUuid()
      set((state) => {
        const rowKey = resolveWorkspaceSessionRowKey(state, worktreeId)
        return {
          ...insertSplitGroup(
            state,
            worktreeId,
            { sourceGroupId, splitDirection: direction, activate: opts?.activate },
            emptySplitGroup(worktreeId, newGroupId),
            rowKey
          ),
          // The landing mark stores the bare id: the split-landing comparison reads that spelling.
          ...(opts?.landing
            ? { splitLandingGroupIds: { ...state.splitLandingGroupIds, [newGroupId]: worktreeId } }
            : {})
        }
      })
      get().recordFeatureInteraction?.('terminal-panes')
      return newGroupId
    }
  }
}
