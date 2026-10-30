import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore, type AppState } from '@/store'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'

type WorktreeActivityStatusState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'browserTabsByWorktree'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'agentStatusEpoch'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'worktreesByRepo'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
>

/** One candidate row; `hostId` is the row's own host (STA-4343). */
export type WorktreeActivityStatusRow = {
  id: string
  hostId?: ExecutionHostId | null
}

/**
 * Statuses for a batch of candidate rows, keyed by the row's SESSION ROW KEY
 * (STA-4343) — read each row back with the same `workspaceSessionKey` the
 * caller used to name it.
 *
 * Why the row key: a contested id's rows live under `host|id`, so reading by
 * the bare id would show the co-claimant's tabs and agent rows — and the
 * candidate list carries one row per host, so keying by the bare id would
 * collapse both claimants onto one status.
 */
export function selectWorktreeActivityStatuses(
  statusInputs: WorktreeActivityStatusState,
  rows: readonly (string | WorktreeActivityStatusRow)[]
): Map<string, WorktreeStatus> {
  const statuses = new Map<string, WorktreeStatus>()
  for (const row of rows) {
    const worktreeId = typeof row === 'string' ? row : row.id
    const hostId = typeof row === 'string' ? undefined : row.hostId
    const rowKey = resolveWorkspaceSessionKey(statusInputs, worktreeId, hostId)
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
    } = selectWorktreeAgentActivitySummary(statusInputs, rowKey)
    statuses.set(
      rowKey,
      resolveWorktreeStatus({
        tabs: statusInputs.tabsByWorktree[rowKey] ?? EMPTY_TABS,
        browserTabs: statusInputs.browserTabsByWorktree[rowKey] ?? EMPTY_BROWSER_TABS,
        ptyIdsByTabId: selectLivePtyIdsForWorktree(statusInputs, rowKey),
        runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(statusInputs, rowKey),
        agentStatusPaneIdsByTabId,
        stalePaneIdsByTabId,
        terminalLayoutRootsByTabId: selectTerminalLayoutRootsForWorktree(statusInputs, rowKey),
        hasPermission,
        hasLiveWorking,
        hasLiveMonitoring,
        hasFailed,
        hasInterrupted,
        hasUnconfirmed,
        hasLiveDone,
        hasRetainedDone,
        hasRetainedFailed
      })
    )
  }
  return statuses
}

// Why: return a shallow-stable status map so terminal updates outside the
// visible candidates do not re-render the picker.
export function useWorktreeActivityStatuses(
  rows: readonly (string | WorktreeActivityStatusRow)[]
): Map<string, WorktreeStatus> {
  const selectStatuses = useCallback(
    (state: WorktreeActivityStatusState) => selectWorktreeActivityStatuses(state, rows),
    [rows]
  )
  return useAppStore(useShallow(selectStatuses))
}

/**
 * The row keys `selectWorktreeActivityStatuses` keyed its map by, one per
 * caller row, in order (useShallow keeps the array identity stable).
 */
export function useWorktreeActivityRowKeys(
  rows: readonly (string | WorktreeActivityStatusRow)[]
): readonly string[] {
  return useAppStore(
    useShallow((state) =>
      rows.map((row) =>
        typeof row === 'string'
          ? resolveWorkspaceSessionKey(state, row)
          : resolveWorkspaceSessionKey(state, row.id, row.hostId)
      )
    )
  )
}
