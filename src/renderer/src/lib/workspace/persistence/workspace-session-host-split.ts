import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { isWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey
} from '../../../../../shared/workspace-session-worktree-key'
import { splitHostForSessionKey } from '../../../../../shared/workspace-session-key-qualification'
import {
  GLOBAL_WORKSPACE_SESSION_FIELDS,
  hostPartitionSliceTemplate,
  WORKSPACE_SESSION_FIELD_OWNERSHIP
} from '../../../../../shared/workspace-session/workspace-session-host-field-ownership'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  isWorkspaceSessionRecord,
  worktreeIdForPaneKey,
  type WorkspaceSessionRecord
} from '../../../../../shared/workspace-session/workspace-session-host-records'

/** Partition unified renderer sessions by execution host for writes and merge on hydration. FIELD_OWNERSHIP exhaustively classifies fields at compile time, matching workspace-session’s relevant-field gate. */

export type HostSessionSlices = Partial<Record<ExecutionHostId, WorkspaceSessionState>>

export type HostIdByWorktreeId = (worktreeId: string) => ExecutionHostId

/** How a WorkspaceSessionState field is partitioned across hosts.
 *  - global: client-wide; always stays in the 'local' slice.
 *  - hostPrivate: main/runtime-owned; omitted from renderer merge and writes.
 *  - worktreeKeyed: Record keyed by worktree id; each entry goes to its owner.
 *  - worktreeArray: array of worktree ids; each id goes to its owner.
 *  - tabKeyed: Record keyed by tab id; follows the owning tab's worktree.
 *  - browserWorkspaceKeyed: Record keyed by browser-workspace id; follows the
 *    page record's own worktreeId.
 *  - fileKeyed: Record keyed by editor file id; follows the open file's worktree.
 *  - sleepingAgentKeyed: Record keyed by pane key; follows the record's worktreeId.
 *  - surfaceTombstoneKeyed: Record under an opaque key whose value names its own worktreeId --
 *    the only routing available once the tab or pane it describes is gone. */
type SplitContext = {
  hostIdByWorktreeId: HostIdByWorktreeId
  worktreeIdByTabId: Map<string, string>
  worktreeIdByFileId: Map<string, string>
}

/** Local retains all globals; other hosts receive only merge-readable subsets, preventing browserUrlHistory reinjection into every runtime (#18161). */
type SliceTemplates = {
  local: WorkspaceSessionState
  nonLocal: WorkspaceSessionState
}

function ensureSlice(
  slices: HostSessionSlices,
  hostId: ExecutionHostId,
  templates: SliceTemplates
): WorkspaceSessionState {
  let slice = slices[hostId]
  if (!slice) {
    // Copy allowed globals so isolated partitions retain active pointers; merged local values win.
    slice = { ...(hostId === LOCAL_EXECUTION_HOST_ID ? templates.local : templates.nonLocal) }
    slices[hostId] = slice
  }
  return slice
}

function assignWorktreeKeyed(
  slices: HostSessionSlices,
  templates: SliceTemplates,
  field: keyof WorkspaceSessionState,
  value: unknown,
  ctx: SplitContext
): void {
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  // Qualified ids that wrote into this field, per partition. A bare key (or the unknown-host
  // `|id` bucket) of the SAME id that would overwrite one of those slots is the pollution shape
  // (a controller that re-spelled late): the qualified row wins regardless of entry order. A
  // bare-only row still routes as before — the split cannot tell which claimant it belongs to.
  const qualifiedIdsByHost = new Map<ExecutionHostId, Set<string>>()
  for (const [key, entry] of Object.entries(value)) {
    // Why the key's own host wins: a contested id is spelled `host|id` in the unified session, and
    // the key already names the partition that row came from. `assignVisitRecencyByHost` routes the
    // same way for the one field that has always used the qualified spelling.
    const keyHost = getExecutionHostIdFromSessionKey(key)
    const host = keyHost ?? ctx.hostIdByWorktreeId(key)
    const worktreeId = getWorkspaceIdFromSessionKey(key)
    if (keyHost !== null) {
      const qualified = qualifiedIdsByHost.get(host)
      if (qualified) {
        qualified.add(worktreeId)
      } else {
        qualifiedIdsByHost.set(host, new Set([worktreeId]))
      }
    } else if (qualifiedIdsByHost.get(host)?.has(worktreeId)) {
      continue
    }
    const slice = ensureSlice(slices, host, templates) as WorkspaceSessionRecord
    const target = (slice[field] ??= {}) as WorkspaceSessionRecord
    // The prefix is stripped on the way in, so every partition keeps the bare id it has always
    // stored — the disk format does not change, and no migration is needed.
    target[worktreeId] = entry
  }
}

function assignVisitRecencyByHost(
  slices: HostSessionSlices,
  templates: SliceTemplates,
  value: unknown,
  ctx: SplitContext
): void {
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    // Host-qualified recency keys already identify ownership; routing elsewhere separates visits from their workspace.
    const qualifiedHost = isWorktreeHostIdentity(key)
      ? parseExecutionHostId(key.slice(0, key.indexOf('|')))
      : null
    const host = isWorktreeHostIdentity(key)
      ? (qualifiedHost?.id ?? LOCAL_EXECUTION_HOST_ID)
      : ctx.hostIdByWorktreeId(key)
    const slice = ensureSlice(slices, host, templates) as WorkspaceSessionRecord
    const target = (slice.lastVisitedAtByWorktreeId ??= {}) as WorkspaceSessionRecord
    target[key] = entry
  }
}

