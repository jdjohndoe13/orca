/**
 * Engraft half of the paired-environment repo catalog mirror — the wiring, wire
 * contract and retirement live in the `runtime-environment-repo-catalog-mirror`
 * and `runtime-environment-repo-catalog-retire` modules.
 */

import type { Store } from '../../persistence/loading-store/store'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isEphemeralVmRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { runtimePathsEqual } from '../../runtime/workspaces/catalog/runtime-worktree-path-identity'
import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'
import { mirrorPairedEnvironmentWorktrees } from './runtime-environment-repo-catalog-engraft-worktrees'
import {
  getPairedEnvironmentRepoCatalogMirrorDeps,
  invalidateRuntimeCatalog,
  PAIRED_REPO_CATALOG_TIMEOUT_MS,
  PairedRepoCatalogListSchema,
  warn,
  type EngraftRow,
  type PairedEnvironmentRepoCatalogEngraftSummary,
  type PairedEnvironmentRepoCatalogMirrorDeps
} from './runtime-environment-repo-catalog-mirror'

function noopEngraftSummary(): PairedEnvironmentRepoCatalogEngraftSummary {
  return {
    reposAdded: 0,
    reposUpdated: 0,
    reposPruned: 0,
    worktreesMirrored: 0,
    worktreesPruned: 0
  }
}

/**
 * Engrafts the environment's repo catalog into this host's store as rows stamped
 * with the environment's runtime host id. Rows carry the source repo's own id so
 * the desktop renderer's host-qualified merge (`hostId\0repoId`) collapses them
 * with its client-side catalog copy instead of listing the project twice.
 *
 * Never throws: a lost source machine is not evidence that stored rows went
 * stale, so nothing is pruned and the mirror retries on the next pairing sync.
 */
export async function engagePairedEnvironmentRepoCatalogMirror(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<PairedEnvironmentRepoCatalogEngraftSummary> {
  const mirrorDeps = getPairedEnvironmentRepoCatalogMirrorDeps()
  if (!mirrorDeps) {
    // Hosts that never load the IPC registry have no store to write.
    return noopEngraftSummary()
  }
  if (environment.gatewayEnvironmentId) {
    // Relay view rows dial through their gateway; what gets mirrored is the pair's
    // own catalog, so engraving a learned row under this stamp would duplicate it.
    return noopEngraftSummary()
  }
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    // Ephemeral machines are torn down with their VM; mirrored rows would outlive them.
    return noopEngraftSummary()
  }
  try {
    return await engraftPairedEnvironmentRepoCatalog(mirrorDeps, userDataPath, environment)
  } catch (error) {
    warn('repo catalog engraft failed', error)
    return noopEngraftSummary()
  }
}

