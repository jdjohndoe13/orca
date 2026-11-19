import type { StoreApi } from 'zustand'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey,
  hasContestedClaim,
  workspaceSessionKey,
  type ContestedWorkspaceIds
} from '../../../shared/workspace-session-worktree-key'
import { isWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session/workspace-session-host-records'
import { isHostQualifiableWorkspaceId } from '../../../shared/workspace-session-key-qualification'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import type { AppState } from './types'
import { getContestedWorktreeIds } from './slices/worktrees/listing/worktree-catalog-index'

/**
 * Keeps the live per-worktree rows under the key the readers resolve when the contested gate flips.
 *
 * A contested workspace id (one repo registered on several execution hosts, STA-4343) keeps its
 * rows at `host|id`; every other id keeps them at the bare id. The gate follows the catalog, so a
 * second host registering a path another host already has — or one of them dropping out — moves
 * the key a workspace's rows live under. The write side already routes each row by the key it
 * resolves, so a flip that left the rows behind writes the NEW key and leaves the OLD one as a row
 * no reader resolves: the workbench mounts, reads nothing, and paints black. The reverse flip —
 * the contest clearing — has to bring the rows back to the bare key for the same reason.
 */

/**
 * The store's per-worktree records the write side addresses by session key.
 *
 * Deliberately not `WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS`: that is the persisted session's
 * shape (`unifiedTabs`/`tabGroups`/`tabGroupLayouts`), whose renderer records are named
 * differently. `openFilesByWorktree` is likewise persisted-only — the renderer keeps `openFiles`
 * as a flat list.
 *
 * `lastVisitedAtByWorktreeId` is absent by design: it qualifies every host's key by its own
 * convention (`worktree-visit-recency.ts` writes `${host}|${id}` and `getWorktreeVisitTimestamp`
 * reads either spelling), so its rows are already separated per host and the boot read excludes it
 * for the same reason. Moving it here would double-move a row that is already placed.
 *
 * The `recentlyClosed*ByWorktree` stacks, `everActivatedWorktreeIds`, and `worktreeNavHistory` are
 * entity-space — written from `Tab.worktreeId` / `activeWorktreeId`, which stay bare — so they
 * must not move.
 */
const CONTEST_REKEYED_STORE_FIELDS = [
  'tabsByWorktree',
  'activeTabIdByWorktree',
  'tabBarOrderByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'defaultTerminalTabsAppliedByWorktreeId',
  'pendingReconnectTabByWorktree'
] as const satisfies readonly (keyof AppState)[]

/**
 * The reconnect queue reads `tabsByWorktree` and `pendingReconnectTabByWorktree` by the id in
 * `pendingReconnectWorktreeIds`, so the array travels with the maps it indexes.
 */
const CONTEST_REKEYED_STORE_ARRAYS = [
  'pendingReconnectWorktreeIds'
] as const satisfies readonly (keyof AppState)[]

/**
 * The flagged ids that can name more than one workspace.
 *
 * A `folder:<uuid>` key is minted per workspace, so two partitions holding it are one workspace
 * written twice — the stranded-partition repair reunites it, and the boot read refuses to qualify
 * it for exactly that reason. Same rule here, so a flip can never split one folder workspace into
 * two rival buckets.
 */
export function qualifiableContestedIds(contested: ContestedWorkspaceIds): ReadonlySet<string> {
  return new Set([...contested].filter(isHostQualifiableWorkspaceId))
}

/**
 * The ids one flip can move: the union of the two contested sets, filtered to the ids that can
 * name more than one workspace. A contested id is flagged by the canonical spelling of the id
 * (`worktree-repo-index`), so the union is the only set that sees both the id that just became
 * contested and the one that just cleared.
 */
function movableContestedIds(
  contested: ContestedWorkspaceIds,
  previousContested: ContestedWorkspaceIds
): ReadonlySet<string> {
  if (contested === previousContested) {
    return qualifiableContestedIds(contested)
  }
  return qualifiableContestedIds(new Set([...contested, ...previousContested]))
}

/**
 * The key one stored key belongs under now.
 *
 * A bare row's host is the pre-flip catalog's owner — the same evidence the shared
 * `rekeyWorkspaceSessionRecord` uses and the same one the persistence split routes the row back
 * by. A row that already carries the empty prefix names no host BY ITS OWN CONVENTION and is
 * never moved: re-spelling it would attribute a row the writer refused to attribute, which is
 * exactly what paints one host's tabs into another host's card. With no host to spell a bare row
 * either, it stays put.
 */
function rekeySessionKey(
  key: string,
  hostOf: (worktreeId: string) => ExecutionHostId | null,
  contested: ContestedWorkspaceIds,
  movable: ContestedWorkspaceIds
): string {
  const worktreeId = getWorkspaceIdFromSessionKey(key)
  if (!hasContestedClaim(movable, worktreeId)) {
    return key
  }
  if (isWorktreeHostIdentity(key)) {
    const rowHostId = getExecutionHostIdFromSessionKey(key)
    return rowHostId === null ? key : workspaceSessionKey(worktreeId, rowHostId, contested)
  }
  const hostId = hostOf(worktreeId)
  if (hostId === null) {
    return key
  }
  return workspaceSessionKey(worktreeId, hostId, contested)
}

/**
 * The patch that re-spells every live record for the current contested set, or null when nothing
 * moves — so a store with no collision is never rewritten by this pass at all.
 *
 * `hostEvidence` is the catalog as it was BEFORE the flip. That is the only state that can name a
 * contested id's owner: while the id was uncontested the owner index resolves it, and the moment
 * the second host registers the index goes deliberately ambiguous. Reading the owner out of the
 * post-flip catalog would answer null for every bare row and move nothing at all.
 *
 * The target spelling follows the POST-flip set (that is what the reader resolves next), while the
 * ids worth walking are the union of the two sets: an id that just became contested needs its bare
 * row qualified, and an id that just cleared needs its qualified rows brought back to the bare key.
 */
export function buildContestRekeyPatch(
  state: AppState,
  hostEvidence: AppState,
  contested: ContestedWorkspaceIds
): Partial<AppState> | null {
  const movable = movableContestedIds(
    contested,
    getContestedWorktreeIds(hostEvidence.worktreesByRepo)
  )
  if (movable.size === 0) {
    return null
  }
  const hostOf = (worktreeId: string): ExecutionHostId | null =>
    getResolvedExecutionHostIdForWorktree(hostEvidence, worktreeId)
  let patch: Partial<AppState> | undefined
  const assign = (field: keyof AppState, value: unknown): void => {
    patch ??= {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the two lists below, which name the store's worktree-keyed records and arrays, and the value is that field's own content with its keys re-spelled.
    ;(patch as Record<string, unknown>)[field] = value
  }
  for (const field of CONTEST_REKEYED_STORE_FIELDS) {
    const record = state[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    const rekeyed = rekeyContestRecord(record, hostOf, contested, movable)
    if (rekeyed !== record) {
      assign(field, rekeyed)
    }
  }
  for (const field of CONTEST_REKEYED_STORE_ARRAYS) {
    const ids = state[field]
    if (!Array.isArray(ids)) {
      continue
    }
    const rekeyed = ids.map((id) =>
      typeof id === 'string' ? rekeySessionKey(id, hostOf, contested, movable) : id
    )
    if (!rekeyed.every((id, index) => id === ids[index])) {
      assign(field, rekeyed)
    }
  }
  return patch ?? null
}

/**
 * Re-keyed record, or the same reference when no key moves.
 *
 * Two rows that end up in one bucket are one workspace written twice, so the later one wins —
 * the convention the contested collapse already uses everywhere else.
 */
function rekeyContestRecord(
  record: Record<string, unknown>,
  hostOf: (worktreeId: string) => ExecutionHostId | null,
  contested: ContestedWorkspaceIds,
  movable: ContestedWorkspaceIds
): Record<string, unknown> {
  const placed = new Map<string, unknown>()
  let changed = false
  for (const [key, entry] of Object.entries(record)) {
    const target = rekeySessionKey(key, hostOf, contested, movable)
    if (target !== key || placed.has(target)) {
      changed = true
    }
    placed.set(target, entry)
  }
  return changed ? Object.fromEntries(placed) : record
}

/**
 * Call once from inside the store's state creator, passing its `api`.
 *
 * Why a subscriber rather than a hook in the catalog-fetch path: the gate is derived from
 * `worktreesByRepo` and memoized on its identity, so an identity comparison is both the cheap and
 * the sound change detector, and every write path that can move the catalog — fetch, SSH hydrate,
 * runtime patch, repo removal — is covered without threading anything through any of them.
 *
 * The patch does not touch `worktreesByRepo`, so the write it makes re-enters this listener and
 * short-circuits on the same identity check — no recursion, no separate guard.
 */
export function installContestRekey(api: Pick<StoreApi<AppState>, 'setState' | 'subscribe'>): void {
  api.subscribe((state, previous) => {
    const contested = getContestedWorktreeIds(state.worktreesByRepo)
    if (contested === getContestedWorktreeIds(previous.worktreesByRepo)) {
      return
    }
    // A catalog refresh that flags the same ids is a false positive of the identity check, and the
    // pass below is a no-op that returns the same references, so it costs nothing.
    const patch = buildContestRekeyPatch(state, previous, contested)
    if (patch) {
      api.setState(patch)
    }
  })
}
