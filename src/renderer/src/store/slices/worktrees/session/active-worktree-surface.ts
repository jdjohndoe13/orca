import type { AppState } from '../../../types'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { ActiveSurfaceSourceState } from '../../tabs/tabs-surface'
import { deriveActiveSurfaceForWorktree } from '../../tabs/tabs-surface'

export function resolveActivatedWorktreeSurface(
  s: ActiveSurfaceSourceState & Pick<AppState, 'rightSidebarExplorerViewByWorktree'>,
  worktreeId: string,
  preferredActiveUnifiedTabId: string | undefined,
  reconciledActiveTabId: string | null,
  /**
   * Where this workspace's rows live. The activation caller knows the host it is activating
   * FOR, so it resolves the key rather than having it re-derived here.
   */
  rowKey?: string
): {
  restoredRightSidebarExplorerView: NonNullable<
    AppState['rightSidebarExplorerViewByWorktree']
  >[string]
  activeFileId: string | null
  activeBrowserTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
} {
  return {
    restoredRightSidebarExplorerView: s.rightSidebarExplorerViewByWorktree?.[worktreeId] ?? 'files',
    ...deriveActiveSurfaceForWorktree(s, worktreeId, undefined, {
      legacySelection: 'remembered-type',
      preferredTabId: preferredActiveUnifiedTabId ?? reconciledActiveTabId ?? undefined,
      rowKey
    })
  }
}
