import type { ExecutionHostId } from './execution-host/execution-host'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from './execution-host/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace/identity/workspace-scope'
import type { WorkspaceSessionState } from './workspace-session/workspace-session-state-types'
import {
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from './workspace-session/workspace-session-host-records'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey,
  WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS,
  workspaceSessionKey,
  type ContestedWorkspaceIds
} from './workspace-session-worktree-key'

/**
 * The pass that gives a contested workspace id its per-host spelling inside a session slice.
 *
 * Persistence holds one partition per execution host, so a partition's own id IS the host its rows
 * belong to — which is why re-qualifying needs no repo catalog and cannot disagree with it. The
 * read runs it once, on the slices it hands to the merge, so the unified session holds one row per
 * claimant of a contested id instead of one row every claimant shares.
 *
 * The disk never sees these keys: `splitWorkspaceSessionByHost` routes a qualified key by its
 * prefix and strips it back off, so every partition keeps the bare `repoId::path` spelling it has
 * always had.
 */

/**
 * The one worktree-keyed field whose key already carries a host by its OWN convention:
 * `worktree-visit-recency.ts` writes `${host}|${id}` today and `getWorktreeVisitTimestamp` reads
 * either spelling, so its rows are already separated per host. Qualifying its bare legacy keys
 * would move bytes on disk no reader needs moved, so this field keeps its own rule.
 */
const SELF_QUALIFIED_SESSION_FIELDS: readonly (keyof WorkspaceSessionState)[] = [
  'lastVisitedAtByWorktreeId'
]

/** The worktree-keyed rows this pass re-keys: the 14 fields minus the one with its own rule. */
const QUALIFIABLE_SESSION_FIELDS = WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS.filter(
  (field) => !SELF_QUALIFIED_SESSION_FIELDS.includes(field)
)

/**
 * The fields the runtime-owner map is built from. `clientHostedBrowserPagesByWorktree` is excluded:
 * it is runtime-authored and no reader of that map acts on it, so naming an owner from it would
 * mint catalog placeholders the boot never asked for.
 */
const OWNER_MAP_SESSION_FIELDS = WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS.filter(
  (field) => field !== 'clientHostedBrowserPagesByWorktree'
)

/**
 * Whether a workspace id can name more than one workspace, which is what makes a contest worth
 * separating by host.
 *
 * `repoId::path` is host-blind by construction — that is STA-4343. A `folder:<uuid>` key is NOT:
 * the uuid is minted per workspace, so the same key in two partitions is one workspace written
 * twice (#12723), which the stranded-partition repair deliberately reunites. Qualifying it would
 * split that one workspace into two rival buckets and re-break the repair, so a folder key is never
 * a contest and stays on the parking path that already protects it.
 */
export function isHostQualifiableWorkspaceId(workspaceId: string): boolean {
  return workspaceId.includes('::')
}

/**
 * The partition a key's row belongs to: the host its own prefix names, else the catalog's opinion
 * for the bare id behind it. The prefix wins so a transient disagreement between the two contested
 * sets (the boot read's partition-derived set vs. the live catalog's) can never route a row to a
 * partition that loses it — the split follows the key, not the catalog's current guess.
 */
export function splitHostForSessionKey(
  key: string,
  hostIdByWorktreeId: (worktreeId: string) => ExecutionHostId
): ExecutionHostId {
  return (
    getExecutionHostIdFromSessionKey(key) ?? hostIdByWorktreeId(getWorkspaceIdFromSessionKey(key))
  )
}

/**
 * Re-key one partition's worktree-keyed rows for the contested ids, as that host's rows.
 *
 * Returns the same reference when nothing moves, so a read with no collision — the overwhelming
 * majority — allocates nothing and every downstream identity check still holds.
 */
