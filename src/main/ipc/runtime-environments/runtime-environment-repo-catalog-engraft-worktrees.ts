/**
 * Mirrors the paired environment's detected worktree rows into host-qualified
 * worktree metadata stamped with the pair's runtime host id.
 */

import type { Store } from '../../persistence/loading-store/store'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getRepoExecutionHostId, type toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { runtimePathsEqual } from '../../runtime/workspaces/catalog/runtime-worktree-path-identity'
import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'
import {
  hostWorktreeTargetForRepo,
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost,
  removeWorktreeMetaRow
} from '../../persistence/host-qualified-worktree-meta'
import {
  PAIRED_REPO_CATALOG_TIMEOUT_MS,
  PairedWorktreeCatalogListSchema,
  warn,
  type EngraftRow
} from './runtime-environment-repo-catalog-mirror'

export type PairedMirrorWorktreesResult = { mirrored: number; pruned: number }

export async function mirrorPairedEnvironmentWorktrees(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  store: Store,
  hostId: ReturnType<typeof toRuntimeExecutionHostId>,
  rows: readonly EngraftRow[],
  touchedRepoIds: Set<string>
): Promise<PairedMirrorWorktreesResult> {
  let mirrored = 0
  let pruned = 0
  for (const row of rows) {
    // The meta key is `<repoId>::<path>`: only a store row that kept the source id
    // can host the source worktree metadata on this host.
    const owner = store
      .getRepos()
      .find(
        (candidate) =>
          candidate.id === row.id &&
          getRepoExecutionHostId(candidate) === hostId &&
          runtimePathsEqual(candidate.path, row.path)
      )
    if (!owner) {
      continue
    }
    let ownerMirrored = 0
    let ownerPruned = 0
    try {
      const detectedResponse = await callRuntimeEnvironment(
        userDataPath,
        environment.id,
        'worktree.detectedList',
        { repo: row.id },
        PAIRED_REPO_CATALOG_TIMEOUT_MS
      )
      if (!detectedResponse.ok) {
        warn(
          `paired environment ${environment.name} refused the worktree catalog of ${row.displayName}`,
          `${detectedResponse.error.code}: ${detectedResponse.error.message}`
        )
        continue
      }
      const detected = PairedWorktreeCatalogListSchema.safeParse(detectedResponse.result)
      if (!detected.success) {
        warn(
          `paired environment ${environment.name} returned an unreadable worktree catalog for ${row.displayName}`
        )
        continue
      }
      const freshWorktreePaths = new Set(
        detected.data.worktrees.map((entry) => normalizeRuntimePathForComparison(entry.path))
      )
      const now = Date.now()
      for (const entry of detected.data.worktrees) {
        // Scratch worktrees are agent-local churn that never belongs in a mirrored catalog.
        if (entry.ownership === 'agent-scratch') {
          continue
        }
        const worktreeId = `${owner.id}::${entry.path}`
        // Why: a worktree the source classified `orca-managed` reads only its metadata; without
        // the stamp this host re-classifies it and the visibility gate hides the restored row.
        // `orcaCreatedAt` alone never grants removal authority (that needs a creation source we
        // deliberately do not invent — the directory lives on the paired host, not here).
        const existingMeta = readWorktreeMetaForHost(store, worktreeId, hostId)
        // The owner row's host is exactly `hostId` (the find above proved it), so the
        // repo-derived target is the host-qualified write the mirror needs.
        store.setWorktreeMeta(
          hostWorktreeTargetForRepo(worktreeId, owner),
          entry.ownership === 'orca-managed'
            ? {
                ...(entry.displayName ? { displayName: entry.displayName } : {}),
                orcaCreatedAt: existingMeta?.orcaCreatedAt ?? now
              }
            : entry.displayName
              ? { displayName: entry.displayName }
              : {}
        )
        mirrored++
        ownerMirrored++
      }
      trackTouchedRepo(touchedRepoIds, owner.id, ownerMirrored > 0)
      // A missed scan must not look authoritative: keep the last good metas and
      // prune only when the source says the listing is the whole catalog.
      if (detected.data.authoritative) {
        for (const [worktreeId] of Object.entries(readAllWorktreeMetaForHost(store, hostId))) {
          const parsed = splitWorktreeId(worktreeId)
          if (!parsed || parsed.repoId !== owner.id) {
            continue
          }
          if (freshWorktreePaths.has(normalizeRuntimePathForComparison(parsed.worktreePath))) {
            continue
          }
          removeWorktreeMetaRow(store, worktreeId, hostId)
          pruned++
          ownerPruned++
        }
        trackTouchedRepo(touchedRepoIds, owner.id, ownerPruned > 0)
      }
    } catch (error) {
      // One repo's catalog trouble must not block the rest of the mirror.
      warn(`worktree catalog of ${row.displayName} did not mirror`, error)
    }
  }
  return { mirrored, pruned }
}

function trackTouchedRepo(touchedRepoIds: Set<string>, repoId: string, changed: boolean): void {
  if (changed) {
    touchedRepoIds.add(repoId)
  }
}
