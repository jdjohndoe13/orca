import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  hasContestedClaim,
  type ContestedWorkspaceIds
} from '../../../../../../shared/workspace-session-worktree-key'
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
 *
 * A contested id whose stamp is null (the activation could not name a host and
 * the catalog could not prove one) matches NO row: a bare match would light every
 * claimant at once, which is the bug the stamp tries to avoid and this guard
 * refuses to render.
 */
export function isWorkspaceRowActive(
  activeWorkspaceId: string | null,
  activeWorkspaceExecutionHostId: ExecutionHostId | null,
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  contestedWorktreeIds?: ContestedWorkspaceIds
): boolean {
  if (activeWorkspaceId !== worktree.id) {
    return false
  }
  if (activeWorkspaceExecutionHostId) {
    return (
      getWorktreeHostIdentity(worktree) ===
      composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, worktree.id)
    )
  }
  return !hasContestedClaim(contestedWorktreeIds, worktree.id)
}