function assignKeyedByResolvedWorktree(
  slices: HostSessionSlices,
  templates: SliceTemplates,
  field: keyof WorkspaceSessionState,
  value: unknown,
  resolveWorktreeId: (key: string, entry: unknown) => string | undefined,
  ctx: SplitContext
): void {
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    const worktreeId = resolveWorktreeId(key, entry)
    // The owning worktree's row may be host-qualified now, so the host comes off the key it carries
    // and the bare id is what the catalog is asked about. The row's own key is untouched: tab-,
    // file- and pane-keyed records follow their owner, they are not re-keyed with it.
    const host =
      worktreeId === undefined
        ? LOCAL_EXECUTION_HOST_ID
        : splitHostForSessionKey(worktreeId, ctx.hostIdByWorktreeId)
    const slice = ensureSlice(slices, host, templates) as WorkspaceSessionRecord
    const target = (slice[field] ??= {}) as WorkspaceSessionRecord
    target[key] = entry
  }
}

/** Route unified entries by workspace owner, with globals local. Unknown orphan tabs/files/pages stay local rather than disappearing; worktreeIdByTabId supplies partial-payload routing. */
export function splitWorkspaceSessionByHost(
  state: WorkspaceSessionState,
  hostIdByWorktreeId: HostIdByWorktreeId,
  options: {
    worktreeIdByTabId?: Map<string, string>
    /** Hosts whose rows this write speaks for in full: a field it carries replaces theirs even when
     *  none of their workspaces has an entry left, or main's fieldwise patch keeps the stale rows (#23914). */
    emptyContainerHostIds?: readonly ExecutionHostId[]
  } = {}
): HostSessionSlices {
  // Copy only present global own-keys: partial patches must not inject undefined over absent fields; explicit undefined remains intentional.
  const template = {} as WorkspaceSessionState
  for (const field of GLOBAL_WORKSPACE_SESSION_FIELDS) {
    if (Object.hasOwn(state, field)) {
      ;(template as WorkspaceSessionRecord)[field] = state[field]
    }
  }

  const templates: SliceTemplates = {
    local: template,
    nonLocal: hostPartitionSliceTemplate(template)
  }

  const slices: HostSessionSlices = {}
  // Always include local, the global/hydration anchor even when all workspaces are remote.
  ensureSlice(slices, LOCAL_EXECUTION_HOST_ID, templates)

  const ctx: SplitContext = {
    hostIdByWorktreeId,
    worktreeIdByTabId: options.worktreeIdByTabId ?? buildWorktreeIdByTabId(state),
    worktreeIdByFileId: buildWorktreeIdByFileId(state)
  }

  const localSlice = slices[LOCAL_EXECUTION_HOST_ID] as WorkspaceSessionRecord

  for (const field of Object.keys(
    WORKSPACE_SESSION_FIELD_OWNERSHIP
  ) as (keyof WorkspaceSessionState)[]) {
    const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    const value = state[field]
    if (value === undefined) {
      continue
    }
    // Seed explicit empty containers locally so merge preserves their presence.
    if (ownership !== 'global' && ownership !== 'hostPrivate') {
      localSlice[field] ??= Array.isArray(value) ? [] : {}
      for (const hostId of options.emptyContainerHostIds ?? []) {
        const slice = ensureSlice(slices, hostId, templates)
        Object.assign(slice, { [field]: slice[field] ?? (Array.isArray(value) ? [] : {}) })
      }
    }
    switch (ownership) {
      case 'global':
        break
      case 'hostPrivate':
        // Main preserves this field while rebasing renderer writes onto host authority.
        break
      case 'worktreeKeyed':
        if (field === 'lastVisitedAtByWorktreeId') {
          assignVisitRecencyByHost(slices, templates, value, ctx)
        } else {
          assignWorktreeKeyed(slices, templates, field, value, ctx)
        }
        break
      case 'worktreeArray': {
        if (!Array.isArray(value)) {
          break
        }
        for (const worktreeId of value as string[]) {
          const host = splitHostForSessionKey(worktreeId, ctx.hostIdByWorktreeId)
          const slice = ensureSlice(slices, host, templates) as WorkspaceSessionRecord
          const target = (slice[field] ??= []) as string[]
          // Main reads this list as worktree ids, so the host prefix is stripped here too.
          target.push(getWorkspaceIdFromSessionKey(worktreeId))
        }
        break
      }
      case 'tabKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          templates,
          field,
          value,
          (tabId) => ctx.worktreeIdByTabId.get(tabId),
          ctx
        )
        break
      case 'fileKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          templates,
          field,
          value,
          (fileId) => ctx.worktreeIdByFileId.get(fileId),
          ctx
        )
        break
      case 'browserWorkspaceKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          templates,
          field,
          value,
          (_workspaceId, pages) => {
            const first = Array.isArray(pages)
              ? (pages[0] as { worktreeId?: string } | undefined)
              : undefined
            return first?.worktreeId
          },
          ctx
        )
        break
      case 'paneKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          templates,
          field,
          value,
          (paneKey) => worktreeIdForPaneKey(ctx.worktreeIdByTabId, paneKey),
          ctx
        )
        break
      case 'sleepingAgentKeyed':
      case 'surfaceTombstoneKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          templates,
          field,
          value,
          (_paneKey, record) =>
            isWorkspaceSessionRecord(record) && typeof record.worktreeId === 'string'
              ? record.worktreeId
              : undefined,
          ctx
        )
        break
    }
  }

  return slices
}

export function nonLocalHostSessionEntries(
  slices: HostSessionSlices
): [ExecutionHostId, WorkspaceSessionState][] {
  return (Object.entries(slices) as [ExecutionHostId, WorkspaceSessionState][]).filter(
    ([hostId, slice]) => hostId !== LOCAL_EXECUTION_HOST_ID && slice !== undefined
  )
}

// The merge half of this split lives in `workspace-session-host-merge.ts`.
