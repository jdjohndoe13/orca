import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId as normalizeWorkspaceSessionKeyToWorktreeId } from '../../../../../shared/workspace/identity/workspace-scope'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../../../shared/workspace-session/workspace-session-host-field-ownership'
import { pickPrimaryHostForClaims } from '../../../../../shared/workspace-session/workspace-session-contested-primary-host'
import { getExecutionHostIdFromSessionKey } from '../../../../../shared/workspace-session-worktree-key'
import {
  isWorkspaceSessionRecord,
  type WorkspaceSessionRecord
} from '../../../../../shared/workspace-session/workspace-session-host-records'
import { qualifyHostWorkspaceSessionSlices } from '../../../../../shared/workspace-session-key-qualification'
import type { WorkspaceRuntimeOwnerProjection } from '../ownership/workspace-runtime-host-ownership'
import { mergeWorkspaceSessionsFromHosts } from './workspace-session-host-merge'
import type { HostSessionSlices } from './workspace-session-host-split'

/**
 * Which execution hosts publish each workspace id, and what persistence does when two of them
 * publish the same one.
 *
 * A worktree id is `repoId::path` with no host component, so one repo registered on two hosts
 * publishes the SAME id for two different workspaces (STA-4343). Session state is keyed by that
 * bare id, so without this the two workspaces share one `tabsByWorktree` bucket and whichever host
 * writes last erases the other's tabs for good.
 *
 * A contested id therefore gets one row PER CLAIMANT in the unified renderer session, keyed
 * `host|id` — which is what lets four host-colliding cards show four different agent lines instead
 * of all painting the primary's tabs. The key rule lives in
 * `src/shared/workspace-session-worktree-key.ts`; this module decides which ids are contested and
 * carries the read's verdict back to the write path.
 *
 * The primary is decided ONCE, at read time, from the partition each row actually came from, and
 * that decision is carried back to the write path. Re-deriving it from the catalog at write time
 * would let the two disagree — the catalog names `ssh:*` hosts that own no partition — and the
 * write would then copy one host's workspace into another host's partition.
 */

export type WorktreeHostClaims = ReadonlyMap<string, ReadonlySet<ExecutionHostId>>

const WORKTREE_KEYED_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed')

/** Share session-key normalization with partition adoption so read and write cannot drift. */

function resolveClaimedHostId(
  worktree: WorkspaceRuntimeOwnerProjection,
  repoHostById: ReadonlyMap<string, ExecutionHostId | null>
): ExecutionHostId | null {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  if (runtimeOwner) {
    return toRuntimeExecutionHostId(runtimeOwner)
  }
  const parsed = parseExecutionHostId(worktree.hostId)
  if (parsed) {
    return parsed.id
  }
  // Attribute unqualified rows only to unique repo owners; guessing invents or hides host contests.
  return repoHostById.get(worktree.repoId) ?? null
}

export function indexWorktreeHostClaims(
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>,
  repoHostById: ReadonlyMap<string, ExecutionHostId | null>
): WorktreeHostClaims {
  const claims = new Map<string, Set<ExecutionHostId>>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      const hostId = resolveClaimedHostId(worktree, repoHostById)
      if (!hostId) {
        continue
      }
      const existing = claims.get(worktree.id)
      if (existing) {
        existing.add(hostId)
      } else {
        claims.set(worktree.id, new Set([hostId]))
      }
    }
  }
  return claims
}

function definedHostIds(slices: HostSessionSlices): ExecutionHostId[] {
  return (Object.keys(slices) as ExecutionHostId[]).filter((hostId) => slices[hostId])
}

function indexHostIdsBySessionKey(
  slices: HostSessionSlices,
  hostIds: readonly ExecutionHostId[]
): Map<string, ExecutionHostId[]> {
  const hostIdsByKey = new Map<string, ExecutionHostId[]>()
  for (const hostId of hostIds) {
    for (const field of WORKTREE_KEYED_FIELDS) {
      const record = slices[hostId]?.[field]
      if (!isWorkspaceSessionRecord(record)) {
        continue
      }
      for (const key of Object.keys(record)) {
        const owners = hostIdsByKey.get(key)
        if (!owners) {
          hostIdsByKey.set(key, [hostId])
        } else if (!owners.includes(hostId)) {
          owners.push(hostId)
        }
      }
    }
  }
  return hostIdsByKey
}

/** Park the non-primary claimant's rows for one contested key that CANNOT be separated by host.
 *  A `folder:<uuid>` key is minted per workspace, so two partitions holding it are one workspace
 *  written twice (#12723) — reuniting it is the stranded-partition repair's job, and qualifying it
 *  would split that one workspace into two rival buckets. Parking is what keeps the co-claimant's
 *  rows from being erased by the primary's write there. */