async function engraftPairedEnvironmentRepoCatalog(
  deps: PairedEnvironmentRepoCatalogMirrorDeps,
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<PairedEnvironmentRepoCatalogEngraftSummary> {
  const hostId = toRuntimeExecutionHostId(environment.id)
  const store = deps.getStore()
  const catalogResponse = await callRuntimeEnvironment(
    userDataPath,
    environment.id,
    'repo.list',
    {},
    PAIRED_REPO_CATALOG_TIMEOUT_MS
  )
  if (!catalogResponse.ok) {
    warn(
      `paired environment ${environment.name} refused the repo catalog`,
      `${catalogResponse.error.code}: ${catalogResponse.error.message}`
    )
    return noopEngraftSummary()
  }
  const catalog = PairedRepoCatalogListSchema.safeParse(catalogResponse.result)
  if (!catalog.success) {
    warn(`paired environment ${environment.name} returned an unreadable repo catalog`)
    return noopEngraftSummary()
  }
  // Folder checked-out projects resolve their workspaces through the folder
  // workspace store, which the mirror does not own; a stamped row would surface
  // a project the phone can never open into.
  const rows = catalog.data.repos.filter((row) => row.kind !== 'folder')
  const freshIds = new Set(rows.map((row) => row.id))
  const freshPaths = new Set(rows.map((row) => normalizeRuntimePathForComparison(row.path)))
  const touchedRepoIds = new Set<string>()
  let reposAdded = 0
  let reposUpdated = 0
  for (const row of rows) {
    // Why re-read per row: one source catalog can carry a stale duplicate (same id
    // or same path twice), and a mirror write earlier in this loop must count.
    const existingRows = store.getRepos()
    const sameIdOnHost = existingRows.find(
      (candidate) => candidate.id === row.id && getRepoExecutionHostId(candidate) === hostId
    )
    if (sameIdOnHost && !runtimePathsEqual(sameIdOnHost.path, row.path)) {
      // The source id already names a different checkout on this host: writing it
      // would break per-host repo-id uniqueness. Leave both and skip.
      warn(`repo id ${row.id} collides on this host; skipped ${row.path}`)
      continue
    }
    const samePathOnHost = existingRows.find(
      (candidate) =>
        getRepoExecutionHostId(candidate) === hostId && runtimePathsEqual(candidate.path, row.path)
    )
    if (samePathOnHost) {
      if (samePathOnHost.id === row.id) {
        // The same mirror row re-synced: carry renamed projections over in place.
        if (samePathOnHost.displayName !== row.displayName) {
          // The row is this host's (the find above filtered on `hostId`); the
          // target-based signature keeps the fork's host-qualified write.
          store.updateRepo(samePathOnHost, { displayName: row.displayName })
          reposUpdated++
          touchedRepoIds.add(row.id)
        }
        continue
      }
      // A different row already registers this path on this host: it predates the
      // mirror and is not ours to replace or duplicate.
      continue
    }
    store.addRepo(mirrorRow(row, hostId))
    reposAdded++
    touchedRepoIds.add(row.id)
  }

  const worktrees = await mirrorPairedEnvironmentWorktrees(
    userDataPath,
    environment,
    store,
    hostId,
    rows,
    touchedRepoIds
  )
  const reposPruned = pruneStaleMirrorRows(store, hostId, freshIds, freshPaths, touchedRepoIds)
  const summary: PairedEnvironmentRepoCatalogEngraftSummary = {
    reposAdded,
    reposUpdated,
    reposPruned,
    worktreesMirrored: worktrees.mirrored,
    worktreesPruned: worktrees.pruned
  }
  if (
    summary.reposAdded > 0 ||
    summary.reposUpdated > 0 ||
    summary.reposPruned > 0 ||
    summary.worktreesMirrored > 0 ||
    summary.worktreesPruned > 0
  ) {
    invalidateRuntimeCatalog(deps, touchedRepoIds)
  }
  return summary
}

/** The mirrored row: the source row's fields with only the execution ownership replaced. */
function mirrorRow(row: EngraftRow, hostId: ReturnType<typeof toRuntimeExecutionHostId>): Repo {
  return {
    ...row,
    executionHostId: hostId,
    // Why: the runtime stamp owns execution here. A surviving source `connectionId` would
    // misroute worktree scans and phase-4 restore at this host's own SSH providers.
    connectionId: null
  }
}

/**
 * Repo rows this host mirrored that the fresh catalog no longer knows — dropped
 * by id, or renamed with a fresh id and a matching path. A failed catalog dial
 * never reaches here (the callee returns a noop summary), so pruning only runs
 * on a paired environment that listed every row it still owns.
 */
function pruneStaleMirrorRows(
  store: Store,
  hostId: ReturnType<typeof toRuntimeExecutionHostId>,
  freshIds: Set<string>,
  freshPaths: Set<string>,
  touchedRepoIds: Set<string>
): number {
  const currentRows = store.getRepos()
  let pruned = 0
  for (const row of currentRows) {
    if (getRepoExecutionHostId(row) !== hostId) {
      continue
    }
    if (freshIds.has(row.id) || freshPaths.has(normalizeRuntimePathForComparison(row.path))) {
      continue
    }
    // The row is this host's (the loop above filtered on `hostId`); the target
    // keeps the fork's host-qualified removal.
    store.removeProjectForHost(row)
    touchedRepoIds.add(row.id)
    pruned++
  }
  return pruned
}
