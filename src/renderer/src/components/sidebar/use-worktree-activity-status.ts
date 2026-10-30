import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'

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
  // The rows live under the SESSION ROW KEY: a contested id's tabs and agent
  // rows carry the host prefix, so a bare read showed the card no tabs at all
  // while the shared bare agent bucket painted one host's spinner on every
  // claimant's card. An uncontested id keeps the bare key byte-identically.
  const rowKey = useWorktreeSessionRowKey(worktreeId, executionHostId)
  const tabs = useAppStore((s) => s.tabsByWorktree[rowKey] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[rowKey] ?? EMPTY_BROWSER_TABS)
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, rowKey))
  )
  const ptyIdsForWorktree = useAppStore(useShallow((s) => selectLivePtyIdsForWorktree(s, rowKey)))
  const terminalLayoutRootsByTabId = useAppStore(
    useShallow((s) => selectTerminalLayoutRootsForWorktree(s, rowKey))
  )
  const {
    hasPermission,
    hasLiveWorking,
    hasLiveMonitoring,
    hasFailed,
    hasInterrupted,
    hasUnconfirmed,
    hasLiveDone,
    hasRetainedDone,
    hasRetainedFailed,
    agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId
  } = useAppStore(useShallow((s) => selectWorktreeAgentActivitySummary(s, rowKey)))

  // Why: compact and detailed cards need the same status-dot semantics:
  // runtime liveness gates title-derived states, then explicit agent rows can
  // promote working/permission/done so the dot matches visible agent state.
  return useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        ptyIdsByTabId: ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        agentStatusPaneIdsByTabId,
        stalePaneIdsByTabId,
        terminalLayoutRootsByTabId,
        hasPermission,
        hasLiveWorking,
        hasLiveMonitoring,
        hasFailed,
        hasInterrupted,
        hasUnconfirmed,
        hasLiveDone,
        hasRetainedDone,
        hasRetainedFailed
      }),
    [
      tabs,
      browserTabs,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId,
      terminalLayoutRootsByTabId,
      hasPermission,
      hasLiveWorking,
      hasLiveMonitoring,
      hasFailed,
      hasInterrupted,
      hasUnconfirmed,
      hasLiveDone,
      hasRetainedDone,
      hasRetainedFailed
    ]
  )
}
