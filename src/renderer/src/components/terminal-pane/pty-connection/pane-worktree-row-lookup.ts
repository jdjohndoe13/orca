import { useAppStore } from '@/store'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import {
  resolveWorkspaceRowKey,
  type WorkspaceSessionRowState
} from '../../terminal-workspace-session-row'

export type { WorkspaceSessionRowState } from '../../terminal-workspace-session-row'

/**
 * The `tabsByWorktree` row a pane's own reads must use.
 *
 * The pane receives the BARE worktreeId, and a contested id's rows (one repo path published by
 * several paired hosts, STA-4343) live under `host|id` — so a bare read either misses or hits the
 * other host's row, and the remounted pane then attaches its xterm to the other host's dead pty
 * (the black panel). The overlay layer resolves the row with `resolveWorkspaceRowKey` and mounts a
 * pane only for the row it resolved, so the pane's reads go through the SAME accessor: whatever the
 * overlay painted is exactly the row the pane reads. An uncontested id resolves to the bare key,
 * byte-identical to the pre-contention read.
 *
 * The row key is for bucket lookups only — anything that crosses the wire or is byte-compared by a
 * host (folder ids, PTY env, spawn targets) keeps the bare worktreeId.
 */

/** The key a pane's row lives under — the same key the overlay layer mounted it from. */
export function resolvePaneWorktreeRowKey(
  state: WorkspaceSessionRowState,
  worktreeId: string
): string {
  return resolveWorkspaceRowKey(state, worktreeId)
}

/** The row a pane reads for its own tab, from a snapshot the caller already holds. */
export function findPaneWorktreeRowForState<T extends { id: string }>(
  state: WorkspaceSessionRowState,
  tabsByWorktree: Readonly<Record<string, readonly T[] | undefined>>,
  worktreeId: string
): readonly T[] | undefined {
  return tabsByWorktree[resolvePaneWorktreeRowKey(state, worktreeId)]
}

/** The row a pane reads for its own tab, from the store's current state. */
export function findPaneWorktreeRowFromStore<T extends { id: string }>(
  tabsByWorktree: Readonly<Record<string, readonly T[] | undefined>>,
  worktreeId: string
): readonly T[] | undefined {
  return findPaneWorktreeRowForState(useAppStore.getState(), tabsByWorktree, worktreeId)
}

/** The tab a pane is the render of, read from its own row. */
export function findPaneWorktreeTabForState<T extends { id: string }>(
  state: WorkspaceSessionRowState,
  tabsByWorktree: Readonly<Record<string, readonly T[] | undefined>>,
  worktreeId: string,
  tabId: string
): T | undefined {
  return findPaneWorktreeRowForState(state, tabsByWorktree, worktreeId)?.find(
    (tab) => tab.id === tabId
  )
}

/** `findPaneWorktreeTabForState` for a callback that has no snapshot in hand. */
export function findPaneWorktreeTabFromStore<T extends { id: string }>(
  tabsByWorktree: Readonly<Record<string, readonly T[] | undefined>>,
  worktreeId: string,
  tabId: string
): T | undefined {
  return findPaneWorktreeTabForState(useAppStore.getState(), tabsByWorktree, worktreeId, tabId)
}

/**
 * The layout's leaf binding, checked against the row that vouches for it.
 *
 * `terminalLayoutsByTabId` is keyed by tab id ALONE, and the two rows of a contested id hold the
 * SAME tab id (the mirrored `web-terminal-<hostTabId>` id is minted from the host's own tab id), so
 * one record serves both hosts — during the frame window after a host switch it still names the
 * PREVIOUS host's leaf. The row's `ptyId` is host-scoped: the mirror publishes it from the frame's
 * own environment, so the `remote:<env>` prefix is the evidence. Two handles naming DIFFERENT
 * environments are two different hosts' PTYs, and the row wins — the overlay mounted this pane from
 * the row, so the row is the host the user is looking at.
 *
 * Anything else is unchanged: a local or `ssh:` handle names no runtime environment, and a row
 * without a ptyId has no evidence to contradict the layout.
 */
export function reconcilePaneRestoredPtyId(
  restoredPtyId: string | null,
  rowPtyId: string | null | undefined
): string | null {
  if (!restoredPtyId || !rowPtyId || rowPtyId === restoredPtyId) {
    return restoredPtyId
  }
  const restoredEnvironmentId = getRemoteRuntimePtyEnvironmentId(restoredPtyId)
  const rowEnvironmentId = getRemoteRuntimePtyEnvironmentId(rowPtyId)
  if (restoredEnvironmentId && rowEnvironmentId && restoredEnvironmentId !== rowEnvironmentId) {
    return rowPtyId
  }
  return restoredPtyId
}
