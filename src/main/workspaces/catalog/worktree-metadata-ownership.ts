import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

/** Same repo/worktree ids can exist on several hosts; bare metadata cannot choose between them. */
export function getRepoOwnedWorktreeMeta(
  repo: Repo,
  worktreeId: string,
  metaById: Readonly<Record<string, WorktreeMeta>>,
  repoOwnerCount: number
): WorktreeMeta | undefined {
  const existingMeta = metaById[worktreeId]
  return isWorktreeMetaOwnedByRepo(repo, existingMeta, repoOwnerCount) ? existingMeta : undefined
}

export function isWorktreeMetaOwnedByRepo(
  repo: Repo,
  meta: WorktreeMeta | undefined,
  repoOwnerCount: number
): meta is WorktreeMeta {
  if (!meta) {
    return false
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  // Why: a host-stamped bare row names its own owner — `repoOwnerCount === 1` is stale evidence
  // (the co-claimant's repo row may not be registered here), so the row's own hostId wins.
  if (meta.hostId && meta.hostId !== expectedHostId) {
    return false
  }
  return repoOwnerCount === 1 || meta.hostId === expectedHostId
}
