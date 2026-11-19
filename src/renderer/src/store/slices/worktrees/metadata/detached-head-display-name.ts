import type { Worktree } from '../../../../../../shared/worktree/types'
import { branchName } from '@/lib/source-control/branches/branch-name'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

export const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()

export function forgetDetachedHeadAutoDerivedDisplayName(worktreeId: string): void {
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
}

/** Re-derive automatic titles on a branch/head patch the way a full listing would; records detach-time names.
 *  `detachedKey` is the id's session row for a contested id (`host|id`, STA-4343), so a contested
 *  row's cache is read and written per host; every other install keeps the bare key. */
export function deriveGitIdentityDisplayName(
  worktree: Worktree,
  worktreeId: string,
  nextBranch: string,
  identityBranch: string | null | undefined,
  detachedKey: string = worktreeId
): string {
  const currentBranchName = branchName(worktree.branch)
  const wasAutoDerived =
    worktree.displayNameMode === 'automatic' ||
    (worktree.displayNameMode === undefined &&
      worktree.cliProvenance?.kind !== 'created-by-cli' &&
      worktree.displayName === currentBranchName)
  const wasDetachedAutoDerived =
    worktree.displayNameMode !== 'fixed' &&
    worktree.branch === '' &&
    nextBranch !== '' &&
    detachedHeadAutoDerivedDisplayNames.get(detachedKey) === worktree.displayName
  const nextDisplayName =
    (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
      ? branchName(nextBranch)
      : worktree.displayName
  if (identityBranch === null && wasAutoDerived) {
    detachedHeadAutoDerivedDisplayNames.set(detachedKey, worktree.displayName)
  } else if (identityBranch !== undefined) {
    detachedHeadAutoDerivedDisplayNames.delete(detachedKey)
  }
  return nextDisplayName
}

/**
 * Purges the bare key AND every `host|id` spelling of the same workspace.
 * A contested id caches its detached title per host row, so a removal that
 * only deleted the bare key would strand the per-host entries.
 */
export function forgetDetachedHeadAutoDerivedDisplayNamesForWorktree(worktreeId: string): void {
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
  for (const key of detachedHeadAutoDerivedDisplayNames.keys()) {
    if (isWorktreeHostIdentity(key) && getWorktreeIdFromHostIdentity(key) === worktreeId) {
      detachedHeadAutoDerivedDisplayNames.delete(key)
    }
  }
}
