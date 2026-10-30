import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

export const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()

export function setDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string,
  displayName: string
): void {
  detachedHeadAutoDerivedDisplayNames.set(worktreeId, displayName)
}

export function getDetachedHeadAutoDerivedDisplayNameForTests(
  worktreeId: string
): string | undefined {
  return detachedHeadAutoDerivedDisplayNames.get(worktreeId)
}

export function forgetDetachedHeadAutoDerivedDisplayName(worktreeId: string): void {
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
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
