/**
 * Retires the repo catalog rows a weathered-out paired environment mirrored
 * here: drops only rows stamped with the removed environment's runtime host id.
 */

import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import {
  getPairedEnvironmentRepoCatalogMirrorDeps,
  invalidateRuntimeCatalog,
  type PairedEnvironmentRepoCatalogRetireSummary,
  warn
} from './runtime-environment-repo-catalog-mirror'

/** Drops the rows this host mirrored from a removed environment. Never throws. */
export async function retirePairedEnvironmentRepoCatalog(
  environmentId: string
): Promise<PairedEnvironmentRepoCatalogRetireSummary> {
  const deps = getPairedEnvironmentRepoCatalogMirrorDeps()
  if (!deps) {
    return { reposRemoved: 0 }
  }
  try {
    const store = deps.getStore()
    const hostId = toRuntimeExecutionHostId(environmentId)
    const removed = store.getRepos().filter((row) => getRepoExecutionHostId(row) === hostId)
    if (removed.length === 0) {
      return { reposRemoved: 0 }
    }
    const touchedRepoIds = new Set<string>()
    for (const row of removed) {
      // Removes the exact host-stamped row (never a co-hosted row of another host)
      // and prunes the worktree metas, lineage and tab selections that hang off it.
      // `row` carries the host stamp the filter above matched on.
      store.removeProjectForHost(row)
      touchedRepoIds.add(row.id)
    }
    invalidateRuntimeCatalog(deps, touchedRepoIds)
    return { reposRemoved: removed.length }
  } catch (error) {
    warn(`retire mirror of removed environment ${environmentId} failed`, error)
    return { reposRemoved: 0 }
  }
}
