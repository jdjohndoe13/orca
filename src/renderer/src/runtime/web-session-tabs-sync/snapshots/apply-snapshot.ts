import { agentSenderPublicationPatch } from '../../native-chat/agent-senders/agent-sender-publication-patch'
import { isWebSessionTabsWorktreeRemovalFrame } from '../tracking/session-tabs-inventory-absence'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { isHostQualifiableWorkspaceId } from '../../../../../shared/workspace-session-key-qualification'
import { hasContestedClaim } from '../../../../../shared/workspace-session-worktree-key'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  LOCAL_STRUCTURED_SESSION_OWNER,
  executionHostIdForSessionTabsOwner
} from '../../native-chat/local-sessions/local-structured-session-owner'
import { getContestedWorktreeIds } from '../../../store/slices/worktrees/listing/worktree-catalog-index'
import {
  foldWebSessionTabsRowsToBareView,
  rekeyWebSessionTabsPatchToHost
} from '../mirror-host-row-rekey'
import type {
  WebSessionTabsBatchContext,
  WebSessionTabsSnapshotApplyOptions,
  WebSessionTabsSyncState
} from '../state'
import { suppressE2eWebRuntimeBrowserSnapshot } from '../../browser/creation/testing/web-runtime-browser-creation-e2e-fault'
import { prepareWebSessionTabsSnapshotBase } from './apply-preparation-base'
import { prepareWebSessionTabsSnapshotBrowser } from './apply-preparation-browser'
import { prepareWebSessionTabsSnapshotUnified } from './apply-preparation-unified'
import { prepareWebSessionTabsSnapshotGroups } from './apply-preparation-groups'
import { applyTerminalRecordUpdates } from './apply-terminal-records'
import { applyBrowserRecordUpdates } from './apply-browser-records'
import { applyWorktreeRecordUpdates } from './apply-worktree-records'
import { applyActiveStateUpdates } from './apply-active-state'
import { buildWebSessionTabsFinalPatch } from './apply-final-patch'
import { isFrameDrawnServerWorkspace } from '../frame-drawn/frame-drawn-server-workspace-set'
import { buildFrameDrawnWorkspaceStatusPatch } from '../frame-drawn/frame-drawn-workspace-status-patch'
import { indexMirroredTerminalSurfaces } from '../terminal-handles/mirrored-terminal-handle-index'

export function applyWebSessionTabsSnapshotWithContext(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now(),
  batchContext?: WebSessionTabsBatchContext,
  options?: WebSessionTabsSnapshotApplyOptions
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  // Why: the floating panel is this machine's own, so only its local chat inventory may write it.
  const isLocalChatInventory =
    environmentId === LOCAL_STRUCTURED_SESSION_OWNER && options?.contentScope === 'agent-session'
  if (
    suppressE2eWebRuntimeBrowserSnapshot(rawSnapshot) ||
    (rawSnapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID && !isLocalChatInventory)
  ) {
    return state
  }
  // Received sender scopes were applied at receipt; a removal is no sender revision, so it drops
  // that worktree's scope only once the tab gates accept the frame that says so.
  const identityPatch = isWebSessionTabsWorktreeRemovalFrame(rawSnapshot)
    ? agentSenderPublicationPatch(
        { agentSenderPublicationsByHost: state.agentSenderPublicationsByHost ?? {} },
        environmentId === LOCAL_STRUCTURED_SESSION_OWNER ? 'local' : `runtime:${environmentId}`,
        rawSnapshot.worktree,
        undefined,
        true
      )
    : {}
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
      options,
      identityPatch
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
  return runWebSessionTabsPipeline(
    state,
    rawSnapshot,
    environmentId,
    now,
    batchContext,
    options,
    identityPatch
  )
}

function runWebSessionTabsPipeline(
  state: WebSessionTabsSyncState,
  rawSnapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number,
  batchContext: WebSessionTabsBatchContext | undefined,
  options: WebSessionTabsSnapshotApplyOptions | undefined,
  identityPatch: Partial<WebSessionTabsSyncState>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const worktreeId = rawSnapshot.worktree
  // Switch point: ORCA_LAYOUT_OWNER_IS_MAIN && — every mirror write (single, batch, operations) passes here.
  const previousSnapshotTabIds =
    ORCA_LAYOUT_OWNER_IS_MAIN && options?.contentScope !== 'agent-session'
      ? indexMirroredTerminalSurfaces(environmentId, rawSnapshot)
      : null
  const frameDrawnPreviousTabIds =
    previousSnapshotTabIds && isFrameDrawnServerWorkspace(environmentId, worktreeId)
      ? previousSnapshotTabIds
      : null
  if (frameDrawnPreviousTabIds) {
    // Server frames own tabs/IDs/focus and writes use server IDs; skip mirror intent ledgers for these workspaces.
    const patch = buildFrameDrawnWorkspaceStatusPatch(
      state,
      rawSnapshot,
      environmentId,
      worktreeId,
      frameDrawnPreviousTabIds,
      now,
      batchContext
    )
    return identityPatch.agentSenderPublicationsByHost ? { ...patch, ...identityPatch } : patch
  }
  // Interim (ledger L240): from here on only for a server without `layout.intents.v1`, until the
  // Phase 2 server cutoff retires the mirror's tab ids, close and focus intents.
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
  const patch = buildWebSessionTabsFinalPatch(activeState)
  return identityPatch.agentSenderPublicationsByHost ? { ...patch, ...identityPatch } : patch
}
