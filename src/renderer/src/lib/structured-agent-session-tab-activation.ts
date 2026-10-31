import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { useAppStore } from '@/store'
import { readWorkspaceSessionRecord } from '@/store/workspace-session-key'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'

/**
 * The structured-chat row lives under the workspace's SESSION ROW KEY (`host|id` for a contested
 * id, STA-4343), never the bare id. The caller's explicit host wins; otherwise the store's own
 * evidence (the active workspace's stamp, the catalog) resolves it — and a contested id whose
 * host cannot be named is a deliberate miss, not a fallback to the bare key.
 */
export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: {
    workspaceId: string
    sessionId: string
    executionHostId?: ExecutionHostId | null
  }
): Tab | null {
  const row = readWorkspaceSessionRecord(
    useAppStore.getState(),
    unifiedTabsByWorktree,
    args.workspaceId,
    args.executionHostId
  )
  return (
    (row?.entry ?? []).find(
      (candidate) =>
        candidate.worktreeId === args.workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId
    ) ?? null
  )
}

/**
 * The environment the session's host answers to, or null when the caller named no host and the
 * worktree's own route should be consulted. A structured chat only exists on a runtime host, so
 * an explicit `runtime:<env>` names it outright and any other host names the local one (null).
 */
export function getRuntimeEnvironmentIdForStructuredSessionTarget(
  state: Parameters<typeof getRuntimeEnvironmentIdForWorktree>[0],
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string | null {
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.environmentId : null
  }
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
  executionHostId?: ExecutionHostId | null
}): boolean {
  const state = useAppStore.getState()
  const row = readWorkspaceSessionRecord(
    state,
    state.unifiedTabsByWorktree,
    args.worktreeId,
    args.executionHostId
  )
  const tab = (row?.entry ?? []).find(
    (candidate) => candidate.id === args.tabId && candidate.contentType === 'agent-session'
  )
  if (!tab) {
    return false
  }
  // The store actions below resolve the row key themselves from the same state; the runtime
  // selector stays the BARE id because the host indexes its own session tabs by it.
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType('agent-session', args.worktreeId)
  const environmentId = getRuntimeEnvironmentIdForStructuredSessionTarget(
    state,
    args.worktreeId,
    args.executionHostId
  )
  void callRuntimeRpc(
    getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: `agent-session:${tab.entityId}`
    }
  )
  return true
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
  executionHostId?: ExecutionHostId | null
}): boolean {
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: args.worktreeId,
    sessionId: args.sessionId,
    executionHostId: args.executionHostId
  })
  return tab
    ? activateStructuredAgentSessionTab({
        worktreeId: args.worktreeId,
        tabId: tab.id,
        executionHostId: args.executionHostId
      })
    : false
}
