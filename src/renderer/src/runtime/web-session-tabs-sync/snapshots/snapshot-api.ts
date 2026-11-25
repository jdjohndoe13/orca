import { publishPresentationRecords } from './presentation-record-drafts'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isHostQualifiableWorkspaceId } from '../../../../../shared/workspace-session-key-qualification'
import { hasContestedClaim } from '../../../../../shared/workspace-session-worktree-key'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState
} from '../state'
import { executionHostIdForSessionTabsOwner } from '@/runtime/native-chat/local-sessions/local-structured-session-owner'
import { getContestedWorktreeIds } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  foldWebSessionTabsRowsToBareView,
  rekeyWebSessionTabsPatchToHost
} from '../mirror-host-row-rekey'
import { applyWebSessionTabsSnapshotWithContext } from './apply-snapshot'
import {
  decideWebSessionTabsSnapshot,
  shouldApplyWebSessionTabsSnapshot,
  type WebSessionTabsSnapshotDecision
} from '../tracking/tracking-decisions'

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  options?: WebSessionTabsSnapshotApplyOptions,
  changedAgentPaneKeys?: Set<string>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (changedAgentPaneKeys) {
    return applyWebSessionTabsSnapshots(
      state,
      [snapshot],
      environmentId,
      now,
      changedAgentPaneKeys,
      options
    )
  }
  return applyWebSessionTabsSnapshotWithContext(
    state,
    snapshot,
    environmentId,
    now,
    undefined,
    options
  )
}

export function createWebSessionTabsSnapshotPatch(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
) {
  return (state: WebSessionTabsSyncState, keys: Set<string>) =>
    applyWebSessionTabsSnapshot(state, snapshot, environmentId, undefined, undefined, keys)
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now(),
  changedAgentPaneKeys?: Set<string>,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  // Why the fold happens here rather than per frame: the batch mutates its record copies in
  // place on the state object it owns, so the fold must be the object the loop runs on. The
  // merged patch (bare, the host's spelling) is re-spelled to the host's key at the end — the
  // single-frame wrapper is the same mechanism for one frame (see `apply-snapshot.ts`).
  const contested = getContestedWorktreeIds(selectWorktreesByRepo(state))
  const batchIds = new Set(
    snapshots
      .map((snapshot) => snapshot.worktree)
      .filter((id) => hasContestedClaim(contested, id) && isHostQualifiableWorkspaceId(id))
  )
  const hostId = executionHostIdForSessionTabsOwner(environmentId)
  const view =
    batchIds.size === 0
      ? state
      : foldWebSessionTabsRowsToBareView(state, batchIds, hostId, contested)
  const nextState = { ...view }
  const batchContext: WebSessionTabsBatchContext = {
    changedAgentPaneKeys,
    changedRecords: new Set(),
    openFilesIndex: null
  }
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const snapshot of snapshots) {
    const patch = applyWebSessionTabsSnapshotWithContext(
      nextState,
      snapshot,
      environmentId,
      now,
      batchContext,
      options
    )
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    Object.assign(nextState, patch)
  }
  const mutableMergedPatch = mergedPatch as Record<string, unknown>
  const mutableNextState = nextState as unknown as Record<string, unknown>
  for (const recordKey of batchContext.changedRecords) {
    mutableMergedPatch[recordKey] = mutableNextState[recordKey]
  }
  publishPresentationRecords(batchContext, mergedPatch)
  const noOp = Object.keys(mergedPatch).length === 0
  if (batchIds.size === 0) {
    return noOp ? state : mergedPatch
  }
  // The no-op still owes the tombstone when the real store holds a bare row for a contested
  // id; the rekey turns it into a real patch or returns the real `state` (never the folded view).
  return rekeyWebSessionTabsPatchToHost(
    state,
    noOp ? state : mergedPatch,
    batchIds,
    hostId,
    contested
  )
}

export function applyFreshWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  return shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
    ? applyWebSessionTabsSnapshot(state, snapshot, environmentId, now)
    : state
}

export function applyFreshWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const fresh = snapshots.filter((snapshot) =>
    shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
  )
  return fresh.length === 0 ? state : applyWebSessionTabsSnapshots(state, fresh, environmentId, now)
}

export type WebSessionTabsSnapshotOperation = {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  runtimeId?: string
}

export type DecidedWebSessionTabsSnapshotOperation = WebSessionTabsSnapshotOperation & {
  decision: WebSessionTabsSnapshotDecision
}

export function decideWebSessionTabsSnapshotOperations(
  operations: readonly WebSessionTabsSnapshotOperation[]
): DecidedWebSessionTabsSnapshotOperation[] {
  return operations.map((operation) => ({
    ...operation,
    decision: decideWebSessionTabsSnapshot(
      operation.snapshot,
      operation.environmentId,
      operation.runtimeId
    )
  }))
}

export function applyWebSessionTabsSnapshotOperations(
  state: WebSessionTabsSyncState,
  operations: readonly DecidedWebSessionTabsSnapshotOperation[],
  changedAgentPaneKeys?: Set<string>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  let nextState = state
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const { environmentId, snapshot, decision } of operations) {
    if (!decision.apply) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(
      nextState,
      snapshot,
      environmentId,
      undefined,
      undefined,
      changedAgentPaneKeys
    )
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    nextState = { ...nextState, ...patch }
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}
