import type { PersistedState } from '../orca-profiles/persisted-state-types'
import type { WorkspaceKey } from '../workspace/identity/workspace-scope'
import { splitSessionKey, type WorktreeIdSpellingMap } from './worktree-id-spellings'

/**
 * The non-session half of the Windows separator-spelling reconciliation: the id-keyed records
 * outside the workspace sessions. The session half is `reconcileWorkspaceSessionPathSpellings`;
 * `reconcilePersistedWorktreeIdPathSpellings` runs both.
 */

/** The canonical id behind a session key, or the key unchanged when it names no workspace. */
export function canonicalizeSessionKey(key: string, map: WorktreeIdSpellingMap): string {
  const parsed = splitSessionKey(key)
  if (!parsed) {
    return key
  }
  const canonical = map.get(parsed.id)
  return canonical ? `${parsed.prefix}${canonical}` : key
}

/** Folds `worktreeMeta` and both lineage maps. Mutates in place; returns whether anything moved. */
export function reconcileWorktreeIdSpellingRecords(
  state: Pick<
    PersistedState,
    'worktreeMeta' | 'worktreeLineageById' | 'workspaceLineageByChildKey'
  > &
    Partial<Pick<PersistedState, 'worktreeIdentityAliases'>> &
    Partial<Pick<PersistedState, 'mobileClientTabSelectionsByDeviceId' | 'ui'>> &
    Partial<Pick<PersistedState, 'migrationUnsupportedPtyEntries'>>,
  map: WorktreeIdSpellingMap,
  rekeyRecord: (
    record: Record<string, unknown>,
    map: WorktreeIdSpellingMap
  ) => Record<string, unknown> | null
): boolean {
  let changed = false

  // worktreeMeta: newest `lastActivityAt` wins (the alias-resolver convention), and the survivor
  // records the folded spelling so session GC still recognizes rows minted under it.
  for (const [rawId, canonicalId] of map) {
    const raw = state.worktreeMeta[rawId]
    if (!raw) {
      continue
    }
    const existing = state.worktreeMeta[canonicalId]
    const survivor =
      existing && (existing.lastActivityAt ?? 0) >= (raw.lastActivityAt ?? 0) ? existing : raw
    const prior = new Set(
      [...(survivor.priorWorktreeIds ?? []), rawId, ...(existing?.priorWorktreeIds ?? [])].filter(
        (id) => id !== canonicalId
      )
    )
    survivor.priorWorktreeIds = [...prior]
    state.worktreeMeta[canonicalId] = survivor
    delete state.worktreeMeta[rawId]
    changed = true
  }

  for (const [rawId, canonicalId] of map) {
    const lineage = state.worktreeLineageById[rawId]
    if (lineage) {
      delete state.worktreeLineageById[rawId]
      // The canonical row already exists: the raw one is the same workspace written twice; the
      // existing row wins rather than being overwritten by the older spelling.
      state.worktreeLineageById[canonicalId] ??=
        lineage.worktreeId === rawId ? { ...lineage, worktreeId: canonicalId } : lineage
      changed = true
    }
    for (const [key, row] of Object.entries(state.worktreeLineageById)) {
      if (row.worktreeId === rawId) {
        state.worktreeLineageById[key] = { ...row, worktreeId: canonicalId }
        changed = true
      }
      if (row.parentWorktreeId === rawId) {
        state.worktreeLineageById[key] = {
          ...state.worktreeLineageById[key],
          parentWorktreeId: canonicalId
        }
        changed = true
      }
    }
  }

  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const nextChildKey = canonicalizeSessionKey(childKey, map)
    const nextParentKey = canonicalizeSessionKey(lineage.parentWorkspaceKey, map)
    if (nextChildKey === childKey && nextParentKey === lineage.parentWorkspaceKey) {
      continue
    }
    if (nextChildKey !== childKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key of this record is a WorkspaceKey by the state type, and the canonicalized key folds only the id part of a `worktree:`/`folder:` template.
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fold invariant as the delete above.
      if (state.workspaceLineageByChildKey[nextChildKey as WorkspaceKey]) {
        changed = true
        continue
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fold invariant — the template-literal key shape is preserved by canonicalizeSessionKey.
    state.workspaceLineageByChildKey[nextChildKey as WorkspaceKey] = {
      ...lineage,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fold invariant.
      childWorkspaceKey: nextChildKey as WorkspaceKey,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fold invariant.
      parentWorkspaceKey: nextParentKey as WorkspaceKey
    }
    changed = true
  }

  // worktreeIdentityAliases keys are `host|worktreeId` — fold the id part.
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    const canonicalAlias = canonicalizeSessionKey(alias, map)
    if (canonicalAlias === alias) {
      continue
    }
    const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
    delete state.worktreeIdentityAliases?.[alias]
    state.worktreeIdentityAliases ??= {}
    state.worktreeIdentityAliases[canonicalAlias] = [
      ...new Set([...(state.worktreeIdentityAliases[canonicalAlias] ?? []), ...identityKeys])
    ]
    changed = true
  }

  const mobileSelections = state.mobileClientTabSelectionsByDeviceId
  if (mobileSelections) {
    for (const [deviceId, selections] of Object.entries(mobileSelections)) {
      const rekeyed = rekeyRecord(selections, map)
      if (rekeyed) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rekeyRecord re-keys only the worktreeId part of the same record it was given; the row shape is untouched.
        mobileSelections[deviceId] = rekeyed as never
        changed = true
      }
    }
  }

  for (const record of [
    state.ui?.explorerDisplayRootByWorktree,
    state.ui?.showDotfilesByWorktree
  ]) {
    if (!record) {
      continue
    }
    const rekeyed = rekeyRecord(record, map)
    if (rekeyed) {
      Object.assign(record, rekeyed)
      for (const key of Object.keys(record)) {
        if (!(key in rekeyed)) {
          delete record[key]
        }
      }
      changed = true
    }
  }

  for (const entry of state.migrationUnsupportedPtyEntries ?? []) {
    const canonical = entry.worktreeId ? map.get(entry.worktreeId) : undefined
    if (canonical) {
      entry.worktreeId = canonical
      changed = true
    }
  }

  return changed
}
