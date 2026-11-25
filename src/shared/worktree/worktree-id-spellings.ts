import type { PersistedState } from '../orca-profiles/persisted-state-types'
import type { Repo } from '../repository/repo-types'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../workspace-session/workspace-session-host-field-ownership'
import { parseWorkspaceKey } from '../workspace/identity/workspace-scope'
import { isFolderRepo } from '../repository/repo-kind'
import { getWorktreeIdFromHostIdentity, isWorktreeHostIdentity } from './host-qualified-identity'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  canonicalizeWorktreeId,
  getRepoMainWorktreeId
} from './id'

/**
 * The census of Windows separator spellings (`C:/vmd` vs `C:\vmd`) a persisted state holds.
 *
 * The same Windows checkout reaches the client through two spellings — the host's git scan emits
 * `C:/vmd`, while an id built from a persisted `repo.path` yields `C:\vmd` — and installs from
 * before ingest canonicalization persisted both. The spellings are the same workspace by
 * definition (the fold is separator-only and case-preserving), so every row keyed by the raw
 * spelling must be re-keyed onto the canonical one. This file collects the raw→canonical map;
 * `worktree-path-spelling-reconciliation.ts` applies it.
 */

/** rawId → canonicalId, only for spellings that actually differ. */
export type WorktreeIdSpellingMap = ReadonlyMap<string, string>

/**
 * The ids the host compares BYTE-EXACTLY, which the fold must never touch.
 *
 * - A folder repo's root and its `::workspace:<uuid>` instances: the host's
 *   `isFolderWorkspaceIdForRepo` byte-compares the id it was handed against `repoId::repo.path`,
 *   so folding the id would call a folder's own workspace a different repo's.
 * - A git repo that grew out of a folder locator (`folderUpgradeGitRootPath`): the locator id is
 *   the checkout's surviving identity — `preserveFolderUpgradeWorktreePath` rewrites the scan
 *   path back to the raw locator so the OMP meta keyed under the raw id keeps matching. Folding
 *   that id orphans the meta and the OMP terminal dies on restart (the contract the
 *   "preserves the live folder locator" test pins).
 *
 * Only the ROOT spelling is protected for a folder-upgrade repo; the repo's other worktrees are
 * ordinary git worktrees the host publishes in the canonical spelling.
 */
export function collectHostByteExactWorktreeIds(
  repos: readonly Pick<Repo, 'id' | 'path' | 'kind' | 'folderUpgradeGitRootPath'>[]
): Set<string> {
  const protectedRoots = new Set<string>()
  for (const repo of repos) {
    if (isFolderRepo(repo) || repo.folderUpgradeGitRootPath) {
      protectedRoots.add(getRepoMainWorktreeId(repo))
    }
  }
  return protectedRoots
}

