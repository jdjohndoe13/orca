import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'
import { isHostQualifiableWorkspaceId } from '../../../shared/workspace-session-key-qualification'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey,
  workspaceSessionKey,
  type ContestedWorkspaceIds
} from '../../../shared/workspace-session-worktree-key'
import { getContestedWorktreeIds } from '../store/worktree-repo-index'
import type { AppState } from '../store/types'

/**
 * Where a direct-SSH snapshot's rows belong in the unified session.
 *
 * The host publishes worktree ids with no host component, so `importRemoteWorkspaceSession` lands
 * them under the bare id — and once the contested gate fires (one repo id on several execution
 * hosts, STA-4343) the surface reads that workspace at `host|id`, so the row the apply just wrote
 * is a miss and the workbench paints black.
 *
 * The apply is the one place that can name the owner: the catalog is deliberately ambiguous about a
 * contested id, and the apply already knows the authority it is applying for. So the merge runs in
 * the bare spelling the host publishes — which is what lets it see the target host's live rows and
 * keep a tab the user opened there — and the merged rows are re-spelled to the session key on the
 * way into the store.
 *
 * An id the gate has not flagged is its own key in both directions, so every install without a
 * collision runs this path byte-identically to before.
 */

/** The worktree-keyed rows the import writes under the bare id, so the only ones to re-spell. */
const REMOTE_SNAPSHOT_RECORD_FIELDS = [
  'tabsByWorktree',
  'activeTabIdByWorktree',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** The array the import emits under the bare id, and the reconnect plan reads by it. */
const REMOTE_SNAPSHOT_ARRAY_FIELDS = [
  'activeWorktreeIdsOnShutdown'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/**
 * The keys one apply replaces: every target workspace's session key plus the bare id.
 *
 * The bare id is in the set because the qualified key displaces it — a row left behind in the
 * shared bucket is one no reader resolves, and the persistence split would route it to whichever
 * host the catalog happens to name. An uncontested id is its own key, so the set is exactly the
 * target ids there.
 */
export function remoteWorkspaceSessionReplaceKeys(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId
): string[] {
  const contested = getContestedWorktreeIds(state.worktreesByRepo)
  const keys = new Set<string>()
  for (const worktreeId of worktreeIds) {
    keys.add(worktreeId)
    keys.add(workspaceSessionKey(worktreeId, hostId, contested))
  }
  return [...keys]
}

/**
 * The live rows the merge must read as bare.
 *
 * Why: the merge is bare-id keyed end to end (it is the shape the host publishes) and it decides
 * what survives a wholesale replace from the live rows it finds by that id. With the target's rows
 * under `host|id` it finds none of them, so a tab the user opened on the reconnecting host reads
 * as host-unknown and the replace deletes a live pane.
 */
export function bareWorkspaceRowsForHost(
  rows: AppState['tabsByWorktree'],
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): AppState['tabsByWorktree'] {
  const owned = contestedIdsOwnedBy(worktreeIds, contested)
  if (owned.size === 0) {
    return rows
  }
  return rekeyRecordForHost(rows, owned, hostId, false)
}

/**
 * The live session the merge must read as bare.
 *
 * The payload is built from the store, so a contested target's rows arrive under `host|id`. The
 * merge's `omitTargetWorktrees` only strips the bare spelling, so a qualified row would sail
 * through the wholesale replace as a second bucket for the same workspace — and the merge's
 * live-row reads would miss it, deleting a tab the user opened on the reconnecting host.
 */
export function bareWorkspaceSessionForHost(
  session: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): WorkspaceSessionState {
  return rekeyRemoteSessionRowsForHost(session, worktreeIds, hostId, contested, false)
}

/**
 * The merged session with the target host's rows re-spelled to the session key the reader resolves.
 *
 * Only the ids this snapshot owns move: the co-claimant's rows are the catalog's business (the
 * contest flip in `workspace-session-contest-rekey.ts` moves them), and a host guessed for a row
 * the apply cannot name is exactly what puts one host's tabs in another's workbench.
 */
export function rekeyRemoteSessionToHostRows(
  session: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): WorkspaceSessionState {
  return rekeyRemoteSessionRowsForHost(session, worktreeIds, hostId, contested, true)
}

function rekeyRemoteSessionRowsForHost(
  session: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds,
  toHost: boolean
): WorkspaceSessionState {
  const owned = contestedIdsOwnedBy(worktreeIds, contested)
  if (owned.size === 0) {
    return session
  }
  let next: WorkspaceSessionState | undefined
  const assign = (field: keyof WorkspaceSessionState, value: unknown): void => {
    next ??= { ...session }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the two lists below, which classify it as a worktree-keyed record or array, and the value is that field's own content with its keys re-spelled.
    ;(next as Record<string, unknown>)[field] = value
  }
  for (const field of REMOTE_SNAPSHOT_RECORD_FIELDS) {
    const record = session[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    // The field's own value type is a union across the three records, so the rekey runs on the
    // record-typed view; `assign` is what puts the field's own value back.
    const rekeyed = rekeyRecordForHost<unknown>(record, owned, hostId, toHost)
    if (rekeyed !== record) {
      assign(field, rekeyed)
    }
  }
  for (const field of REMOTE_SNAPSHOT_ARRAY_FIELDS) {
    const ids = session[field]
    if (!Array.isArray(ids)) {
      continue
    }
    // The loser/winner fold can land two spellings of one workspace on one key, so the array
    // dedupes — the reconnect plan would otherwise walk the same workspace twice.
    const rekeyed = [
      ...new Set(
        ids.map((id) =>
          typeof id === 'string' ? rekeyRowForHost(id, owned, hostId, toHost).target : id
        )
      )
    ]
    if (rekeyed.length !== ids.length || !rekeyed.every((id, index) => id === ids[index])) {
      assign(field, rekeyed)
    }
  }
  return next ?? session
}

/** The snapshot's ids that the gate has flagged and that can name more than one workspace. */
function contestedIdsOwnedBy(
  worktreeIds: ReadonlySet<string>,
  contested: ContestedWorkspaceIds
): Set<string> {
  return new Set(
    [...contested].filter((id) => worktreeIds.has(id) && isHostQualifiableWorkspaceId(id))
  )
}

/**
 * What one row is to this host's snapshot: `keep` (not the host's to move — a co-claimant's row,
 * the canonical empty-prefix bucket no host can prove, or an id the apply does not own), `loser`
 * (the stale spelling the live row replaces), or `winner` (the row that survives the fold).
 */
type RowRole = 'keep' | 'loser' | 'winner'

function rowRole(
  key: string,
  owned: Set<string>,
  hostId: ExecutionHostId,
  toHost: boolean
): RowRole {
  const worktreeId = getWorkspaceIdFromSessionKey(key)
  if (!owned.has(worktreeId)) {
    return 'keep'
  }
  const rowHostId = getExecutionHostIdFromSessionKey(key)
  if (rowHostId === hostId) {
    // The host's own row is the live one while the store is the reader (folding to bare); once the
    // merge has built the bare row it is the stale spelling the merged result replaces.
    return toHost ? 'loser' : 'winner'
  }
  if (rowHostId === null && key === worktreeId) {
    // The shared bucket: the pre-contest spelling of the SAME workspace, which the host's live row
    // replaces. The empty-prefix bucket (`|id`) is a row no host can prove — it falls through to
    // `keep`, so neither direction ever moves it.
    return toHost ? 'winner' : 'loser'
  }
  return 'keep'
}

/** Where one row goes, and what it is to this host's snapshot. */
function rekeyRowForHost(
  key: string,
  owned: Set<string>,
  hostId: ExecutionHostId,
  toHost: boolean
): { target: string; role: RowRole } {
  const role = rowRole(key, owned, hostId, toHost)
  if (role === 'keep') {
    return { target: key, role }
  }
  const worktreeId = getWorkspaceIdFromSessionKey(key)
  return {
    target: toHost ? workspaceSessionKey(worktreeId, hostId, owned) : worktreeId,
    role
  }
}

/**
 * One record with this host's rows moved between the bare and the qualified spelling.
 *
 * The loser is placed before the winner so the two rows that end up in one bucket — the host's
 * live row and the shared bucket it displaced — resolve to the winner, the same convention the
 * contested collapse uses everywhere else.
 */
function rekeyRecordForHost<T>(
  record: Record<string, T>,
  owned: Set<string>,
  hostId: ExecutionHostId,
  toHost: boolean
): Record<string, T> {
  const placed = new Map<string, T>()
  let changed = false
  const place = (key: string, target: string, entry: T): void => {
    changed = changed || target !== key || placed.has(target)
    placed.set(target, entry)
  }
  const pass = (role: RowRole): void => {
    for (const [key, entry] of Object.entries(record)) {
      const { target, role: keyRole } = rekeyRowForHost(key, owned, hostId, toHost)
      if (keyRole === role) {
        place(key, target, entry)
      }
    }
  }
  // `keep` rows first: they never collide with the winner's target (the co-claimant's key and the
  // empty-prefix bucket are neither the bare nor this host's spelling), so their order is moot.
  pass('keep')
  pass('loser')
  pass('winner')
  return changed ? Object.fromEntries(placed) : record
}
