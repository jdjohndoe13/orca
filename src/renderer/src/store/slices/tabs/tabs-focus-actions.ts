import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree, findTabByEntityInGroup } from './tab-group-state'
import { pushRecentTabId, sanitizeRecentTabIds } from './tab-selection-history'
import { selectActiveTabForWorktree } from './active-tab-selection'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import { withPreviewEnded } from './tab-preview-flag'
import { endsPreviewHere, promotePreviewTabsThroughLayoutOwner } from './preview-tab-promotion'
import {
  replaceRecordEntries,
  replaceTabBuckets
} from '../../record-transitions/keyed-record-transitions'
import { getWorkspaceIdFromSessionKey } from '../../../../../shared/workspace-session-worktree-key'
import { resolveWorkspaceSessionRowKey } from '../../workspace-session-key'

/** Activation ends a preview unless it preserves it; main's frame ends one main owns. */
function withPreviewOnActivation(tab: Tab, preservePreview: boolean, endsHere: boolean): Tab {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { ...tab, isPreview: preservePreview ? tab.isPreview : false }
  }
  return preservePreview || !endsHere ? tab : withPreviewEnded(tab)
}

type ActivationState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'
>

/** The store update that makes `tab` its group's active tab and its group the active one;
 *  `endsPreview` is `endsPreviewHere` for the tab's workspace. */
export function tabActivationPatch(
  state: ActivationState,
  tab: Tab,
  worktreeId: string,
  opts: { preservePreview?: boolean; recordFocus?: boolean } | undefined,
  endsPreview: boolean,
  // Where this workspace's rows live: `host|id` for a contested id (STA-4343).
  rowKey: string = worktreeId
): ActivationState {
  const tabId = tab.id
  return {
    unifiedTabsByWorktree: replaceTabBuckets(state.unifiedTabsByWorktree, [
      [
        rowKey,
        (state.unifiedTabsByWorktree[rowKey] ?? []).map((item) =>
          item.id === tabId
            ? {
                ...withPreviewOnActivation(item, opts?.preservePreview === true, endsPreview),
                ...(opts?.recordFocus === false ? {} : { lastFocusedAt: Date.now() })
              }
            : item
        )
      ]
    ]),
    groupsByWorktree: replaceRecordEntries(state.groupsByWorktree, [
      [
        rowKey,
        (state.groupsByWorktree[rowKey] ?? []).map((group) =>
          group.id === tab.groupId
            ? {
                ...group,
                activeTabId: tabId,
                // Track MRU for close-time selection, pruning removed IDs.
                recentTabIds: pushRecentTabId(
                  sanitizeRecentTabIds(group.recentTabIds, group.tabOrder),
                  tabId
                )
              }
            : group
        )
      ]
    ]),
    activeGroupIdByWorktree: replaceRecordEntries(state.activeGroupIdByWorktree, [
      [rowKey, tab.groupId]
    ])
  }
}

export function createTabsFocusActions(
  _set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'getTab' | 'getActiveTab' | 'findTabForEntityInGroup' | 'activateTab'> {
  const set = _set
  return {
    getTab: (tabId) => findTabAndWorktree(get().unifiedTabsByWorktree, tabId)?.tab ?? null,

    getActiveTab: (worktreeId) => {
      const state = get()
      // The rows live under the session key, `host|id` for a contested workspace id (STA-4343).
      return selectActiveTabForWorktree(
        state,
        worktreeId,
        resolveWorkspaceSessionRowKey(state, worktreeId)
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
      const promoted: Tab[] = []
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
        if (ORCA_LAYOUT_OWNER_IS_MAIN && tab.isPreview && !opts?.preservePreview) {
          promoted.push(tab)
        }
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
          ...tabActivationPatch(
            state,
            tab,
            worktreeId,
            opts,
            endsPreviewHere(state, worktreeId),
            rowKey
          ),
          // Why: skip writing unreadTerminalTabs when the reference is unchanged, avoiding a no-op alloc that re-runs full-state selectors.
          ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {})
        }
      })
      // Switch point: main makes the activated preview permanent; its frame clears the flag.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        promotePreviewTabsThroughLayoutOwner(get(), set, promoted)
      }
    }
  }
}
