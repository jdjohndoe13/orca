import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getPaletteWorktreeIdentity,
  getPaletteWorktreeSessionRowKey,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from './palette-repo-resolution'
import { getActiveSimulatorTabId } from './simulator-palette-active-tab'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import type { PaletteDocument } from './palette-match/palette-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

export type SearchableSimulatorTab = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  /** Normalized field index, built once per entry rather than per keystroke. */
  document: PaletteDocument
}

// Why search-only: the row icon already says "emulator"; a fixed secondary label
// crowds Cmd+J the same way "Terminal tab" did. Keep these strings matchable so
// typing "mobile" / "simulator" still finds emulator tabs.
export const SIMULATOR_TYPE_SEARCH_ALIASES = [
  'mobile emulator tab',
  'mobile emulator',
  'ios simulator',
  'emulator'
] as const

export function simulatorPaletteTabTitle(tab: Tab): string {
  return tab.label || 'Mobile Emulator'
}

export type BuildSearchableSimulatorTabsOptions = {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceVisibleTabType
  /** The contested ids (STA-4343): the row keys of these ids carry the host prefix. */
  contestedWorktreeIds?: ReadonlySet<string>
}

export function buildSearchableSimulatorTabs({
  worktrees,
  ownershipWorktrees,
  repoMap,
  repoMapByHostIdentity,
  worktreeOrder,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  contestedWorktreeIds
}: BuildSearchableSimulatorTabsOptions): SearchableSimulatorTab[] {
  const entries: SearchableSimulatorTab[] = []
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)
  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    // The row key of this worktree's session records (STA-4343) — a contested id's
    // rows live under `host|id`, so a bare-id read shows both claimants nothing.
    const rowKey = getPaletteWorktreeSessionRowKey(worktree, contestedWorktreeIds)
    const worktreeSortIndex =
      worktreeOrder.get(getPaletteWorktreeIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const activeUnifiedTabId = getActiveSimulatorTabId({
      worktreeId: worktree.id,
      worktreeHostId: worktree.hostId,
      worktreeRuntimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeGroupId: activeGroupIdByWorktree[rowKey],
      groups: groupsByWorktree[rowKey]
    })
    const tabs = unifiedTabsByWorktree[rowKey] ?? []
    const duplicateTabIds = findDuplicateIds(tabs)
    for (const tab of tabs) {
      if (
        duplicateTabIds.has(tab.id) ||
        tab.contentType !== 'simulator' ||
        !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
      ) {
        continue
      }
      entries.push({
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        // Why: simulator tabs are unified tabs; terminal activeTabId does not
        // identify the visible emulator tab after split-group activation.
        isCurrentTab: activeUnifiedTabId === tab.id,
        isCurrentWorktree: isPaletteCurrentWorktree(
          worktree,
          activeWorktreeId,
          activeWorkspaceExecutionHostId
        ),
        document: buildPaletteTabDocument({
          id: tab.id,
          title: simulatorPaletteTabTitle(tab),
          secondaryTexts: [],
          worktreeName: resolveWorktreeDisplayName(worktree),
          branch: resolveWorktreeBranchLabel(worktree),
          repoName,
          typeAliases: SIMULATOR_TYPE_SEARCH_ALIASES
        })
      })
    }
  }
  return entries
}