function parkHostEntries(
  slice: WorkspaceSessionState,
  hostId: ExecutionHostId,
  primaryByKey: ReadonlyMap<string, ExecutionHostId>
): { slice: WorkspaceSessionState; shadow: WorkspaceSessionState | null } {
  let nextSlice: WorkspaceSessionState | null = null
  let shadow: WorkspaceSessionState | null = null
  for (const field of WORKTREE_KEYED_FIELDS) {
    const record = slice[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    const kept: WorkspaceSessionRecord = {}
    const parked: WorkspaceSessionRecord = {}
    for (const [key, entry] of Object.entries(record)) {
      const primary = primaryByKey.get(key)
      if (primary && primary !== hostId) {
        parked[key] = entry
      } else {
        kept[key] = entry
      }
    }
    if (Object.keys(parked).length === 0) {
      continue
    }
    nextSlice ??= { ...slice }
    shadow ??= {} as WorkspaceSessionState
    ;(nextSlice as WorkspaceSessionRecord)[field] = kept
    ;(shadow as WorkspaceSessionRecord)[field] = parked
  }
  return { slice: nextSlice ?? slice, shadow }
}

/** Split contested worktree-keyed entries out of the read partitions.
 *
 *  A contested id that can name two workspaces (a `repoId::path`) gets every claimant's row re-keyed
 *  to `host|id` in the slices the renderer merges, so all claimants are present at once instead of
 *  sharing one bucket and painting the primary's tabs — the "Known gap" this closes. Nothing is
 *  parked for those: the qualified key names the partition its row came from, so the write path
 *  returns each row to its own partition without a shadow carrying it there.
 *
 *  A contested id that cannot name two workspaces (a `folder:<uuid>` key) is one workspace written
 *  twice and stays on the parking path, which is what keeps the co-claimant's rows from being
 *  erased by the primary's write.
 *
 *  `primaryHostBySessionKey` records where each key's live row came from — including the
 *  uncontested single-partition case, so the write path can put every row back in its own
 *  partition instead of re-deriving an owner that may not match. It is therefore NOT the contested
 *  set; `contestedSessionKeys` is, and only it says a bare id names more than one workspace. */
export function extractContestedHostSessionEntries(slices: HostSessionSlices): {
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
  contestedSessionKeys: Set<string>
} {
  const shadow: HostSessionSlices = {}
  const hostIds = definedHostIds(slices)
  const hostIdsByKey = indexHostIdsBySessionKey(slices, hostIds)
  const primaryHostBySessionKey: Record<string, ExecutionHostId> = {}
  const contestedSessionKeys = new Set<string>()
  const primaryByKey = new Map<string, ExecutionHostId>()
  for (const [key, owners] of hostIdsByKey) {
    primaryHostBySessionKey[key] = pickPrimaryHostForClaims(owners)
    if (owners.length > 1) {
      contestedSessionKeys.add(key)
      primaryByKey.set(key, primaryHostBySessionKey[key])
    }
  }
  const qualified = qualifyHostWorkspaceSessionSlices(slices, contestedSessionKeys)
  if (hostIds.length < 2 || primaryByKey.size === 0) {
    return { slices: qualified, shadow, primaryHostBySessionKey, contestedSessionKeys }
  }
  // Only the contested keys that are still bare after qualifying need parking; the rest now
  // carry their host in the key itself.
  const parkable = new Map<string, ExecutionHostId>()
  for (const [key, primary] of primaryByKey) {
    if (getExecutionHostIdFromSessionKey(key) === null) {
      parkable.set(key, primary)
    }
  }
  if (parkable.size === 0) {
    return { slices: qualified, shadow, primaryHostBySessionKey, contestedSessionKeys }
  }
  const next: HostSessionSlices = { ...qualified }
  for (const hostId of hostIds) {
    const slice = qualified[hostId]
    if (!slice) {
      continue
    }
    const result = parkHostEntries(slice, hostId, parkable)
    next[hostId] = result.slice
    if (result.shadow) {
      shadow[hostId] = result.shadow
    }
  }
  return { slices: next, shadow, primaryHostBySessionKey, contestedSessionKeys }
}

export function mergeWorkspaceSessionsWithHostShadow(slices: HostSessionSlices): {
  session: WorkspaceSessionState
  slices: HostSessionSlices
  shadow: HostSessionSlices
  primaryHostBySessionKey: Record<string, ExecutionHostId>
  contestedSessionKeys: Set<string>
} {
  const extracted = extractContestedHostSessionEntries(slices)
  return {
    session: mergeWorkspaceSessionsFromHosts(extracted.slices, extracted.contestedSessionKeys),
    slices: extracted.slices,
    shadow: extracted.shadow,
    primaryHostBySessionKey: extracted.primaryHostBySessionKey,
    contestedSessionKeys: extracted.contestedSessionKeys
  }
}

function hostStillClaimsKey(
  claims: WorktreeHostClaims,
  key: string,
  hostId: ExecutionHostId
): boolean {
  const claimed = claims.get(normalizeWorkspaceSessionKeyToWorktreeId(key))
  // Missing/unhydrated/folder catalog rows prove no ownership loss; drop only on positive reattribution.
  return !claimed || claimed.has(hostId)
}

/** Whether the slices will be applied as a merge-by-field patch or a full partition replace. */
export type HostSessionWriteMode = 'patch' | 'replace'

/** Restore parked co-claimant rows to their own split slices before writing so primary updates cannot erase them. */
export function attachHostSessionShadow(
  slices: HostSessionSlices,
  shadow: HostSessionSlices | undefined,
  claims: WorktreeHostClaims,
  mode: HostSessionWriteMode
): void {
  if (!shadow) {
    return
  }
  for (const [hostId, shadowSlice] of Object.entries(shadow) as [
    ExecutionHostId,
    WorkspaceSessionState | undefined
  ][]) {
    const slice = slices[hostId]
    if (!slice || !shadowSlice) {
      continue
    }
    for (const field of WORKTREE_KEYED_FIELDS) {
      const parked = shadowSlice[field]
      if (!isWorkspaceSessionRecord(parked)) {
        continue
      }
      let target = slice[field]
      if (!isWorkspaceSessionRecord(target)) {
        // Omitted patch fields remain untouched, but full partition replacement erases them; include parked fields for full writes.
        if (mode === 'patch') {
          continue
        }
        target = {}
        ;(slice as WorkspaceSessionRecord)[field] = target
      }
      for (const [key, entry] of Object.entries(parked)) {
        if (Object.hasOwn(target, key) || !hostStillClaimsKey(claims, key, hostId)) {
          continue
        }
        target[key] = entry
      }
    }
  }
}
