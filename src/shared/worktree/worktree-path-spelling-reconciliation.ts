import type { PersistedState } from '../orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import type { WorkspaceKey } from '../workspace/identity/workspace-scope'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../workspace-session/workspace-session-host-field-ownership'
import { collectWorktreeIdSpellings, type WorktreeIdSpellingMap } from './worktree-id-spellings'
import {
  canonicalizeSessionKey,
  reconcileWorktreeIdSpellingRecords
} from './worktree-id-spelling-records'

/**
 * Reconciles the two Windows separator spellings of ONE worktree id (`C:/vmd` vs `C:\vmd`) that
 * installs persisted before ingest canonicalization left behind.
 *
 * The spellings are the same workspace by definition (the fold is separator-only and
 * case-preserving), so every row keyed by the raw spelling is re-keyed onto the canonical one.
 * Collision rule: later wins on iteration order, matching `rekeyWorkspaceSessionRecord`'s
 * collapse convention, except `worktreeMeta` (newest `lastActivityAt` wins, the
 * `resolveAliasIdentityKey` convention) and `lastVisitedAtByWorktreeId` (max, the
 * `migrateWorktreeIdentity` convention). A row is never lost: the folded spelling is recorded on
 * the survivor's `priorWorktreeIds` so a session minted under the old id is still owned.
 */

export {
  collectWorktreeIdSpellings,
  collectWorkspaceSessionPathSpellings,
  type WorktreeIdSpellingMap
} from './worktree-id-spellings'

/**
 * Re-keys one worktree-keyed record. Later rows win on collision (the
 * `rekeyWorkspaceSessionRecord` convention); `merge` overrides for fields with a better rule.
 */
export function rekeyWorktreeKeyedRecord(
  record: Record<string, unknown>,
  map: WorktreeIdSpellingMap,
  merge?: (incoming: unknown, existing: unknown) => unknown
): Record<string, unknown> | null {
  let changed = false
  const placed = new Map<string, unknown>()
  for (const [key, entry] of Object.entries(record)) {
    const target = canonicalizeSessionKey(key, map)
    if (target !== key) {
      changed = true
    }
    if (merge && placed.has(target)) {
      placed.set(target, merge(entry, placed.get(target)))
    } else {
      placed.set(target, entry)
    }
  }
  return changed ? Object.fromEntries(placed) : null
}

/** Rewrites a row's `worktreeId`-shaped fields when they name a spelling being folded. */
function repointWorktreeNamingRow<T extends object>(row: T, map: WorktreeIdSpellingMap): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads only; a row that lacks these fields simply matches no folding entry, and the typed view never writes back through it.
  const named = row as {
    worktreeId?: unknown
    workspaceId?: unknown
    docLocation?: { worktreeId?: unknown } | null
  }
  const worktreeId = typeof named.worktreeId === 'string' ? map.get(named.worktreeId) : undefined
  const workspaceId = typeof named.workspaceId === 'string' ? map.get(named.workspaceId) : undefined
  const docWorktreeId =
    named.docLocation && typeof named.docLocation.worktreeId === 'string'
      ? map.get(named.docLocation.worktreeId)
      : undefined
  if (!worktreeId && !workspaceId && !docWorktreeId) {
    return row
  }
  const next = { ...named }
  if (worktreeId) {
    next.worktreeId = worktreeId
  }
  if (workspaceId) {
    next.workspaceId = workspaceId
  }
  if (docWorktreeId && named.docLocation) {
    next.docLocation = { ...named.docLocation, worktreeId: docWorktreeId }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy starts from the row's own shape and only swaps a string field for its canonical spelling.
  return next as T
}

/** Re-keys the keys of a record and repoints any row inside it that names a worktree.
 *  `keepKeys` is for records whose keys name something else (an environment) — only the
 *  worktree names inside the rows fold. */
function reconcileWorktreeKeyedRecord(
  value: unknown,
  map: WorktreeIdSpellingMap,
  merge?: (incoming: unknown, existing: unknown) => unknown,
  keepKeys = false
): unknown {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above proves `value` is a non-null object; every persisted record is string-keyed.
  const record = value as Record<string, unknown>
  const rekeyed = keepKeys ? record : (rekeyWorktreeKeyedRecord(record, map, merge) ?? record)
  let changed = rekeyed !== record
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(rekeyed)) {
    if (Array.isArray(entry)) {
      const repointed = entry.map((row) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard proves the array element is an object; repointWorktreeNamingRow only reads known id fields.
        row && typeof row === 'object' ? repointWorktreeNamingRow(row as object, map) : row
      )
      if (repointed.some((row, index) => row !== entry[index])) {
        changed = true
      }
      next[key] = repointed
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard proves the value is an object; repointWorktreeNamingRow only reads known id fields.
      const repointed = repointWorktreeNamingRow(entry as object, map)
      if (repointed !== entry) {
        changed = true
      }
      next[key] = repointed
    } else {
      next[key] = entry
    }
  }
  return changed ? next : undefined
}

