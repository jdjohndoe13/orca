import { useAppStateView, useAppStateViewActive } from '@/store/retained-views/app-state-view'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { useAppStore } from '@/store/index'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  createWorktreeAgentRowsSelector,
  EMPTY_AGENT_ROWS,
  getSharedWorktreeAgentRowsSelector
} from './worktree-agent-rows-projection'

const subscribeToNothing = (): (() => void) => () => {}

export function useAgentPresentation<T>(
  channel: string,
  read: (projection: AgentStatusProjection) => T,
  active = true
): T {
  const store = useAppStateView()
  const projection = useStore(store, (state) => state.agentStatusByPaneKey.projection)
  const subscribe = useCallback(
    (listener: () => void) => projection.subscribe(channel, listener),
    [projection, channel]
  )
  const snapshot = useCallback(() => read(projection), [projection, read])
  return useSyncExternalStore(active ? subscribe : subscribeToNothing, snapshot, snapshot)
}

/**
 * The row key (STA-4343) the projection files this workspace's rows under.
 *
 * Why the row key and not the bare id: the projection derives a row's owner from
 * `tabsByWorktree`, whose record key is the session row key, so a contested id's
 * rows are bucketed under `host|id` — reading the bare id would show the card
 * nothing. An uncontested id keeps the bare key byte-identically, and the
 * contested set flips while the app runs, so this is a subscription, not a read.
 */
export function useWorktreeAgentRowKey(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): string {
  return useAppStore((s) => resolveWorkspaceSessionKey(s, worktreeId, hostId))
}

/** Full output is materialized only for callers that consume the actual list. */
export function useWorktreeAgentRows(
  worktreeId: string,
  active = true,
  hostId?: ExecutionHostId
): DashboardAgentRow[] {
  const store = useAppStateView()
  const rowKey = useWorktreeAgentRowKey(worktreeId, hostId)
  // Live reads share the rollup's selector; a retained view's frozen state keeps its own memo.
  const live = useAppStateViewActive()
  const selectRows = useMemo(
    () =>
      live
        ? getSharedWorktreeAgentRowsSelector(rowKey, hostId)
        : createWorktreeAgentRowsSelector(rowKey, hostId),
    [live, rowKey, hostId]
  )
  const getRows = useCallback(
    () => (active ? selectRows(store.getState()) : EMPTY_AGENT_ROWS),
    [active, selectRows, store]
  )
  const rows = useAgentPresentation(`list\0${rowKey}`, getRows, active)
  // Host attribution also reads layouts, PTYs and ownership the workspace channel does not carry.
  const hostRows = useSyncExternalStore(
    active && hostId ? store.subscribe : subscribeToNothing,
    getRows,
    getRows
  )
  return hostId ? hostRows : rows
}
export function useWorktreeAgentRow(paneKey: string): DashboardAgentRow | undefined {
  return useAgentPresentation(
    `row\0${paneKey}`,
    useCallback((p) => p.row(paneKey), [paneKey])
  )
}
