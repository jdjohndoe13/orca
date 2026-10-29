import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '../store'
import { hasFeatureInteraction } from '../../../shared/feature-interactions'
import { setForegroundTerminalTabIds } from '@/lib/foreground-terminal-tabs'
import { useClientHostedBrowserRows } from '@/lib/pane-manager/client-hosted-browser-row-state'
import { resolveWorkspaceRowKeyFromStore } from './terminal-workspace-session-row'
import { useTerminalProviderSnapshotCapability } from './terminal/use-terminal-provider-snapshot-capability'
import { getEffectiveLayoutForWorktree as getEffectiveLayout } from './terminal/split-group-mount'
import { useContextualTour } from './contextual-tours/use-contextual-tour'
import type { TerminalWorkspaceStoreController } from './use-terminal-workspace-store-bindings'
import { useWorktreeFiles } from './terminal/use-worktree-files'

export function useTerminalWorkspaceProjection(controller: TerminalWorkspaceStoreController) {
  const {
    activeGroupIdByWorktree,
    activeTabId,
    activeTabType,
    activeView,
    activeWorktreeId,
    activeWorktreeSessionRowKey,
    activityTerminalPortals,
    browserTabsByWorktree,
    ensureWorktreeRootGroup,
    groupsByWorktree,
    hydrationSucceeded,
    layoutByWorktree,
    openFiles,
    renderedActiveWorktreeId,
    tabsByWorktree,
    workspaceSessionReady
  } = controller
  const foregroundTerminalTabIds = useMemo(() => {
    const ids = new Set<string>()
    if (activeView === 'terminal' && activeTabType === 'terminal' && activeTabId) {
      ids.add(activeTabId)
    }
    for (const portal of activityTerminalPortals) {
      ids.add(portal.tabId)
    }
    return Array.from(ids)
  }, [activeTabId, activeTabType, activeView, activityTerminalPortals])

  useEffect(() => {
    setForegroundTerminalTabIds(foregroundTerminalTabIds)
    return () => setForegroundTerminalTabIds([])
  }, [foregroundTerminalTabIds])

  // Why the row key and not the bare id: the workbench is bare-id keyed, so clicking another
  // host's card of a colliding id changes only `activeWorkspaceExecutionHostId`. The bucket
  // projection passes keys through, so the qualified row is already in this copy — the read
  // just has to ask for it.
  const tabs = useMemo(
    () =>
      activeWorktreeSessionRowKey !== null &&
      Object.hasOwn(tabsByWorktree, activeWorktreeSessionRowKey)
        ? tabsByWorktree[activeWorktreeSessionRowKey]
        : [],
    [activeWorktreeSessionRowKey, tabsByWorktree]
  )
  const terminalProviderSnapshotCapabilityRevision = useTerminalProviderSnapshotCapability(
    workspaceSessionReady && hydrationSucceeded
  )
  const titlebarTabsTarget = document.getElementById('titlebar-tabs')

  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    ensureWorktreeRootGroup(activeWorktreeId)
  }, [activeWorktreeId, ensureWorktreeRootGroup])

  const worktreeFiles = useWorktreeFiles(openFiles, renderedActiveWorktreeId)
  const worktreeBrowserTabs =
    activeWorktreeSessionRowKey !== null
      ? (browserTabsByWorktree[activeWorktreeSessionRowKey] ?? [])
      : []
  // Why: this strip only renders before the worktree has a layout, which is exactly when a paired
  // client can have opened a page the host never has. Without a row here it stays uncloseable.
  const worktreeClientHostedBrowserRows = useClientHostedBrowserRows(renderedActiveWorktreeId ?? '')
  const getEffectiveLayoutForWorktree = useCallback(
    (worktreeId: string) =>
      getEffectiveLayout(
        // Why the row key: this runs for every mounted surface, and the surface list is bare-id
        // keyed, so a contested id's layout/group rows have to be asked for by name.
        resolveWorkspaceRowKeyFromStore(worktreeId),
        layoutByWorktree,
        groupsByWorktree,
        activeGroupIdByWorktree
      ),
    [activeGroupIdByWorktree, groupsByWorktree, layoutByWorktree]
  )
  const effectiveActiveLayout = renderedActiveWorktreeId
    ? getEffectiveLayoutForWorktree(renderedActiveWorktreeId)
    : undefined
  const activeWorktreeBrowserTabIdsKey =
    activeWorktreeSessionRowKey !== null
      ? (browserTabsByWorktree[activeWorktreeSessionRowKey] ?? []).map((tab) => tab.id).join(',')
      : ''
  const activeContextualTourId = useAppStore((state) => state.activeContextualTourId)
  const hasSplitTerminalPane = useAppStore((state) =>
    hasFeatureInteraction(state.featureInteractions, 'terminal-pane-split')
  )

  useContextualTour(
    'workspace-agent-sessions',
    Boolean(
      activeWorktreeId &&
      activeView === 'terminal' &&
      workspaceSessionReady &&
      activeTabType === 'terminal' &&
      Boolean(activeTabId) &&
      (!hasSplitTerminalPane || activeContextualTourId === 'workspace-agent-sessions')
    ),
    'workspace_agent_sessions_visible'
  )

  return {
    foregroundTerminalTabIds,
    tabs,
    titlebarTabsTarget,
    worktreeFiles,
    worktreeBrowserTabs,
    worktreeClientHostedBrowserRows,
    getEffectiveLayoutForWorktree,
    effectiveActiveLayout,
    activeWorktreeBrowserTabIdsKey,
    activeContextualTourId,
    hasSplitTerminalPane,
    terminalProviderSnapshotCapabilityRevision
  }
}

export type TerminalWorkspaceProjectionController = TerminalWorkspaceStoreController &
  ReturnType<typeof useTerminalWorkspaceProjection>
