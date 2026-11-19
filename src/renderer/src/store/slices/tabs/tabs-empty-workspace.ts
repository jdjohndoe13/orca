import type { AppState } from '../../types'
import { workspaceEditorFiles } from '../editor/tabs/workspace-editor-files'
import { hasSplitLandingGroup } from './split-landing-groups'

// Last user-close lands on welcome; failed-create cleanup preserves selection.
type LandingState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'unifiedTabsByWorktree'
  | 'tabsByWorktree'
  | 'browserTabsByWorktree'
  | 'openFiles'
  | 'activeTabIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'groupsByWorktree'
  | 'splitLandingGroupIds'
>

export function landsOnEmptiedWorktree(
  current: LandingState,
  worktreeId: string,
  remainingTabs: number,
  // Where this workspace's rows live. It differs from `worktreeId` for a contested id — one repo
  // on several execution hosts, STA-4343 — whose rows are `host|id` qualified. The `openFiles` rows
  // and the split-landing marks keep the bare id, so those comparisons stay on `worktreeId`.
  rowKey: string = worktreeId
): boolean {
  return (
    current.activeWorktreeId === worktreeId &&
    remainingTabs === 0 &&
    (current.tabsByWorktree[rowKey] ?? []).length === 0 &&
    (current.browserTabsByWorktree[rowKey] ?? []).length === 0 &&
    workspaceEditorFiles(current.openFiles, current.unifiedTabsByWorktree[rowKey]).length === 0 &&
    !hasSplitLandingGroup(current, worktreeId, rowKey)
  )
}

export function emptiedWorktreeLandingPatch(
  current: LandingState,
  worktreeId: string,
  rowKey: string = worktreeId
) {
  return {
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null,
    activeTabId: null,
    activeBrowserTabId: null,
    activeFileId: null,
    activeTabType: 'terminal' as const,
    activeTabIdByWorktree: { ...current.activeTabIdByWorktree, [rowKey]: null },
    activeBrowserTabIdByWorktree: { ...current.activeBrowserTabIdByWorktree, [rowKey]: null },
    activeFileIdByWorktree: { ...current.activeFileIdByWorktree, [rowKey]: null },
    activeTabTypeByWorktree: {
      ...current.activeTabTypeByWorktree,
      [rowKey]: 'terminal' as const
    }
  }
}

type LandingSet = (update: (state: AppState) => Partial<AppState>) => void

/** After main's frame dropped a closed tab: lands when that emptied the active worktree. */
export function landOnEmptiedWorktree(
  set: LandingSet,
  get: () => AppState,
  worktreeId: string,
  rowKey: string = worktreeId
): boolean {
  const state = get()
  if (
    !landsOnEmptiedWorktree(
      state,
      worktreeId,
      (state.unifiedTabsByWorktree[rowKey] ?? []).length,
      rowKey
    )
  ) {
    return false
  }
  set((current) => emptiedWorktreeLandingPatch(current, worktreeId, rowKey))
  return true
}