/** Reconciles every worktree-naming field of one session slice. Mutates in place. */
export function reconcileWorkspaceSessionPathSpellings(
  session: WorkspaceSessionState,
  map: WorktreeIdSpellingMap
): boolean {
  if (map.size === 0) {
    return false
  }
  let changed = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership table is the app's own field-name/role map; entries() only yields its own key/value pairs.
  for (const [field, ownership] of Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP) as [
    keyof WorkspaceSessionState,
    string
  ][]) {
    if (ownership === 'global') {
      changed = reconcileSessionGlobalField(session, field, map) || changed
      continue
    }
    if (ownership === 'worktreeArray') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership table classifies this field as a worktree-id string array; the guard below handles absence.
      const ids = session[field] as string[] | undefined
      if (!ids) {
        continue
      }
      const next = ids.map((id) => map.get(id) ?? id)
      if (next.some((id, index) => id !== ids[index])) {
        // The same workspace in both spellings is one shutdown entry; keep the first.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write target is the same string-array field the value was read from; only its spelling folds.
        session[field] = [...new Set(next)] as never
        changed = true
      }
      continue
    }
    if (
      ownership !== 'worktreeKeyed' &&
      ownership !== 'sleepingAgentKeyed' &&
      ownership !== 'surfaceTombstoneKeyed' &&
      ownership !== 'browserWorkspaceKeyed'
    ) {
      continue
    }
    const value = session[field]
    if (!value || typeof value !== 'object') {
      continue
    }
    // Recency rows merge by max, the `migrateWorktreeIdentity` convention.
    const merge =
      field === 'lastVisitedAtByWorktreeId'
        ? (incoming: unknown, existing: unknown): unknown =>
            typeof incoming === 'number' && typeof existing === 'number'
              ? Math.max(incoming, existing)
              : incoming
        : undefined
    const reconciled = reconcileWorktreeKeyedRecord(value, map, merge)
    if (reconciled !== undefined) {
      // The field list is the only type evidence that these classes hold records.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the same ownership table that classifies it as a record, and the reconciled value is a copy of the record's own shape.
      ;(session as Record<string, unknown>)[field] = reconciled
      changed = true
    }
  }
  return changed
}

/** The three global fields that name a workspace. */
function reconcileSessionGlobalField(
  session: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  map: WorktreeIdSpellingMap
): boolean {
  if (field === 'activeWorktreeId') {
    const active = session.activeWorktreeId
    const canonical = active ? map.get(active) : undefined
    if (canonical) {
      session.activeWorktreeId = canonical
      return true
    }
    return false
  }
  if (field === 'activeWorkspaceKey') {
    const key = session.activeWorkspaceKey
    const canonical = key ? canonicalizeSessionKey(key, map) : undefined
    if (canonical && canonical !== key) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: canonicalizeSessionKey only folds the id part after the `worktree:` prefix, so the template literal shape is preserved.
      session.activeWorkspaceKey = canonical as WorkspaceKey
      return true
    }
    return false
  }
  if (field === 'clientHostedBrowserCloseIntentsByEnvironment') {
    // Keyed by environment, but every row names its worktree — a stale one never matches
    // again, so the host re-adds a tab the user closed.
    const reconciled = reconcileWorktreeKeyedRecord(session[field], map, undefined, true)
    if (reconciled === undefined) {
      return false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciled value is a copy of the record's own rows with only the worktreeId spelling folded.
    ;(session as Record<string, unknown>)[field] = reconciled
    return true
  }
  return false
}

/** Reconciles every persisted worktree id of a loaded state. Mutates in place; returns whether
 *  anything moved so the caller can gate its save. Ids the host compares byte-exactly (a folder
 *  repo's, or a folder-upgrade repo's locator) are never folded — see
 *  `collectHostByteExactWorktreeIds`. */
export function reconcilePersistedWorktreeIdPathSpellings(state: PersistedState): boolean {
  const map = collectWorktreeIdSpellings(state)
  if (map.size === 0) {
    return false
  }
  let changed = reconcileWorktreeIdSpellingRecords(state, map, rekeyWorktreeKeyedRecord)
  if (reconcileWorkspaceSessionPathSpellings(state.workspaceSession, map)) {
    changed = true
  }
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    if (session && reconcileWorkspaceSessionPathSpellings(session, map)) {
      changed = true
    }
  }
  return changed
}
