import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from '@/components/sidebar/visible-worktrees'
import { isDefaultBranchWorkspace } from '@/components/sidebar/default-branch-workspace'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../shared/execution-host'
import {
  workspaceSessionKey,
  type ContestedWorkspaceIds
} from '../../../shared/workspace-session-worktree-key'
import { isWorkspaceFromOtherDevice } from '@/components/sidebar/workspace-creator-visibility'
import type { Repo } from '../../../shared/repo-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeJumpPaletteWorktreesInput } from './worktree-jump-palette-worktrees-input'

type PaletteVisibilityArgs = {
  worktrees: readonly Worktree[]
  filterPredicate: WorktreeJumpPaletteWorktreesInput['filterPredicate']
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  showSleepingWorkspaces: boolean
  alwaysShowDefaultBranchWorkspace: boolean
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  worktreeIdsWithStructuredChat: ReadonlySet<string>
  contestedWorktreeIds: ContestedWorkspaceIds
  repoMap: Map<string, Repo>
  settings: WorktreeJumpPaletteWorktreesInput['settings']
}

/**
 * The palette's empty-query visibility filter — the same sweep the sidebar
 * pipeline applies, kept as a pure function so the hook stays a memo wire-up.
 */
export function filterWorktreeJumpPaletteVisibleWorktrees(
  args: PaletteVisibilityArgs
): readonly Worktree[] {
  const {
    worktrees,
    filterPredicate,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    pairedDeviceIdsByEnvironment,
    showSleepingWorkspaces,
    alwaysShowDefaultBranchWorkspace,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat,
    contestedWorktreeIds,
    repoMap,
    settings
  } = args
  return worktrees.filter((worktree) => {
    if (worktree.isArchived) {
      return false
    }
    if (filterPredicate && !filterPredicate.matchesWorktree(worktree)) {
      return false
    }
    if (
      hideDefaultBranchWorkspace &&
      isDefaultBranchWorkspace(worktree, repoMap.get(worktree.repoId))
    ) {
      return false
    }
    if (hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
      return false
    }
    if (hideCliCreatedWorkspaces && isCliCreatedWorkspace(worktree)) {
      return false
    }
    if (hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
      return false
    }
    if (
      hideWorkspacesFromOtherDevices &&
      isWorkspaceFromOtherDevice(worktree, pairedDeviceIdsByEnvironment)
    ) {
      return false
    }
    if (
      !showSleepingWorkspaces &&
      !isSleepingSweepExemptWorkspace(worktree, alwaysShowDefaultBranchWorkspace) &&
      isInactiveWorkspace(
        // Why the row key (STA-4343): a contested id's rows live under
        // `host|id`, so the bare read would sweep a card that has a live
        // console.
        workspaceSessionKey(
          worktree.id,
          getWorktreeExecutionHostId(
            worktree,
            repoMap.get(worktree.repoId),
            getSettingsFocusedExecutionHostId(settings)
          ),
          contestedWorktreeIds
        ),
        tabsByWorktree,
        ptyIdsByTabId,
        browserTabsByWorktree,
        worktreeIdsWithLiveAgent,
        worktreeIdsWithStructuredChat
      )
    ) {
      return false
    }
    return true
  })
}
