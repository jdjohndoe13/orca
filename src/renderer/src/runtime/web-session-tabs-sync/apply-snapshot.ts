import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { isHostQualifiableWorkspaceId } from '../../../../shared/workspace-session-key-qualification'
import { hasContestedClaim } from '../../../../shared/workspace-session-worktree-key'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState
} from './state'
import { suppressE2eWebRuntimeBrowserSnapshot } from '../web-runtime-browser-creation-e2e-fault'
import { executionHostIdForSessionTabsOwner } from '../local-structured-session-owner'
import { getContestedWorktreeIds } from '../../store/worktree-repo-index'
import {
  foldWebSessionTabsRowsToBareView,
  rekeyWebSessionTabsPatchToHost
} from './mirror-host-row-rekey'
import { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import { prepareWebSessionTabsSnapshotBrowser } from './apply-preparation-browser'
import { prepareWebSessionTabsSnapshotUnified } from './apply-preparation-unified'
import { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { applyTerminalRecordUpdates } from './apply-terminal-records'
import { applyBrowserRecordUpdates } from './apply-browser-records'
import { applyWorktreeRecordUpdates } from './apply-worktree-records'
import { applyActiveStateUpdates } from './apply-active-state'
import { buildWebSessionTabsFinalPatch } from './apply-final-patch'

/** Reconcile one host frame through the staged terminal/browser/layout pipeline. */
export function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (
    suppressE2eWebRuntimeBrowserSnapshot(rawSnapshot) ||
    rawSnapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID
  ) {
    return state
  }
  const worktreeId = rawSnapshot.worktree
  const contested = getContestedWorktreeIds(state.worktreesByRepo)
  // Why the batchContext gate: a batch mutates its record copies in place on the state it
  // owns, so `applyWebSessionTabsSnapshots` folds once and re-keys the merged patch itself;
  // folding inside a batch frame would strand those mutations on the folded copy.
  if (
    !batchContext &&
    hasContestedClaim(contested, worktreeId) &&
    isHostQualifiableWorkspaceId(worktreeId)
  ) {
    // Why: a contested id (one repo on several hosts, STA-4343) must only ever hold the
    // `host|id` spelling in the unified store — a bare row routes to the persistence split's
    // pinned primary and collides last-wins into that partition's bucket (the identical
    // child-tabs defect). The pipeline runs in the host's own bare spelling (the direct-SSH
    // twin), then the patch's record keys are re-spelled to the host's key on the way out.
    const hostId = executionHostIdForSessionTabsOwner(environmentId)
    const folded = foldWebSessionTabsRowsToBareView(state, new Set([worktreeId]), hostId, contested)
    const patch = runWebSessionTabsPipeline(
      folded,
      rawSnapshot,
      environmentId,
      now,
      batchContext,
      options
    )
    // The no-op returns the folded view; the caller must see the real state (or the tombstone).
    const effectivePatch = patch === folded ? state : patch
    return rekeyWebSessionTabsPatchToHost(
      state,
      effectivePatch,
      new Set([worktreeId]),
      hostId,
      contested
    )
  }
  return runWebSessionTabsPipeline(state, rawSnapshot, environmentId, now, batchContext, options)
}

function runWebSessionTabsPipeline(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number,
  batchContext: WebSessionTabsBatchContext | undefined,
  options: WebSessionTabsSnapshotApplyOptions | undefined
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const worktreeId = rawSnapshot.worktree
  const base = prepareWebSessionTabsSnapshotBase(
    state,
    rawSnapshot,
    environmentId,
    worktreeId,
    now,
    batchContext,
    options
  )
  const browser = prepareWebSessionTabsSnapshotBrowser(base)
  const unified = prepareWebSessionTabsSnapshotUnified(browser)
  const groups = prepareWebSessionTabsSnapshotGroups(unified)
  const terminalRecords = applyTerminalRecordUpdates(groups)
  const browserRecords = applyBrowserRecordUpdates(terminalRecords)
  const worktreeRecords = applyWorktreeRecordUpdates(browserRecords)
  const activeState = applyActiveStateUpdates(worktreeRecords)
  return buildWebSessionTabsFinalPatch(activeState)
}
