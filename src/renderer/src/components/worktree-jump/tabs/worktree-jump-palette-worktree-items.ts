import { comparePaletteRankedItems } from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import { getPaletteWorktreeIdentity } from '@/lib/workspace/search/palette-repo-resolution'
import type { WorktreePaletteItem } from '../worktree-jump-palette-model'
import type { PaletteSearchResult } from '@/lib/workspace/search/worktrees/worktree-palette-search'
import { encodePaletteIdentity } from '../../../../../shared/palette-match/palette-ranking'
import type { Worktree } from '../../../../../shared/worktree/types'

type WorktreeItemsInput = {
  worktreeMatches: readonly PaletteSearchResult[]
  hasQuery: boolean
  hidesPaletteWorkspace?: ((worktree: Worktree) => boolean) | null
  resolveWorktree: (
    worktreeId: string,
    hostId: Worktree['hostId'] | undefined
  ) => Worktree | undefined
}

/**
 * The palette's worktree rows: matches resolved to worktrees, hidden rows dropped,
 * and — when a query is active — sorted by rank, then match order, then identity.
 */
export function buildPaletteWorktreeItems({
  worktreeMatches,
  hasQuery,
  hidesPaletteWorkspace,
  resolveWorktree
}: WorktreeItemsInput): WorktreePaletteItem[] {
  const items = worktreeMatches
    .map((match) => {
      const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
      return worktree
        ? {
            id: encodePaletteIdentity(['worktree', getPaletteWorktreeIdentity(worktree)]),
            type: 'worktree' as const,
            match,
            worktree
          }
        : null
    })
    .filter(
      (item): item is WorktreePaletteItem =>
        item !== null && !hidesPaletteWorkspace?.(item.worktree)
    )
  if (!hasQuery) {
    return items
  }
  const orderByIdentity = new Map(
    items.map((item, index) => [getPaletteWorktreeIdentity(item.worktree), index])
  )
  return items.sort((left, right) =>
    comparePaletteRankedItems(
      {
        rank: left.match.rank,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(left.worktree)) ?? 0,
        identity: left.id,
        activity: left.match.activity
      },
      {
        rank: right.match.rank,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(right.worktree)) ?? 0,
        identity: right.id,
        activity: right.match.activity
      }
    )
  )
}
