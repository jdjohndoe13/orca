import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { canonicalizeWorktreeId } from '../../../../../../shared/worktree/id'
import type { AppState } from '../../../types'

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreesById: Map<string, Worktree[]>
  /** Canonical id → the byte-faithful key the output maps use for that id's group. */
  firstRowKeyByCanonicalId: Map<string, string>
  contestedIds: ReadonlySet<string>
}

/** A row plus its id as stored, captured on the one getter read the row is allowed. */
type IndexedWorktreeRow = { worktree: Worktree; rawId: string }

/** Stand-in for a catalog that is absent, which is the same answer as one with no collision. */
const EMPTY_CONTESTED_IDS: ReadonlySet<string> = new Set<string>()

// Why: Zustand reruns selectors on every write, so identity projections need
// cross-render caching without pinning replaced store snapshots in memory.
const worktreeSnapshotCache = new WeakMap<AppState['worktreesByRepo'], WorktreeSnapshot>()

function getWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
  const cachedSnapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  // Why: a race between createWorktree (which appends) and fetchWorktrees
  // (which replaces) can produce duplicate entries within one repo array. That
  // duplicate is the SAME workspace twice, so it collapses — but the key has to
  // include the host (STA-4343). `worktreeId` is `repoId::path` with no host
  // component, so the local host and an SSH host can publish the same id for
  // two genuinely different workspaces, and collapsing those hides one of them
  // from the sidebar entirely. Last wins within a host: fetchWorktrees replaces,
  // so the later entry is the current one.
  // Why canonicalize the DEDUP key: the same Windows checkout reaches the client through two
  // separator spellings (`C:/vmd` from the host's git scan, `C:\vmd` from a persisted
  // `repo.path` join). Keyed byte-exactly, the two spellings never dedupe — neither on one host
  // nor across hosts — so the contested gate never fires, every session key stays bare, and one
  // workspace's rows split across two buckets. Canonicalizing the dedup key covers both the
  // same-host dedup and the cross-host gate below.
  // Why NOT the OUTPUT keys: folder-workspace rows are byte-faithful by contract — the host
  // byte-compares a folder id against `repoId::repo.path` (`assertFolderWorkspacePtyPathUsable`),
  // and the workbench matches its mount set against `activeWorktreeId`/`mountedWorktreeIdsRef`,
  // which hold the raw id. Re-spelling the output keys made the surface id differ from the
  // active id, so the surface never mounted and no `pty:spawn` was ever issued (fold at
  // comparison, never at construction — `workspace-session-worktree-key`). Every output map is
  // therefore keyed by the ROW's own id; the query helpers fold the query through
  // `firstRowKeyByCanonicalId` so a caller holding either spelling finds the row.
  const byHostAndId = new Map<string, IndexedWorktreeRow>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      // Read `worktree.id` exactly once per row: it is a getter on some snapshots and retained
      // selectors assert the read count. Everything downstream uses `rawId`.
      const rawId = worktree.id
      byHostAndId.set(composeWorktreeHostIdentity(worktree.hostId, canonicalizeWorktreeId(rawId)), {
        worktree,
        rawId
      })
    }
  }
  const allWorktrees: Worktree[] = []
  const worktreeMap = new Map<string, Worktree>()
  const worktreesById = new Map<string, Worktree[]>()
  const firstRowKeyByCanonicalId = new Map<string, string>()
  const contestedIds = new Set<string>()
  for (const [identity, row] of byHostAndId) {
    const canonicalId = getWorktreeIdFromHostIdentity(identity)
    allWorktrees.push(row.worktree)
    const firstRowKey = firstRowKeyByCanonicalId.get(canonicalId)
    if (firstRowKey === undefined) {
      // FIRST wins across hosts, matching `buildWorktreeByIdIndex` and the `.find()`
      // both replaced. Freshness is not the question here: the same-host duplicate
      // was already collapsed above, so what is left is a genuine two-host collision
      // that no bare-id lookup can resolve. The group is keyed by the first row's own
      // byte-faithful id — the spelling the host byte-compares and the workbench mounts.
      firstRowKeyByCanonicalId.set(canonicalId, row.rawId)
      worktreeMap.set(row.rawId, row.worktree)
      worktreesById.set(row.rawId, [row.worktree])
      continue
    }
    // Two rows for one canonical id after the same-host dedup above means two hosts publish
    // the same workspace id. That is the only condition under which a session record may key
    // on `host|id` (see `workspace-session-worktree-key`); everything else keeps the bare key.
    // The gate holds the canonical id; `hasContestedClaim` folds both sides, so a caller
    // holding either spelling hits it.
    contestedIds.add(canonicalId)
    worktreesById.get(firstRowKey)!.push(row.worktree)
  }
  const snapshot = {
    allWorktrees,
    worktreeMap,
    worktreesById,
    firstRowKeyByCanonicalId,
    contestedIds
  }
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  return snapshot
}

