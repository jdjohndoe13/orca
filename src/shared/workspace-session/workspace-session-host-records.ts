import type { WorkspaceSessionState } from './workspace-session-state-types'

export type WorkspaceSessionRecord = Record<string, unknown>

export function isWorkspaceSessionRecord(value: unknown): value is WorkspaceSessionRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function buildWorktreeIdByTabId(
  state: Partial<Pick<WorkspaceSessionState, 'tabsByWorktree' | 'unifiedTabs'>>
): Map<string, string> {
  const byTab = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      byTab.set(tab.id, worktreeId)
    }
  }
  // Why the record's key and not the tab's `worktreeId` field: the field is the bare id, and a
  // contested id is spelled `host|id` in the key — the key is what carries the host the split
  // routes by. A unified-only tab (no `tabsByWorktree` row) would otherwise land in the
  // catalog's pinned primary partition instead of the publishing host's own.
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, worktreeId)
      }
    }
  }
  return byTab
}

/** The renderer's live tab catalogs, for routing a payload that carries no tab rows of its own. */
export type WorkspaceTabOwnerCatalog = {
  tabsByWorktree?: Readonly<Record<string, readonly { id: string }[]>>
  unifiedTabsByWorktree?: Readonly<Record<string, readonly { id: string; worktreeId: string }[]>>
}

/** Payload tab rows outrank live catalogs: tab-keyed records must follow this debounced write’s rows, not newer store state. Fill only missing owners from live catalogs. */
export function extendWorktreeIdByTabId(
  byTab: Map<string, string>,
  catalog: WorkspaceTabOwnerCatalog | undefined
): Map<string, string> {
  for (const [worktreeId, tabs] of Object.entries(catalog?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, worktreeId)
      }
    }
  }
  // Same key-over-field rule as `buildWorktreeIdByTabId`: the record's key carries the host
  // prefix for a contested id, the tab's own `worktreeId` field never does.
  for (const [worktreeId, tabs] of Object.entries(catalog?.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, worktreeId)
      }
    }
  }
  return byTab
}

/** Resolve <tabId>:<leafId> through one index shared by host splitting and stranded-partition adoption. */
export function worktreeIdForPaneKey(
  worktreeIdByTabId: Map<string, string>,
  paneKey: string
): string | undefined {
  const separator = paneKey.lastIndexOf(':')
  return separator > 0 ? worktreeIdByTabId.get(paneKey.slice(0, separator)) : undefined
}

export function buildWorktreeIdByFileId(
  state: Partial<Pick<WorkspaceSessionState, 'openFilesByWorktree'>>
): Map<string, string> {
  const byFile = new Map<string, string>()
  // Why the record's key and not the entry's `worktreeId` field: a contested id is spelled
  // `host|id` in the unified session, and the key is what carries the host the split routes by —
  // the entry's field is the bare id. `buildWorktreeIdByTabId` already follows the key; every
  // consumer normalizes before comparing, so a bare partition's key is unchanged for them.
  for (const [worktreeId, files] of Object.entries(state.openFilesByWorktree ?? {})) {
    for (const file of files) {
      byFile.set(file.filePath, worktreeId)
    }
  }
  return byFile
}

export function mergeWorkspaceSessionRecordField(
  out: WorkspaceSessionRecord,
  field: keyof WorkspaceSessionState,
  slice: Partial<WorkspaceSessionState>
): void {
  const value = slice[field]
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the record field is created here, so it holds exactly what this merge assigns into it.
  const target = (out[field] ??= {}) as WorkspaceSessionRecord
  Object.assign(target, value)
}

export function mergeWorkspaceSessionArrayField(
  out: WorkspaceSessionRecord,
  field: keyof WorkspaceSessionState,
  slice: WorkspaceSessionState
): void {
  const value = slice[field]
  if (!Array.isArray(value)) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the array field is created here, so it holds exactly what this merge pushes into it.
  const target = (out[field] ??= []) as unknown[]
  target.push(...value)
}