export function qualifyHostWorkspaceSessionSlice(
  slice: WorkspaceSessionState,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): WorkspaceSessionState {
  if (contested.size === 0) {
    return slice
  }
  let next: WorkspaceSessionRecord | undefined
  for (const field of QUALIFIABLE_SESSION_FIELDS) {
    const record = slice[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    let rekeyed: WorkspaceSessionRecord | undefined
    for (const [key, entry] of Object.entries(record)) {
      const worktreeId = getWorkspaceIdFromSessionKey(key)
      if (!isHostQualifiableWorkspaceId(worktreeId)) {
        continue
      }
      const target = workspaceSessionKey(worktreeId, hostId, contested)
      if (target === key) {
        continue
      }
      rekeyed ??= { ...record }
      delete rekeyed[key]
      rekeyed[target] = entry
    }
    if (!rekeyed) {
      continue
    }
    next ??= { ...slice }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the same ownership table that classifies it as a record.
    ;(next as WorkspaceSessionRecord)[field] = rekeyed
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every written field is a copy of the slice's own value, so the shape is unchanged.
  return (next ?? slice) as WorkspaceSessionState
}

/**
 * Re-key every partition of a slice map by its own host.
 *
 * Idempotent: an already-qualified key decodes to the same id and re-composes to the same key, so
 * the merge still holds when it is handed slices the contention split already qualified.
 */
export function qualifyHostWorkspaceSessionSlices<
  T extends Partial<Record<ExecutionHostId, WorkspaceSessionState | null | undefined>>
>(slices: T, contested: ContestedWorkspaceIds): T {
  if (contested.size === 0) {
    return slices
  }
  let next: Record<string, WorkspaceSessionState | null | undefined> | undefined
  for (const [rawHostId, slice] of Object.entries(slices)) {
    // Read the partition key through the checked host parser instead of asserting the map's key
    // type: a partition written under a malformed host id is one no slice can belong to, so
    // skipping it is the honest answer, not a lossy one.
    const hostId = normalizeExecutionHostId(rawHostId)
    if (!hostId || !slice) {
      continue
    }
    const qualified = qualifyHostWorkspaceSessionSlice(slice, hostId, contested)
    if (qualified === slice) {
      continue
    }
    // The copy holds the map's own value shape (`null` holes included); the caller-facing cast
    // below is the one that restores `T`.
    next ??= { ...slices }
    next[hostId] = qualified
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy keeps the map's own host keys and only replaces a slice with a re-keyed copy of itself.
  return (next as T | undefined) ?? slices
}

/**
 * The runtime owner per workspace session key, for building catalog placeholders before the remote
 * catalogs land.
 *
 * A contested id names no host at all: its rows live on more than one, and every reader of this map
 * is keyed by the bare id — `buildRuntimeSessionPlaceholders` would mint a placeholder for the
 * wrong host, and `collectWorktreeHydrationRepoIdsFromSession` would stop fetching the repo the
 * OTHER claimant's catalog needs. Both get a worse answer from a partial one, so a contested id is
 * left unnamed.
 */
export function buildRuntimeHostIdByWorkspaceSessionKey(
  slices: Partial<Record<ExecutionHostId, WorkspaceSessionState | undefined>>,
  contested: ContestedWorkspaceIds
): Record<string, ExecutionHostId> {
  const owners: Record<string, ExecutionHostId> = {}
  const ambiguous = new Set<string>()
  for (const [rawHostId, slice] of Object.entries(slices)) {
    // Same rule as the qualifier: a partition keyed by a string that names no host is skipped
    // rather than asserted into one; its rows would name a host no reader can route to.
    const hostId = normalizeExecutionHostId(rawHostId)
    if (!slice || !hostId || hostId === LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    for (const key of workspaceSessionKeysNamedByHostPartition(slice)) {
      const worktreeId = normalizeWorkspaceSessionKeyToWorkspaceId(key)
      if (contested.has(worktreeId)) {
        continue
      }
      if (owners[worktreeId] && owners[worktreeId] !== hostId) {
        ambiguous.add(worktreeId)
        delete owners[worktreeId]
      } else if (!ambiguous.has(worktreeId)) {
        owners[worktreeId] = hostId
      }
    }
  }
  return owners
}

/**
 * Every session key one partition names — the fields the unified session's owner map is built from.
 *
 * Deliberately not `workspaceIdsNamedByPartition`: that one folds a qualified key onto its bare id,
 * which is right for a caller asking "does this partition name the workspace" and wrong for one
 * that has to name the row a reader reads.
 */
export function workspaceSessionKeysNamedByHostPartition(
  slice: WorkspaceSessionState
): Set<string> {
  const keys = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      keys.add(value)
    }
  }
  for (const field of OWNER_MAP_SESSION_FIELDS) {
    const record = slice[field]
    if (isWorkspaceSessionRecord(record)) {
      for (const key of Object.keys(record)) {
        add(key)
      }
    }
  }
  for (const worktreeId of slice.activeWorktreeIdsOnShutdown ?? []) {
    add(worktreeId)
  }
  for (const pages of Object.values(slice.browserPagesByWorkspace ?? {})) {
    if (Array.isArray(pages)) {
      for (const page of pages) {
        add(page.worktreeId)
      }
    }
  }
  for (const record of Object.values(slice.sleepingAgentSessionsByPaneKey ?? {})) {
    // Why: a hibernated agent can be the only restored session evidence for a runtime worktree
    // before its remote catalog answers.
    add(record.worktreeId)
  }
  return keys
}
