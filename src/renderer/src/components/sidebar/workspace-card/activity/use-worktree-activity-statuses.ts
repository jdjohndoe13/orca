import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { selectWorktreeActivityStatus } from './use-worktree-activity-status'

/** One candidate row; `hostId` is the row's own host (STA-4343). */
export type WorktreeActivityStatusRow = {
  id: string
  hostId?: ExecutionHostId | null
}

function rowKeyFor(state: AppState, row: string | WorktreeActivityStatusRow): string {
  return typeof row === 'string'
    ? resolveWorkspaceSessionKey(state, row)
    : resolveWorkspaceSessionKey(state, row.id, row.hostId)
}

function statusFor(state: AppState, row: string | WorktreeActivityStatusRow): WorktreeStatus {
  return typeof row === 'string'
    ? selectWorktreeActivityStatus(state, row)
    : selectWorktreeActivityStatus(state, row.id, row.hostId)
}

// Why the row key (STA-4343): a contested id's rows live under `host|id`, so
// reading by the bare id would show the co-claimant's tabs and agent rows —
// and the candidate list carries one row per host, so keying by the bare id
// would collapse both claimants onto one status. The map is rebuilt per call
// because the contested set flips while the app runs and row keys move with
// it; a carried-over map would keep stale keys. `useShallow` keeps the map
// stable across writes when the per-row statuses do not change.
export function selectWorktreeActivityStatuses(
  statusInputs: AppState,
  worktreeIds: readonly (string | WorktreeActivityStatusRow)[]
): Map<string, WorktreeStatus> {
  const statuses = new Map<string, WorktreeStatus>()
  for (const row of worktreeIds) {
    statuses.set(rowKeyFor(statusInputs, row), statusFor(statusInputs, row))
  }
  return statuses
}

// Keep equal status maps stable so unrelated terminal updates do not rerender the picker.
export function useWorktreeActivityStatuses(
  worktreeIds: readonly (string | WorktreeActivityStatusRow)[]
): Map<string, WorktreeStatus> {
  const selectStatuses = useMemo(
    () => (state: AppState) => selectWorktreeActivityStatuses(state, worktreeIds),
    [worktreeIds]
  )
  return useAppStore(useShallow(selectStatuses))
}

/**
 * The row keys `selectWorktreeActivityStatuses` keyed its map by, one per
 * caller row, in order (useShallow keeps the array identity stable).
 */
export function useWorktreeActivityRowKeys(
  worktreeIds: readonly (string | WorktreeActivityStatusRow)[]
): readonly string[] {
  return useAppStore(
    useShallow((state) =>
      worktreeIds.map((row) =>
        typeof row === 'string'
          ? resolveWorkspaceSessionKey(state, row)
          : resolveWorkspaceSessionKey(state, row.id, row.hostId)
      )
    )
  )
}
