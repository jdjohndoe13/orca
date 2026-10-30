import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import { getContestedWorktreeIds } from '../../../worktree-repo-index'
import { hasContestedClaim } from '../../../../../../shared/workspace-session-worktree-key'
import { worktreeRowMatchesMetaHost } from '../listing/worktree-meta-host-match'
import { detachedHeadAutoDerivedDisplayNames } from './detached-head-display-name'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  applyHostedReviewLinkClear,
  canonicalHostedReviewBranchIdentity,
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  getHostedReviewLinkMutationGeneration,
  getHostedReviewLinkUpdates,
  hasBranchScopedHostedReviewContext,
  hostedReviewLinkClearTombstonesByWorktreeId,
  hostedReviewLinksAreCleared,
  rememberHostedReviewLinkClear,
  resolveHostedReviewLinkWorktreeId
} from './hosted-review-link-mutation'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { settingsForWorktreeOwner } from '../listing/worktree-owner-settings'

export function createUpdateWorktreeGitIdentity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeGitIdentity'] {
  return (worktreeId, identity, executionHostId) => {
    let shouldPersistHostedReviewClear = false
    let clearedBranch: string | null = null
    let clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const contested = hasContestedClaim(getContestedWorktreeIds(get().worktreesByRepo), worktreeId)
    // Why: a contested id publishes one row per host (STA-4343). Without this gate a
    // patch for one host lands on every claimant — branch, head, and the re-derived
    // auto title — which is the "both rows show the clicked host's name" defect.
    // An uncontested id, or a caller that names no host, matches every row as before.
    const rowMatchesHost = (worktree: Worktree): boolean =>
      !contested || worktreeRowMatchesMetaHost(worktree, executionHostId)
    // Keep the detached-title cache per host only where the id is contested; the
    // bare key is the byte-identical spelling for every other install.
    const detachedKey =
      contested && executionHostId
        ? composeWorktreeHostIdentity(executionHostId, worktreeId)
        : worktreeId
    const existing = get().worktreesByRepo[repoId]?.find(
      (worktree) => worktree.id === worktreeId && rowMatchesHost(worktree)
    )
    if (!existing) {
      return
    }
    const expectedHead = identity.head ?? existing.head
    const expectedBranch = identity.branch === null ? '' : (identity.branch ?? existing.branch)
    if (expectedHead === existing.head && expectedBranch === existing.branch) {
      return
    }

    set((s) => {
      const current = s.worktreesByRepo[repoId]
      if (!current) {
        return s
      }

      let changed = false
      const next = current.map((worktree) => {
        if (worktree.id !== worktreeId || !rowMatchesHost(worktree)) {
          return worktree
        }
        const nextHead = identity.head ?? worktree.head
        const nextBranch = identity.branch === null ? '' : (identity.branch ?? worktree.branch)
        if (nextHead === worktree.head && nextBranch === worktree.branch) {
          return worktree
        }
        changed = true
        const hostedReviewBranchChanged =
          canonicalHostedReviewBranchIdentity(nextBranch) !==
          canonicalHostedReviewBranchIdentity(worktree.branch)
        const shouldClearHostedReviewContext =
          hostedReviewBranchChanged && hasBranchScopedHostedReviewContext(worktree)
        if (shouldClearHostedReviewContext) {
          shouldPersistHostedReviewClear = true
          clearedBranch = nextBranch
          clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
          rememberHostedReviewLinkClear(worktreeId, nextBranch, clearGeneration, nextHead)
        } else {
          const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(worktreeId)
          if (tombstone) {
            const nextBranchIdentity = canonicalHostedReviewBranchIdentity(nextBranch)
            hostedReviewLinkClearTombstonesByWorktreeId.set(worktreeId, {
              ...tombstone,
              branch: nextBranch,
              branchIdentity: nextBranchIdentity,
              head: nextHead
            })
            if (hostedReviewBranchChanged) {
              shouldPersistHostedReviewClear = true
              clearedBranch = nextBranch
              clearGeneration = tombstone.generation
            }
          }
        }
        // Why: terminal branch switches only patch branch/head here; re-derive auto titles like full listing does.
        const currentBranchName = branchName(worktree.branch)
        const wasAutoDerived =
          worktree.displayNameMode === 'automatic' ||
          (worktree.displayNameMode === undefined &&
            worktree.cliProvenance?.kind !== 'created-by-cli' &&
            worktree.displayName === currentBranchName)
        const wasDetachedAutoDerived =
          worktree.branch === '' &&
          nextBranch !== '' &&
          detachedHeadAutoDerivedDisplayNames.get(detachedKey) === worktree.displayName
        const nextDisplayName =
          (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
            ? branchName(nextBranch)
            : worktree.displayName
        if (identity.branch === null && wasAutoDerived) {
          detachedHeadAutoDerivedDisplayNames.set(detachedKey, worktree.displayName)
        } else if (identity.branch !== undefined) {
          detachedHeadAutoDerivedDisplayNames.delete(detachedKey)
        }
        return {
          ...worktree,
          head: nextHead,
          branch: nextBranch,
          displayName: nextDisplayName,
          // Why: linked reviews are branch-scoped; keeping the old link on a branch switch would refresh the old PR.
          ...(shouldClearHostedReviewContext ? CLEARED_HOSTED_REVIEW_LINK_UPDATES : {})
        }
      })

      if (!changed) {
        return s
      }

      return {
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
        sortEpoch: s.sortEpoch + 1
      }
    })
    if (!shouldPersistHostedReviewClear || clearedBranch === null) {
      return
    }

    void Promise.resolve()
      .then(async () => {
        let currentWorktreeId = resolveHostedReviewLinkWorktreeId(worktreeId)
        const persistedWorktreeIds = new Set<string>()
        while (true) {
          currentWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (persistedWorktreeIds.has(currentWorktreeId)) {
            return
          }
          persistedWorktreeIds.add(currentWorktreeId)
          let current = get().getKnownWorktreeById(currentWorktreeId)
          if (
            !current ||
            current.branch !== clearedBranch ||
            getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration
          ) {
            return
          }
          if (!hostedReviewLinksAreCleared(current as Worktree)) {
            // Why: a refetch can rehydrate stale linked-review metadata before this async clear starts; clear it again.
            applyHostedReviewLinkClear(set, currentWorktreeId)
            current = get().getKnownWorktreeById(currentWorktreeId)
            if (!current || current.branch !== clearedBranch) {
              return
            }
          }
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), currentWorktreeId),
            currentWorktreeId,
            CLEARED_HOSTED_REVIEW_LINK_UPDATES
          )
          const migratedWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (migratedWorktreeId === currentWorktreeId) {
            break
          }
          // Why: worktree creation can migrate ids mid-IPC; persist the clear under the new durable id too.
          currentWorktreeId = migratedWorktreeId
        }
        const latest = get().getKnownWorktreeById(currentWorktreeId)
        if (
          !latest ||
          latest.branch !== clearedBranch ||
          hostedReviewLinksAreCleared(latest as Worktree)
        ) {
          return
        }
        if (getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration) {
          // Why: a delayed branch-switch clear must not win over a newer manual relink.
          await persistWorktreeMeta(
            settingsForWorktreeOwner(get(), currentWorktreeId),
            currentWorktreeId,
            getHostedReviewLinkUpdates(latest as Worktree)
          )
          return
        }
        // Why: a refetch can rehydrate old metadata before the branch-switch clear reaches disk; don't write the stale link back.
        applyHostedReviewLinkClear(set, currentWorktreeId)
      })
      .catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(
            getRepoIdFromWorktreeId(resolveHostedReviewLinkWorktreeId(worktreeId))
          )
          return
        }
        console.error('Failed to persist branch-scoped review link clear:', err)
      })
  }
}
