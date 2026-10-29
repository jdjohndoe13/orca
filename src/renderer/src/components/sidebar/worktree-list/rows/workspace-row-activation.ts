import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

/**
 * Whether a sidebar row is the active workspace.
 *
 * `worktreeId` is `repoId::path` with no host component, so one bare id can name
 * a row on every paired host at once (STA-4343). A bare compare therefore lights
 * every claimant. The store stamps the active row's host, so match it too —
 * but only when the session names one, so single-host installs that never stamp
 * a host keep today's bare match.
 */
export function isWorkspaceRowActive(
  activeWorkspaceId: string | null,
  activeWorkspaceExecutionHostId: ExecutionHostId | null,
  worktree: Pick<Worktree, 'id' | 'hostId'>
): boolean {
  return (
    activeWorkspaceId === worktree.id &&
    (!activeWorkspaceExecutionHostId ||
      getWorktreeHostIdentity(worktree) ===
        composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, worktree.id))
  )
}
