import { useMemo } from 'react'
import {
  buildDesktopWorkspaceRowFactReader,
  type DesktopWorkspaceRowFactInputs
} from '@/components/sidebar/worktree-list/listing/desktop-workspace-row-facts'
import {
  filterWorkspaceRows,
  type WorkspaceRowFilters
} from '../../../../../shared/workspace-view/workspace-row-filters'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeJumpPaletteFilter } from '../results/use-worktree-jump-palette-filter'

type EmptyQueryVisibleInput = {
  workspaces: readonly Worktree[]
  filterOptions: WorkspaceRowFilters
  factReaderInput: DesktopWorkspaceRowFactInputs
  filterPredicate: WorktreeJumpPaletteFilter['filterPredicate']
}

/**
 * The palette's empty-query row set: the same filter the sidebar list uses, with the
 * sidebar's repo/host scope deliberately empty (the palette's own filter predicate
 * scopes it instead).
 */
export function selectEmptyQueryVisibleWorktrees({
  workspaces,
  filterOptions,
  factReaderInput,
  filterPredicate
}: EmptyQueryVisibleInput): readonly Worktree[] {
  const visible = filterWorkspaceRows(
    workspaces,
    filterOptions,
    buildDesktopWorkspaceRowFactReader(factReaderInput)
  )
  return filterPredicate ? visible.filter(filterPredicate.matchesWorktree) : visible
}

export type PaletteEmptyQueryVisibleDeps = Omit<
  EmptyQueryVisibleInput,
  'filterOptions' | 'factReaderInput'
> &
  DesktopWorkspaceRowFactInputs &
  Omit<WorkspaceRowFilters, 'filterRepoIds' | 'visibleHostIds' | 'hideSleepingWorkspaces'> & {
    /** The palette tracks the positive flag; the filter takes the negative form. */
    showSleepingWorkspaces: boolean
  }

/** Memoized {@link selectEmptyQueryVisibleWorktrees} over the palette's store inputs. */
export function usePaletteEmptyQueryVisibleWorktrees(
  input: PaletteEmptyQueryVisibleDeps
): readonly Worktree[] {
  return useMemo(
    () =>
      selectEmptyQueryVisibleWorktrees({
        workspaces: input.workspaces,
        filterOptions: {
          hideSleepingWorkspaces: !input.showSleepingWorkspaces,
          alwaysShowDefaultBranchWorkspace: input.alwaysShowDefaultBranchWorkspace,
          hideDefaultBranchWorkspace: input.hideDefaultBranchWorkspace,
          hideAutomationGeneratedWorkspaces: input.hideAutomationGeneratedWorkspaces,
          hideCliCreatedWorkspaces: input.hideCliCreatedWorkspaces,
          hideDetachedHeadWorkspaces: input.hideDetachedHeadWorkspaces,
          hideWorkspacesFromOtherDevices: input.hideWorkspacesFromOtherDevices,
          // Why no project or host scope: the palette ignores the sidebar's scope; filterPredicate scopes it.
          filterRepoIds: [],
          visibleHostIds: null
        },
        factReaderInput: {
          repoMap: input.repoMap,
          hiddenProjects: input.hiddenProjects,
          defaultHostId: input.defaultHostId,
          pairedDeviceIdsByEnvironment: input.pairedDeviceIdsByEnvironment,
          tabsByWorktree: input.tabsByWorktree,
          ptyIdsByTabId: input.ptyIdsByTabId,
          browserTabsByWorktree: input.browserTabsByWorktree,
          worktreeIdsWithLiveAgent: input.worktreeIdsWithLiveAgent,
          worktreeIdsWithStructuredChat: input.worktreeIdsWithStructuredChat,
          contestedWorktreeIds: input.contestedWorktreeIds
        },
        filterPredicate: input.filterPredicate
      }),
    [
      input.workspaces,
      input.alwaysShowDefaultBranchWorkspace,
      input.browserTabsByWorktree,
      input.contestedWorktreeIds,
      input.filterPredicate,
      input.hideAutomationGeneratedWorkspaces,
      input.hideCliCreatedWorkspaces,
      input.hideDefaultBranchWorkspace,
      input.hideDetachedHeadWorkspaces,
      input.hideWorkspacesFromOtherDevices,
      input.pairedDeviceIdsByEnvironment,
      input.ptyIdsByTabId,
      input.repoMap,
      input.hiddenProjects,
      input.defaultHostId,
      input.showSleepingWorkspaces,
      input.tabsByWorktree,
      input.worktreeIdsWithLiveAgent,
      input.worktreeIdsWithStructuredChat
    ]
  )
}
