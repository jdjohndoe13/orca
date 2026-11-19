import type { Repo } from '../../repository/repo-types'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import type { DetectedWorktreeListResult, Worktree } from '../types'
import { parseWorkspaceKey } from '../../workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../id'
import { getWorktreeHostIdentity } from '../host-qualified-identity'
import { getWorkspaceIdFromSessionKey } from '../../workspace-session-worktree-key'

type WorktreeValidityCatalog = {
  repos: readonly Pick<Repo, 'id'>[]
  // `hostId` is read so a contested row's host-qualified session key counts as valid; see
  // `buildValidWorktreeIdsForSessionHydration`.
  worktreesByRepo: Readonly<Record<string, readonly Pick<Worktree, 'id' | 'hostId'>[]>>
  detectedWorktreesByRepo?: Readonly<
    Record<string, Pick<DetectedWorktreeListResult, 'authoritative'> | undefined>
  >
}

export function collectPersistedWorktreeIdsForSessionHydration(
  session: WorkspaceSessionState
): Set<string> {
  const persistedWorktreeIds = new Set<string>()
  for (const worktreeId of Object.keys(session.tabsByWorktree)) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.unifiedTabs ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.openFilesByWorktree ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.browserTabsByWorktree ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  return persistedWorktreeIds
}

export function buildValidWorktreeIdsForSessionHydration(
  catalog: WorktreeValidityCatalog,
  persistedWorktreeIds: Iterable<string>
): Set<string> {
  const worktreesByRepo = catalog.worktreesByRepo
  const validWorktreeIds = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      validWorktreeIds.add(worktree.id)
      // A contested workspace id is published by more than one host, and the unified session keys
      // each claimant's row `host|id` (STA-4343). The validity check below compares session keys,
      // so the qualified spelling has to be in the set — otherwise every contested row is dropped
      // at hydration and the sidebar shows the other host's tabs instead of its own.
      validWorktreeIds.add(getWorktreeHostIdentity(worktree))
    }
  }
  const knownRepoIds = new Set(catalog.repos.map((repo) => repo.id))
  const detectedWorktreesByRepo = catalog.detectedWorktreesByRepo ?? {}
  const repoIdsWithLoadedWorktrees = new Set(
    Object.entries(worktreesByRepo)
      // Metadata fallbacks can omit host-less/scratch rows and cannot prove deletion (#1158). Explicitly non-authoritative listings disqualify a repo; no detection entry preserves legacy loaded status.
      .filter(
        ([repoId, worktrees]) =>
          worktrees.length > 0 && detectedWorktreesByRepo[repoId]?.authoritative !== false
      )
      .map(([repoId]) => repoId)
  )
  const repoIdsWithAuthoritativeDetectedWorktrees = new Set(
    Object.entries(detectedWorktreesByRepo)
      .filter(([, detected]) => detected?.authoritative)
      .map(([repoId]) => repoId)
  )

  for (const persistedKey of persistedWorktreeIds) {
    if (validWorktreeIds.has(persistedKey) || parseWorkspaceKey(persistedKey)?.type === 'folder') {
      continue
    }
    // Decode before splitting: a qualified key's repo segment is `host|repoId`, which would match
    // no repo and strand the row.
    const worktreeId = getWorkspaceIdFromSessionKey(persistedKey)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    // A failed scan cannot prove deletion; loaded rows or authoritative scans can (#1158).
    if (
      knownRepoIds.has(repoId) &&
      !repoIdsWithLoadedWorktrees.has(repoId) &&
      !repoIdsWithAuthoritativeDetectedWorktrees.has(repoId)
    ) {
      validWorktreeIds.add(persistedKey)
    }
  }

  return validWorktreeIds
}
