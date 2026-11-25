import { useMemo } from 'react'
import { buildSearchableBrowserPages } from '@/lib/browser/palette/browser-palette-page-entries'
import {
  searchBrowserPages,
  type SearchableBrowserPage
} from '@/lib/browser/palette/browser-palette-search'
import {
  buildSearchableSimulatorTabs,
  searchSimulatorTabs
} from '@/lib/simulator/search/simulator-palette-search'
import type { SearchableSimulatorTab } from '@/lib/simulator/search/simulator-palette-search-types'
import '@/lib/workspace/search/tabs/workspace-tab-search-types'
import type { SearchableWorkspaceTab } from '@/lib/workspace/search/tabs/workspace-tab-search-types'
import { createWorkspaceTabPaletteIndex } from '@/lib/workspace/search/tabs/workspace-tab-palette-index'

import { searchWorkspaceTabs } from '@/lib/workspace/search/tabs/workspace-tab-palette-results'
import { buildPaletteWorktreeItems } from './worktree-jump-palette-worktree-items'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem,
  WorktreePaletteItem
} from '../worktree-jump-palette-model'
import type { WorktreeJumpPaletteOpenTabsInput } from './worktree-jump-palette-open-tabs-input'
import {
  buildBrowserPaletteItems,
  buildOpenTabPaletteItems,
  buildSimulatorPaletteItems,
  buildWorkspaceTabPaletteItems
} from './worktree-jump-palette-open-tab-items'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useStructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-name-observation'
import { useTranslate } from '@/i18n/use-translate'

const EMPTY_BROWSER_PAGE_ENTRIES: SearchableBrowserPage[] = []
const EMPTY_SIMULATOR_TAB_ENTRIES: SearchableSimulatorTab[] = []
const EMPTY_WORKSPACE_TAB_ENTRIES: SearchableWorkspaceTab[] = []

export function useWorktreeJumpPaletteOpenTabs({
  paletteStatusInputsActive,
  browserSortedWorktrees,
  workspaces,
  contestedWorktreeIds,
  repoMap,
  repoByHostIdentity,
  worktreeOrder,
  browserTabsByWorktree,
  browserPagesByWorkspace,
  activeBrowserTabId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  tabsByWorktree,
  openFiles,
  agentStatusByPaneKey,
  sleepingAgentSessionsByPaneKey,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  settings,
  terminalLayoutsByTabId,
  paneForegroundAgentByPaneKey,
  deferredQuery,
  paletteSearchContext,
  hasQuery,
  worktreeMatches,
  hidesPaletteWorkspace,
  resolveWorktree
}: WorktreeJumpPaletteOpenTabsInput) {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const chatNames = useStructuredChatTabNames()
  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_BROWSER_PAGE_ENTRIES
    }
    return buildSearchableBrowserPages({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: workspaces,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      browserTabsByWorktree,
      browserPagesByWorkspace,
      activeBrowserTabId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      unifiedTabsByWorktree,
      contestedWorktreeIds
    })
  }, [
    paletteStatusInputsActive,
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    workspaces,
    browserPagesByWorkspace,
    browserTabsByWorktree,
    browserSortedWorktrees,
    contestedWorktreeIds,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const browserMatches = useMemo(
    () =>
      searchBrowserPages(browserPageEntries, deferredQuery.trim(), {
        context: paletteSearchContext
      }),
    [browserPageEntries, deferredQuery, paletteSearchContext]
  )
  const simulatorTabEntries = useMemo<SearchableSimulatorTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_SIMULATOR_TAB_ENTRIES
    }
    return buildSearchableSimulatorTabs({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: workspaces,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      contestedWorktreeIds
    })
  }, [
    paletteStatusInputsActive,
    activeGroupIdByWorktree,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    workspaces,
    browserSortedWorktrees,
    contestedWorktreeIds,
    groupsByWorktree,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const simulatorMatches = useMemo(
    () =>
      searchSimulatorTabs(
        simulatorTabEntries,
        deferredQuery.trim(),
        {
          context: paletteSearchContext
        },
        t
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- simulator titles translate the default label.
    [simulatorTabEntries, deferredQuery, paletteSearchContext, languageRevision, t]
  )
  const buildWorkspaceTabEntries = useMemo(
    () => (paletteStatusInputsActive ? createWorkspaceTabPaletteIndex() : null),
    [paletteStatusInputsActive]
  )
  const workspaceTabEntries = useMemo<SearchableWorkspaceTab[]>(() => {
    if (!buildWorkspaceTabEntries) {
      return EMPTY_WORKSPACE_TAB_ENTRIES
    }
    return buildWorkspaceTabEntries({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: workspaces,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      tabsByWorktree,
      openFiles,
      agentStatusByPaneKey,
      sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeTabId,
      activeTabIdByWorktree,
      activeFileId,
      activeFileIdByWorktree,
      activeTabTypeByWorktree,
      generatedTitlesEnabled: settings?.tabAutoGenerateTitle === true,
      chatNames,
      terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey,
      contestedWorktreeIds
    })
  }, [
    buildWorkspaceTabEntries,
    activeFileId,
    activeFileIdByWorktree,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeTabTypeByWorktree,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    workspaces,
    agentStatusByPaneKey,
    browserSortedWorktrees,
    chatNames,
    contestedWorktreeIds,
    groupsByWorktree,
    openFiles,
    repoMap,
    repoByHostIdentity,
    settings?.tabAutoGenerateTitle,
    sleepingAgentSessionsByPaneKey,
    paneForegroundAgentByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree,
    worktreeOrder
  ])
  const workspaceTabMatches = useMemo(
    () =>
      searchWorkspaceTabs(workspaceTabEntries, deferredQuery.trim(), {
        context: paletteSearchContext
      }),
    [workspaceTabEntries, deferredQuery, paletteSearchContext]
  )
  const worktreeItems = useMemo<WorktreePaletteItem[]>(
    () =>
      buildPaletteWorktreeItems({
        worktreeMatches,
        hasQuery,
        hidesPaletteWorkspace,
        resolveWorktree
      }),
    [hasQuery, hidesPaletteWorkspace, resolveWorktree, worktreeMatches]
  )
  const browserItems = useMemo<BrowserPaletteItem[]>(
    () => buildBrowserPaletteItems(browserMatches),
    [browserMatches]
  )
  const simulatorItems = useMemo<SimulatorPaletteItem[]>(
    () => buildSimulatorPaletteItems(simulatorMatches),
    [simulatorMatches]
  )
  const workspaceTabItems = useMemo<WorkspaceTabPaletteItem[]>(
    () => buildWorkspaceTabPaletteItems(workspaceTabMatches),
    [workspaceTabMatches]
  )
  const openTabItems = useMemo<OpenTabPaletteItem[]>(
    () => buildOpenTabPaletteItems({ browserItems, simulatorItems, workspaceTabItems }),
    [browserItems, simulatorItems, workspaceTabItems]
  )

  return {
    browserPageEntries,
    simulatorTabEntries,
    workspaceTabEntries,
    worktreeItems,
    browserItems,
    simulatorItems,
    workspaceTabItems,
    openTabItems
  }
}

export type WorktreeJumpPaletteOpenTabs = ReturnType<typeof useWorktreeJumpPaletteOpenTabs>
