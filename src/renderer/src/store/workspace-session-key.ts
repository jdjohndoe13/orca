import type { AppState } from './types'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  readWorkspaceSessionEntry,
  workspaceSessionKey
} from '../../../shared/workspace-session-worktree-key'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { getContestedWorktreeIds } from './slices/worktrees/listing/worktree-catalog-index'

/**
 * Where a workspace's row lives, resolved from the store.
 *
 * Every caller that touches one worktree-keyed session record needs two things it does not
 * individually own: the contested-id set (derived from `worktreesByRepo`, memoized in
 * `worktree-repo-index`) and the host that owns the row. Threading both through ~600 call sites is
 * what made the known gap look unfixable, so they resolve here instead.
 *
 * The host comes from the caller's explicit `hostId` when it has one — a sidebar row always does —
 * then the active workspace's stamp, then the repo's own host. Explicit first matters: a card
 * rendering a NON-active workspace must not use the active workspace's host.
 */
export function resolveWorkspaceSessionHost(
  state: Pick<AppState, 'activeWorkspaceExecutionHostId' | 'activeWorktreeId'>,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): ExecutionHostId | null {
  if (hostId) {
    return hostId
  }
  if (state.activeWorktreeId === worktreeId) {
    return state.activeWorkspaceExecutionHostId ?? null
  }
  return null
}

/**
 * The session key for a workspace, from the store.
 *
 * Returns the bare id for every uncontested workspace — the whole point: nothing about a
 * non-colliding install changes. Only an id published by more than one host gains a prefix.
 */
export function resolveWorkspaceSessionKey(
  state: Pick<AppState, 'worktreesByRepo' | 'activeWorkspaceExecutionHostId' | 'activeWorktreeId'>,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): string {
  return workspaceSessionKey(
    worktreeId,
    resolveWorkspaceSessionHost(state, worktreeId, hostId),
    getContestedWorktreeIds(state.worktreesByRepo)
  )
}

/**
 * Read one worktree-keyed record for a workspace, from the store.
 *
 * A miss is the correct answer for a contested id whose host is unknown: falling back to the bare
 * key would show one host's tabs in another host's card, which is the bug being fixed.
 */
export function readWorkspaceSessionRecord<T>(
  state: Pick<AppState, 'worktreesByRepo' | 'activeWorkspaceExecutionHostId' | 'activeWorktreeId'>,
  record: Readonly<Record<string, T>> | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): { entry: T; key: string } | undefined {
  return readWorkspaceSessionEntry(
    record,
    worktreeId,
    resolveWorkspaceSessionHost(state, worktreeId, hostId),
    getContestedWorktreeIds(state.worktreesByRepo)
  )
}

/**
 * The state the catalog-owner fallback needs — narrower than `AppState` so a caller can pass a
 * slice, and an empty catalog is the faithful stand-in for a partial store mock.
 */
export type WorkspaceSessionCatalogState = Parameters<
  typeof getResolvedExecutionHostIdForWorktree
>[0] &
  Pick<AppState, 'worktreesByRepo' | 'activeWorkspaceExecutionHostId' | 'activeWorktreeId'>

/**
 * The key one workspace's row lives under, when the caller is not necessarily the active workspace
 * — the store's write actions and any pass that iterates every workspace at once.
 *
 * The active workspace's host is the user's own choice, stamped when its card was clicked, so it
 * wins outright and an unknown host is a miss. Every other row carries no stamp, and the catalog's
 * owner index is the only evidence there is.
 *
 * For a contested id the catalog's owner index is deliberately silent — it marks a two-host id
 * ambiguous rather than guessing — so such a write lands in the canonical empty-prefix bucket.
 * That is the accepted trade-off of qualifying every claimant: a write that cannot name its host
 * HIDES a row instead of painting one host's content into another's, and a caller that does know
 * the host passes it to `resolveWorkspaceSessionKey` explicitly.
 */
export function resolveWorkspaceSessionRowKey(
  state: WorkspaceSessionCatalogState,
  worktreeId: string
): string {
  if (state.activeWorktreeId === worktreeId) {
    return resolveWorkspaceSessionKey(state, worktreeId)
  }
  return resolveWorkspaceSessionKey(
    state,
    worktreeId,
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  )
}
