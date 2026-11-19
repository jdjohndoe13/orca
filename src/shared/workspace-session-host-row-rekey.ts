import type { ExecutionHostId } from './execution-host/execution-host'
import { isHostQualifiableWorkspaceId } from './workspace-session-key-qualification'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey,
  workspaceSessionKey,
  type ContestedWorkspaceIds
} from './workspace-session-worktree-key'

/**
 * The row-role algebra one host's snapshot applies to a worktree-keyed record, shared by the
 * direct-SSH snapshot apply and the `web-session-tabs-sync` mirror (STA-4343). Both reconcile a
 * host-published BARE id against a store that may spell the same workspace `host|id`; which
 * spelling is authoritative is the only difference between the two, so it is the direction.
 */
export type HostRowRekeyDirection = {
  /** Where the host's own row and the bare shared-bucket row land. */
  target: 'bare' | 'host'
  /**
   * Whether the host's own row or the bare row wins the shared bucket. The host's row wins while
   * the store is the reader (the bare view) and when the bare row is stale pollution the host's
   * live row replaces (the tombstone fold); the bare row wins once a merge has REBUILT it from
   * the host's live row, which makes the store's old `host|id` row the stale spelling.
   */
  hostRowWins: boolean
}

/** The store is the reader: the host's live row folds onto the bare key the host publishes. */
export const HOST_ROW_REKEY_TO_BARE: HostRowRekeyDirection = {
  target: 'bare',
  hostRowWins: true
}

/** The merge has rebuilt the bare row: re-spell it to the host's key, displacing the stale one. */
export const HOST_ROW_REKEY_TO_HOST_FRESH: HostRowRekeyDirection = {
  target: 'host',
  hostRowWins: false
}

/** The bare row is the stale/pre-contest spelling: the host's live row claims the host's key. */
export const HOST_ROW_REKEY_TO_HOST_CLAIM: HostRowRekeyDirection = {
  target: 'host',
  hostRowWins: true
}

/** The snapshot's ids that the gate has flagged and that can name more than one workspace. */
export function contestedIdsOwnedBy(
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
export type HostRowRole = 'keep' | 'loser' | 'winner'

export function hostRowRole(
  key: string,
  owned: Set<string>,
  hostId: ExecutionHostId,
  direction: HostRowRekeyDirection
): HostRowRole {
  const worktreeId = getWorkspaceIdFromSessionKey(key)
  if (!owned.has(worktreeId)) {
    return 'keep'
  }
  const rowHostId = getExecutionHostIdFromSessionKey(key)
  if (rowHostId === hostId) {
    return direction.hostRowWins ? 'winner' : 'loser'
  }
  if (rowHostId === null && key === worktreeId) {
    // The shared bucket: the pre-contest spelling of the SAME workspace. The empty-prefix bucket
    // (`|id`) is a row no host can prove — it falls through to `keep`, so neither direction ever
    // moves it.
    return direction.hostRowWins ? 'loser' : 'winner'
  }
  return 'keep'
}

/** Where one row goes, and what it is to this host's snapshot. */
export function rekeyRowForHost(
  key: string,
  owned: Set<string>,
  hostId: ExecutionHostId,
  direction: HostRowRekeyDirection
): { target: string; role: HostRowRole } {
  const role = hostRowRole(key, owned, hostId, direction)
  if (role === 'keep') {
    return { target: key, role }
  }
  const worktreeId = getWorkspaceIdFromSessionKey(key)
  return {
    target:
      direction.target === 'host' ? workspaceSessionKey(worktreeId, hostId, owned) : worktreeId,
    role
  }
}

/**
 * One record with this host's rows moved per the direction.
 *
 * The loser is placed before the winner so the two rows that end up in one bucket — the host's
 * live row and the shared bucket it displaces — resolve to the winner, the same convention the
 * contested collapse uses everywhere else.
 */
export function rekeyRecordForHostDirection<T>(
  record: Record<string, T>,
  owned: Set<string>,
  hostId: ExecutionHostId,
  direction: HostRowRekeyDirection
): Record<string, T> {
  const placed = new Map<string, T>()
  let changed = false
  const place = (key: string, target: string, entry: T): void => {
    changed = changed || target !== key || placed.has(target)
    placed.set(target, entry)
  }
  const pass = (role: HostRowRole): void => {
    for (const [key, entry] of Object.entries(record)) {
      const { target, role: keyRole } = rekeyRowForHost(key, owned, hostId, direction)
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
