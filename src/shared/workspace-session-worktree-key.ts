import type { ExecutionHostId } from './execution-host/execution-host'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from './worktree/host-qualified-identity'
import { canonicalizeWorktreeId, swapWorktreeIdPathSpelling } from './worktree/id'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session/workspace-session-host-field-ownership'
import {
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from './workspace-session/workspace-session-host-records'
import type { WorkspaceSessionState } from './workspace-session/workspace-session-state-types'

/**
 * The session key for one workspace, and the one place that decides when it names a host.
 *
 * A worktree id is `repoId::path` with no host component, so one repo registered on several
 * execution hosts publishes the SAME id for several different workspaces (STA-4343). The unified
 * renderer session keyed everything by that bare id, so every claimant shared one bucket and all of
 * them displayed the primary host's tabs — the "Known gap" documented in
 * `src/renderer/src/lib/workspace-session-host-contention.ts`.
 *
 * Qualifying ONLY the contested ids is what makes closing that gap cheap: an id claimed by one host
 * keeps the exact key it has always had, so the store shape, the on-disk partitions, and the
 * paired-host wire are unchanged for every install without a collision — the overwhelming majority.
 * Only ids that genuinely name more than one workspace grow a host prefix, and those are exactly the
 * ids the persistence layer already treats specially.
 *
 * `lastVisitedAtByWorktreeId` is the precedent: `assignVisitRecencyByHost` already routes a
 * qualified key by its prefix, and `worktree-visit-recency.ts` already writes `${host}|${id}`.
 */

/** The bare worktree ids that more than one execution host claims right now. */
export type ContestedWorkspaceIds = ReadonlySet<string>

/** Every `worktreeKeyed` session field, derived from the ownership table so the two cannot drift. */
export const WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed')

/**
 * The key one workspace's row lives under.
 *
 * Every claimant of a contested id is qualified, including the primary: leaving the primary on the
 * bare key would let a reader fall back to it whenever another host's row is missing, which is
 * exactly how a non-primary card ends up painting the primary's tabs. One spelling per state means
 * no fallback to get wrong.
 *
 * An id outside `contested` keeps the bare key — that is the whole point. Callers must not qualify
 * eagerly "to be safe": doing so would change the shape of every install for no benefit.
 *
 * An already-qualified key passes through unchanged, so a legacy id that happens to contain `|`
 * is never turned into `host|host|id`.
 *
 * The id is NOT canonicalized here: the host compares the worktree id byte-exactly against the
 * row it published (`stable-owner` reads `tabsByWorktree[worktreeId]` and matches the tab's
 * `worktreeId`), so the key must equal the catalog row's id verbatim. The two Windows separator
 * spellings of one checkout are reconciled at LOAD onto the canonical spelling, and the read
 * candidates (`workspaceSessionKeyCandidates`) additionally accept the other spelling while a
 * pre-reconciliation row is still on disk.
 */
export function workspaceSessionKey(
  worktreeId: string,
  hostId: ExecutionHostId | null | undefined,
  contested: ContestedWorkspaceIds | undefined
): string {
  if (isWorktreeHostIdentity(worktreeId) || !hasContestedClaim(contested, worktreeId)) {
    return worktreeId
  }
  // An unknown host on a contested id gets the canonical empty-prefix bucket, matching
  // `composeWorktreeHostIdentity`'s rule that an unqualified row is its own bucket rather than
  // being folded into a host it cannot prove.
  return composeWorktreeHostIdentity(hostId ?? undefined, worktreeId)
}

/**
 * Whether the contested set names this id, ignoring the path's separator spelling. The set is
 * built from the catalog canonically (`worktree-repo-index`), so the exact check is the fast
 * path and the folded check is the fallback for a caller holding the other spelling.
 */
export function hasContestedClaim(
  contested: ContestedWorkspaceIds | undefined,
  worktreeId: string
): boolean {
  if (!contested) {
    return false
  }
  if (contested.has(worktreeId)) {
    return true
  }
  const canonicalId = canonicalizeWorktreeId(worktreeId)
  for (const contestedId of contested) {
    if (canonicalizeWorktreeId(contestedId) === canonicalId) {
      return true
    }
  }
  return false
}

/**
 * The keys a row may live under, most specific first.
 *
 * A contested id is always qualified and an uncontested id is always bare, so there is no
 * fallback between the two — a reader that guessed the wrong spelling must MISS rather than
 * silently read another host's row. There IS a second SEPARATOR spelling, though: a row
 * persisted before the load reconciliation left it carries the raw Windows form, and the two
 * spellings are the same workspace by definition (the fold is separator-only, case-preserving).
 * So the key of the id the caller holds is tried first and the key with the id in the canonical
 * spelling is the fallback — the host prefix is preserved, so it can never land on another
 * host's or another workspace's row.
 */
export function workspaceSessionKeyCandidates(
  worktreeId: string,
  hostId: ExecutionHostId | null | undefined,
  contested: ContestedWorkspaceIds | undefined
): readonly string[] {
  const key = workspaceSessionKey(worktreeId, hostId, contested)
  // The two spellings are the same workspace by definition, so a reader may consult the other
  // one without ever landing on a different workspace's row: `splitWorktreeId` splits on the
  // first `::`, so a `host|` prefix stays intact and only the path segment re-spells.
  const otherKey = swapWorktreeIdPathSpelling(key)
  return otherKey === key ? [key] : [key, otherKey]
}

/**
 * Read one worktree-keyed record for a workspace, returning the key it was found under so a caller
 * can write back to the same place.
 */
export function readWorkspaceSessionEntry<T>(
  record: Readonly<Record<string, T>> | undefined,
  worktreeId: string,
  hostId: ExecutionHostId | null | undefined,
  contested: ContestedWorkspaceIds | undefined
): { entry: T; key: string } | undefined {
  if (!record) {
    return undefined
  }
  for (const key of workspaceSessionKeyCandidates(worktreeId, hostId, contested)) {
    if (Object.hasOwn(record, key)) {
      return { entry: record[key], key }
    }
  }
  return undefined
}

/**
 * The bare workspace id behind a session key. Exact for the canonical qualified shape; a bare or
 * legacy id is returned unchanged, matching `getWorktreeIdFromVisitKey` so both decoders agree on
 * what a `|` inside a legacy id means.
 */
export function getWorkspaceIdFromSessionKey(key: string): string {
  return isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
}

/** The host a session key names, or null when the key is bare or names an unknown host. */
export function getExecutionHostIdFromSessionKey(key: string): ExecutionHostId | null {
  return getExecutionHostIdFromWorktreeHostIdentity(key) ?? null
}

/**
 * Rewrite every worktree-keyed record of a session for a changed contested set.
 *
 * A contest appears when a second host registers a repo path another host already has, and clears
 * when one of them drops out, so keys have to flip in both directions while the app runs — not only
 * at boot.
 *
 * Pure, and reference-stable when nothing needs to move, so a catalog refresh that changes nothing
 * does not fan out through session persistence.
 */
export function rekeyWorkspaceSessionFields(
  session: WorkspaceSessionState,
  contested: ContestedWorkspaceIds,
  hostOf: (worktreeId: string) => ExecutionHostId | null
): WorkspaceSessionState {
  let next: WorkspaceSessionState | undefined
  for (const field of WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS) {
    const value = session[field]
    if (!isWorkspaceSessionRecord(value)) {
      continue
    }
    const rekeyed = rekeyWorkspaceSessionRecord(value, contested, hostOf)
    if (rekeyed === value) {
      continue
    }
    next ??= { ...session }
    // The field list is the only type evidence that a `worktreeKeyed` field holds a record; the
    // slice's own value type is a union, so the write goes through the record-typed view.
    assignWorktreeKeyedRecord(next, field, rekeyed)
  }
  return next ?? session
}

function assignWorktreeKeyedRecord(
  target: WorkspaceSessionRecord,
  field: keyof WorkspaceSessionState,
  record: WorkspaceSessionRecord
): void {
  target[field] = record
}

/**
 * Re-key one worktree-keyed record. Returns the same reference when no key needs to move.
 *
 * A contest appearing splits one bare row into `host|id` per claimant; a contest clearing collapses
 * them back. On the collapse, two rows that no longer have a host to distinguish them are the same
 * workspace twice, so the later one wins — the same convention the worktree listing uses to drop
 * the createWorktree/fetchWorktrees duplicate.
 */
export function rekeyWorkspaceSessionRecord(
  record: WorkspaceSessionRecord,
  contested: ContestedWorkspaceIds,
  hostOf: (worktreeId: string) => ExecutionHostId | null
): WorkspaceSessionRecord {
  const placed = new Map<string, unknown>()
  let changed = false
  for (const [key, entry] of Object.entries(record)) {
    const worktreeId = getWorkspaceIdFromSessionKey(key)
    // A bare row belongs to whichever host the catalog says owns it now: that is the only evidence
    // available, and it is the same evidence the write path uses to route the row back.
    const hostId = getExecutionHostIdFromSessionKey(key) ?? hostOf(worktreeId)
    const target = workspaceSessionKey(worktreeId, hostId, contested)
    if (target !== key || placed.has(target)) {
      changed = true
    }
    placed.set(target, entry)
  }
  return changed ? Object.fromEntries(placed) : record
}
