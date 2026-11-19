import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { useAppStore } from '../store'
import {
  readWorkspaceSessionRecord,
  resolveWorkspaceSessionKey,
  resolveWorkspaceSessionRowKey
} from '../store/workspace-session-key'

/**
 * Reads the terminal workbench makes of a worktree-keyed session record.
 *
 * The workbench is keyed by the BARE worktree id end to end — `activeWorktreeId`, the
 * one-surface-per-id mount list, `mountedWorktreeIdsRef` — while a contested id's row (one
 * repo registered on several execution hosts, STA-4343) lives under `host|id`. Reading the
 * bare id therefore shows the primary host's tabs no matter which host's card was clicked.
 *
 * Everything here routes through the accessor so the key is composed in exactly one place
 * (`src/shared/workspace-session-worktree-key.ts`), and an id published by only one host
 * resolves to the bare key — a single-host install reads byte-identical to before.
 *
 * A miss is the answer. A contested id whose host is unknown has no row to read, and falling
 * back to the bare key is what shows one host's tabs in another host's workbench.
 */

/** The state the accessors need; narrower than `AppState` so a caller can pass a snapshot. */
export type WorkspaceSessionRowState = Parameters<typeof readWorkspaceSessionRecord>[0]

/**
 * A partial store state — a test mock, or a slice before the catalog hydrates — carries no
 * catalog, and the contested-id index reads `Object.values` off it. No catalog is no evidence
 * of contention, which is exactly the bare-key answer the shared layer already gives for an
 * absent contested set, so the empty catalog is the faithful stand-in, not a fallback.
 */
function cataloged(state: WorkspaceSessionRowState): WorkspaceSessionRowState {
  return state.worktreesByRepo ? state : { ...state, worktreesByRepo: {} }
}

/**
 * One workspace's row of a worktree-keyed record, from the caller's snapshot.
 *
 * State-first so a `useAppStore` selector can resolve the key from the same snapshot it reads
 * the record from — the selector reruns on every write, so a host switch that keeps the bare
 * id still re-points the read at the row the newly-active host owns.
 */
export function readWorktreeSessionRow<T>(
  state: WorkspaceSessionRowState,
  record: Readonly<Record<string, T>> | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): T | undefined {
  return readWorkspaceSessionRecord(cataloged(state), record, worktreeId, hostId)?.entry
}

/**
 * The same read for a callback, where no snapshot is in hand and the store's current state is
 * the freshest one available.
 */
export function readWorktreeSessionRowFromStore<T>(
  record: Readonly<Record<string, T>> | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): T | undefined {
  return readWorktreeSessionRow(useAppStore.getState(), record, worktreeId, hostId)
}

/**
 * The key one workspace's row lives under, from the caller's snapshot.
 *
 * A projection that reads a COPY of the record — the topology projection's `tabsByWorktree` —
 * needs the key rather than the row, so the copy's key is asked for once per render and reused.
 */
export function resolveWorktreeSessionRowKey(
  state: WorkspaceSessionRowState,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): string {
  return resolveWorkspaceSessionKey(cataloged(state), worktreeId, hostId)
}

/**
 * The key one workspace's row lives under, from the store's current state.
 *
 * The callback sibling of `resolveWorktreeSessionRowKey` — for a `useCallback` that reads a
 * record at call time (the split-layout lookup) rather than during a render.
 */
export function resolveWorktreeSessionRowKeyFromStore(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): string {
  return resolveWorktreeSessionRowKey(useAppStore.getState(), worktreeId, hostId)
}

type SurfaceSessionRowState = Parameters<typeof resolveWorkspaceSessionRowKey>[0]

/**
 * The key one workspace's row lives under, for any workspace — the pass that iterates every mounted
 * surface reads the active one too.
 *
 * The active workspace's host is the user's own choice (`activeWorkspaceExecutionHostId`, stamped
 * when the card was clicked), so it wins outright and an unknown host is a miss. Every other row
 * has no stamp, and the catalog's owner index is the only evidence there is. Both branches live in
 * the store accessor so the write side and the read side cannot drift apart.
 */
export function resolveWorkspaceRowKey(state: SurfaceSessionRowState, worktreeId: string): string {
  return resolveWorkspaceSessionRowKey(cataloged(state), worktreeId)
}

/** `resolveWorkspaceRowKey` for a selector or callback that has no snapshot in hand. */
export function resolveWorkspaceRowKeyFromStore(worktreeId: string): string {
  return resolveWorkspaceRowKey(useAppStore.getState(), worktreeId)
}

/**
 * The row key of the workspace the workbench is showing, subscribed to the store.
 *
 * Why a subscription rather than deriving it from `renderedActiveWorktreeId`: clicking another
 * host's card of a colliding id keeps the bare id and only swaps the active host's stamp, so
 * nothing the projection already depends on changes — and the surface would keep painting the
 * host it had.
 */
export function useActiveWorktreeSessionRowKey(worktreeId: string | null): string | null {
  return useAppStore((state) =>
    worktreeId ? resolveWorktreeSessionRowKey(state, worktreeId) : null
  )
}