export function getIndexedAllWorktrees(worktreesByRepo: AppState['worktreesByRepo']): Worktree[] {
  return getWorktreeSnapshot(worktreesByRepo).allWorktrees
}

/**
 * One row per id — a LEGACY convenience for the many id-only lookups.
 *
 * Keyed by the ROW's own byte-faithful id (the first host's row for a two-host id), so the
 * workbench's mount set and the host's byte-exact folder comparisons line up with it. The
 * same-host two-spelling dedup leaves the later row's spelling as the group's key.
 *
 * It cannot represent a collision, so it is not evidence of ownership: a
 * destructive path must take an explicit host (see `WorktreeRemovalTarget`) and
 * use `getIndexedWorktreesById` when it needs to see every owner.
 */
export function getIndexedWorktreeMap(
  worktreesByRepo: AppState['worktreesByRepo']
): Map<string, Worktree> {
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap
}

/**
 * Every host's row for one id, in `worktreesByRepo` order.
 *
 * The query is canonicalized and resolved through the canonical→first-row-key map so a caller
 * holding either Windows separator spelling finds the row — the map is keyed byte-faithfully,
 * the fold happens at comparison, never at construction. Canonicalization is idempotent and cheap.
 */
export function getIndexedWorktreesById(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): Worktree[] {
  const snapshot = getWorktreeSnapshot(worktreesByRepo)
  const firstRowKey = snapshot.firstRowKeyByCanonicalId.get(canonicalizeWorktreeId(worktreeId))
  return firstRowKey === undefined ? [] : snapshot.worktreesById.get(firstRowKey)!
}

/**
 * The bare worktree ids more than one execution host publishes right now.
 *
 * This is the whole gate for host-qualified session keys: an id outside this set keeps the exact
 * bare key it has always had, so the store, the persisted partitions, and the paired-host wire are
 * unchanged for every install without a collision. Only these ids may hold one bucket per host.
 */
export function getContestedWorktreeIds(
  worktreesByRepo: AppState['worktreesByRepo'] | undefined
): ReadonlySet<string> {
  // Why the guard: slice-level tests build partial stores without a catalog, and an absent
  // catalog is the faithful stand-in for "no collision observed" — the same empty set an
  // install with no collision has, so every key stays bare exactly as before.
  if (!worktreesByRepo) {
    return EMPTY_CONTESTED_IDS
  }
  return getWorktreeSnapshot(worktreesByRepo).contestedIds
}

export function getIndexedWorktreeById(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): Worktree | undefined {
  const snapshot = getWorktreeSnapshot(worktreesByRepo)
  const firstRowKey = snapshot.firstRowKeyByCanonicalId.get(canonicalizeWorktreeId(worktreeId))
  return firstRowKey === undefined ? undefined : snapshot.worktreeMap.get(firstRowKey)
}

const hasAnyWorktreesCache = new WeakMap<AppState['worktreesByRepo'], boolean>()

export function getCachedHasAnyWorktrees(worktreesByRepo: AppState['worktreesByRepo']): boolean {
  const cached = hasAnyWorktreesCache.get(worktreesByRepo)
  if (cached !== undefined) {
    return cached
  }

  // Cache always-mounted scanner lookup by slice identity to avoid global rescans on unrelated writes.
  const hasWorktrees = Object.values(worktreesByRepo).some((worktrees) => worktrees.length > 0)
  hasAnyWorktreesCache.set(worktreesByRepo, hasWorktrees)
  return hasWorktrees
}
