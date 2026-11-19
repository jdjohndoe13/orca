import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '../../../store/index'
import { hasFeatureInteraction } from '../../../../../shared/feature-education/interactions/feature-interactions'
import { setForegroundTerminalTabIds } from '@/components/terminal-pane/parking/retention/foreground-terminal-tabs'
import { useClientHostedBrowserRows } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import { resolveWorkspaceRowKeyFromStore } from '../../terminal-workspace-session-row'
import { useTerminalProviderSnapshotCapability } from '../provider-snapshots/use-terminal-provider-snapshot-capability'
import { getEffectiveLayoutForWorktree as getEffectiveLayout } from '../workspace-mounting/split-group-mount'
import { useContextualTour } from '../../contextual-tours/use-contextual-tour'
import { findFocusedSplitLandingGroup } from '@/store/slices/tabs/split-landing-groups'
import type { TerminalWorkspaceStoreController } from './use-terminal-workspace-store-bindings'
import { useWorktreeFiles } from '../workspace-files/use-worktree-files'

// Read every render: the titlebar strip can mount after this host. A hook result is never memoized.
function useTitlebarTabsTarget(): HTMLElement | null {
  return document.getElementById('titlebar-tabs')
}

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
  const titlebarTabsTarget = useTitlebarTabsTarget()

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
  // Before host layout arrives, paired clients may own browser pages absent on host; include them
  // so they remain closable. Why the row key: the workbench is bare-id keyed, so a contested id's
  // browser row — host-qualified — has to be asked for by name.
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
  // After a split the owed tip points into the sidebar; don't watch the page for it while it's closed.
  const nextTourTipReachable = useAppStore(
    (state) =>
      state.sidebarOpen ||
      (!hasFeatureInteraction(state.featureInteractions, 'terminal-pane-split') &&
        !hasFeatureInteraction(state.featureInteractions, 'tab-splits'))
  )
  const splitLandingGroupIds = useAppStore((state) => state.splitLandingGroupIds)
  const focusesSplitLanding = Boolean(
    findFocusedSplitLandingGroup(
      { groupsByWorktree, activeGroupIdByWorktree, splitLandingGroupIds },
      activeWorktreeId
    )
  )
  const hasSplitTab = useAppStore((state) =>
    hasFeatureInteraction(state.featureInteractions, 'tab-splits')
  )

  useContextualTour(
    'workspace-agent-sessions',
    Boolean(
      activeWorktreeId &&
      activeView === 'terminal' &&
      workspaceSessionReady &&
      (activeTabType === 'agent-session' ||
        (activeTabType === 'terminal' && Boolean(activeTabId)) ||
        // Splitting a chat focuses the new pane's landing; the tour continues there.
        focusesSplitLanding) &&
      nextTourTipReachable
    ),
    'workspace_agent_sessions_visible',
    {
      // Keep this interaction counted only up to the first split, as before the tour could resume.
      recordFeatureInteraction:
        !(hasSplitTerminalPane || hasSplitTab) ||
        activeContextualTourId === 'workspace-agent-sessions'
    }
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
    terminalProviderSnapshotCapabilityRevision
  }
}

export type TerminalWorkspaceProjectionController = TerminalWorkspaceStoreController &
  ReturnType<typeof useTerminalWorkspaceProjection>
