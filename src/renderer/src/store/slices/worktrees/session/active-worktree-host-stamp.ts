import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { hasContestedClaim } from '../../../../../../shared/workspace-session-worktree-key'
import type { AppState } from '../../../types'
import { getContestedWorktreeIds, getIndexedWorktreesById } from '../../worktrees/listing/worktree-catalog-index'

/**
 * The host to stamp when an activation names no host of its own.
 *
 * Only a contested id gets a stamp: the catalog proves the host when exactly one of the
 * rows claiming the id carries a `hostId`; an ambiguous catalog (several hosts, or an
 * unqualified row among them) leaves the stamp null so the active-row guard matches
 * NOTHING instead of lighting every claimant at once. Uncontested ids keep the null
 * stamp so single-host installs retain the bare match.
 */
export function getContestedHostStamp(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string
): ExecutionHostId | null {
  // The contested set holds the canonical id; the caller may hold the raw Windows spelling.
  // `hasContestedClaim` folds both sides — the gate must not byte-miss a two-spelling collision.
  if (!hasContestedClaim(getContestedWorktreeIds(state.worktreesByRepo), worktreeId)) {
    return null
  }
  const hostIds = new Set<ExecutionHostId>()
  for (const row of getIndexedWorktreesById(state.worktreesByRepo, worktreeId)) {
    if (row.hostId) {
      hostIds.add(row.hostId)
    }
  }
  return hostIds.size === 1 ? (hostIds.values().next().value ?? null) : null
}