/** Whether the id is one of the host's byte-exact ids — a protected root, or its instance. */
export function isHostByteExactWorktreeId(
  id: string,
  protectedRoots: ReadonlySet<string>
): boolean {
  if (protectedRoots.has(id)) {
    return true
  }
  for (const root of protectedRoots) {
    if (id.startsWith(`${root}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)) {
      return true
    }
  }
  return false
}

/** The session key's raw id and its host prefix, or null when the key names no workspace. */
export function splitSessionKey(key: string): { prefix: string; id: string } | null {
  if (isWorktreeHostIdentity(key)) {
    const id = getWorktreeIdFromHostIdentity(key)
    return { prefix: key.slice(0, key.length - id.length), id }
  }
  const scope = parseWorkspaceKey(key)
  if (scope?.type === 'worktree') {
    return { prefix: 'worktree:', id: scope.worktreeId }
  }
  if (scope?.type === 'folder') {
    return null
  }
  return { prefix: '', id: key }
}

export function addWorktreeIdSpelling(
  spellings: Map<string, string>,
  id: string | null | undefined,
  protectedRoots?: ReadonlySet<string>
): void {
  if (!id) {
    return
  }
  if (protectedRoots && isHostByteExactWorktreeId(id, protectedRoots)) {
    return
  }
  const canonical = canonicalizeWorktreeId(id)
  if (canonical !== id && !spellings.has(id)) {
    spellings.set(id, canonical)
  }
}

export function addWorktreeIdSpellingKey(
  spellings: Map<string, string>,
  key: string | null | undefined,
  protectedRoots?: ReadonlySet<string>
): void {
  if (!key || !key.includes('::')) {
    return
  }
  addWorktreeIdSpelling(spellings, splitSessionKey(key)?.id, protectedRoots)
}

/**
 * The id spellings a state holds that canonicalization folds. Collects every id-bearing location
 * before rewriting anything, so one pass sees every spelling. Ids the host compares byte-exactly
 * (the protected roots) are never folded — see `collectHostByteExactWorktreeIds`.
 */
export function collectWorktreeIdSpellings(
  state: Pick<
    PersistedState,
    | 'repos'
    | 'worktreeMeta'
    | 'worktreeLineageById'
    | 'workspaceSession'
    | 'workspaceSessionsByHostId'
    | 'ui'
  > &
    Partial<Pick<PersistedState, 'worktreeIdentityAliases' | 'migrationUnsupportedPtyEntries'>> &
    Partial<Pick<PersistedState, 'mobileClientTabSelectionsByDeviceId'>>
): WorktreeIdSpellingMap {
  const protectedRoots = collectHostByteExactWorktreeIds(state.repos ?? [])
  const spellings = new Map<string, string>()
  for (const key of Object.keys(state.worktreeMeta ?? {})) {
    addWorktreeIdSpellingKey(spellings, key, protectedRoots)
  }
  for (const lineage of Object.values(state.worktreeLineageById ?? {})) {
    addWorktreeIdSpelling(spellings, lineage.worktreeId, protectedRoots)
    addWorktreeIdSpelling(spellings, lineage.parentWorktreeId, protectedRoots)
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    addWorktreeIdSpellingKey(spellings, alias, protectedRoots)
  }
  for (const entry of state.migrationUnsupportedPtyEntries ?? []) {
    addWorktreeIdSpelling(spellings, entry.worktreeId, protectedRoots)
  }
  for (const record of [
    state.ui?.explorerDisplayRootByWorktree,
    state.ui?.showDotfilesByWorktree
  ]) {
    for (const key of Object.keys(record ?? {})) {
      addWorktreeIdSpellingKey(spellings, key, protectedRoots)
    }
  }
  for (const selections of Object.values(state.mobileClientTabSelectionsByDeviceId ?? {})) {
    for (const key of Object.keys(selections ?? {})) {
      addWorktreeIdSpellingKey(spellings, key, protectedRoots)
    }
  }
  for (const session of [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {})
  ]) {
    if (session) {
      collectWorkspaceSessionPathSpellings(session, spellings, protectedRoots)
    }
  }
  return spellings
}

/** The id spellings one session slice names. */
export function collectWorkspaceSessionPathSpellings(
  session: WorkspaceSessionState,
  spellings = new Map<string, string>(),
  protectedRoots?: ReadonlySet<string>
): Map<string, string> {
  addWorktreeIdSpelling(spellings, session.activeWorktreeId, protectedRoots)
  addWorktreeIdSpellingKey(spellings, session.activeWorkspaceKey, protectedRoots)
  for (const id of session.activeWorktreeIdsOnShutdown ?? []) {
    addWorktreeIdSpelling(spellings, id, protectedRoots)
  }
  // Environment-keyed, but every row names its worktree.
  for (const rows of Object.values(session.clientHostedBrowserCloseIntentsByEnvironment ?? {})) {
    if (Array.isArray(rows)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: read-only census; the persisted rows are exactly this shape, and a row that lacks the field is skipped.
      for (const row of rows as { worktreeId?: string }[]) {
        addWorktreeIdSpelling(spellings, row?.worktreeId, protectedRoots)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership table is the app's own field-name/role map; entries() only yields its own key/value pairs.
  for (const [field, ownership] of Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP) as [
    keyof WorkspaceSessionState,
    string
  ][]) {
    if (ownership !== 'worktreeKeyed') {
      continue
    }
    const record = session[field]
    if (!record || typeof record !== 'object') {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership table classifies this field as a worktree-keyed record, and the guard proves it is an object.
    for (const key of Object.keys(record as Record<string, unknown>)) {
      addWorktreeIdSpellingKey(spellings, key, protectedRoots)
    }
  }
  return spellings
}
