import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { hasAwakeStructuredChat } from '@/store/slices/agent-status/structured-sessions/structured-chat-slept-at'
import { resolveWorktreeStatusParts } from '@/lib/workspace/activity/worktree-status'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './worktree-card-empty-inputs'
import {
  selectLivePtyIdsForWorktree,
  selectPaneForegroundAgentsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { selectStoppedWslDistro } from '@/runtime/hosts/wsl/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../../../../lib/workspace/ownership/workspace-runtime-environment'
import { parseRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

/** The Start card's rule: a pane with no server yet, or on the stopped one, ended with its distro. */
function withoutStoppedHostPtys(
  ptyIdsByTabId: Record<string, string[]>,
  stoppedEnvironmentId: string
): Record<string, string[]> {
  const live: Record<string, string[]> = {}
  for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
    const kept = ptyIds.filter((ptyId) => {
      const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
      return environmentId != null && environmentId !== stoppedEnvironmentId
    })
    if (kept.length > 0) {
      live[tabId] = kept.length === ptyIds.length ? ptyIds : kept
    }
  }
  return live
}

// Why the cheap check first: every card's selector runs on each store update, and few hosts stop.
function hasStoppedWslHost(state: {
  wslHostStatuses?: Record<string, { state: string }>
}): boolean {
  for (const id in state.wslHostStatuses) {
    if (state.wslHostStatuses[id]?.state === 'distro-stopped') {
      return true
    }
  }
  return false
}

function selectStoppedWorktreeEnvironmentId(state: AppState, worktreeId: string): string | null {
  if (!hasStoppedWslHost(state)) {
    return null
  }
  const owner = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  return owner && selectStoppedWslDistro(state, owner) !== null ? owner : null
}

type StatusMemo = {
  inputs: readonly unknown[]
  status: WorktreeStatus
  /** The terminal-title status before explicit agent rows rank over it. */
  titleStatus: WorktreeStatus
}

// Carry only the workspaces read in the previous snapshot, regardless of how many were visible.
let generation: {
  state: AppState
  byWorktreeId: Map<string, StatusMemo>
  carried: ReadonlyMap<string, StatusMemo> | undefined
} | null = null

export function selectWorktreeActivityStatus(
  statusInputs: AppState,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): WorktreeStatus {
  if (generation?.state !== statusInputs) {
    generation = {
      state: statusInputs,
      byWorktreeId: new Map(),
      carried: generation?.byWorktreeId
    }
  }
  // Why the row key (STA-4343): a contested id's rows live under `host|id`, so
  // reading by the bare id would show the co-claimant's tabs and agent rows.
  // An uncontested id keeps the bare key byte-identically.
  const rowKey = resolveWorkspaceSessionKey(statusInputs, worktreeId, hostId)
  const { byWorktreeId, carried } = generation
  let memo = byWorktreeId.get(rowKey)
  if (memo === undefined) {
    memo = resolveMemoizedStatus(statusInputs, rowKey, carried?.get(rowKey))
    byWorktreeId.set(rowKey, memo)
  }
  return memo.status
}

/** What a workspace's terminal titles say before explicit agent rows rank over them: a failed hook on one
 *  pane outranks another tab's working title for the dot, but the work is still there. Same memo. */
export function selectWorktreeTitleActivityStatus(
  statusInputs: AppState,
  worktreeId: string
): WorktreeStatus {
  selectWorktreeActivityStatus(statusInputs, worktreeId)
  return generation!.byWorktreeId.get(worktreeId)!.titleStatus
}

function resolveMemoizedStatus(
  statusInputs: AppState,
  worktreeId: string,
  memo: StatusMemo | undefined
): StatusMemo {
  const summary = selectWorktreeAgentActivitySummary(statusInputs, worktreeId)
  const inputs = [
    statusInputs.tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    statusInputs.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    hasAwakeStructuredChat(
      statusInputs.unifiedTabsByWorktree[worktreeId],
      statusInputs.structuredChatSleptAtByPaneKey
    ),
    selectLivePtyIdsForWorktree(statusInputs, worktreeId),
    selectStoppedWorktreeEnvironmentId(statusInputs, worktreeId),
    selectRuntimePaneTitlesForWorktree(statusInputs, worktreeId),
    selectTerminalLayoutRootsForWorktree(statusInputs, worktreeId),
    selectPaneForegroundAgentsForWorktree(statusInputs, worktreeId),
    summary
  ] as const
  if (memo && inputs.every((input, index) => input === memo.inputs[index])) {
    return memo
  }
  const [
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
    stoppedEnvironmentId,
    runtimePaneTitlesByTabId,
    terminalLayoutRootsByTabId,
    paneForegroundAgentByPaneKey
  ] = inputs
  const { status, heuristic } = resolveWorktreeStatusParts({
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId: stoppedEnvironmentId
      ? withoutStoppedHostPtys(ptyIdsByTabId, stoppedEnvironmentId)
      : ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    agentStatusPaneIdsByTabId: summary.agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId: summary.stalePaneIdsByTabId,
    terminalLayoutRootsByTabId,
    paneForegroundAgentByPaneKey,
    hasPermission: summary.hasPermission,
    hasLiveWorking: summary.hasLiveWorking,
    hasLiveMonitoring: summary.hasLiveMonitoring,
    hasFailed: summary.hasFailed,
    hasInterrupted: summary.hasInterrupted,
    hasUnconfirmed: summary.hasUnconfirmed,
    hasLiveDone: summary.hasLiveDone
  })
  return { inputs, status, titleStatus: heuristic }
}

/**
 * The row key subscription (STA-4343): the contested set flips while the app
 * runs (a second host registers the path, or one drops out), so every read
 * below must move to the new key on the same publication — the same rule the
 * sidebar's inline agent rows follow (`useWorktreeAgentRows`).
 */
export function useWorktreeSessionRowKey(
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string {
  return useAppStore((s) => resolveWorkspaceSessionKey(s, worktreeId, executionHostId))
}

export function useWorktreeActivityStatus(
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): WorktreeStatus {
  return useAppStore((state) => selectWorktreeActivityStatus(state, worktreeId, executionHostId))
}
