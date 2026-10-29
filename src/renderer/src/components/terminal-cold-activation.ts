import { useAppStore } from '../store'
import {
  canAdmitTerminalTabsForStartup,
  canDeferColdActivationTabsForHost,
  planColdActivationTabDeferral,
  pruneClosedBackgroundMountTabs,
  revealActivationDeferredTabs
} from './terminal/background-terminal-worktree-mount'
import {
  holdTerminalTabsForStartup,
  releaseStartupTerminalTabHold
} from './terminal/startup-terminal-tab-hold'
import { hasRegisteredRuntimeTerminalTab } from '../runtime/sync-runtime-graph'
import { anyMountedWorktreeHasLayout as computeAnyMountedWorktreeHasLayout } from './terminal/split-group-mount'
import { isParkRestorableTerminalPty } from './terminal-pane/terminal-hidden-view-parking'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/terminal-parked-tab-watchers'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { terminalProviderHasAuthoritativeSnapshot } from './terminal/terminal-provider-snapshot-capability'
import { resolveWorkspaceRowKeyFromStore } from './terminal-workspace-session-row'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function applyTerminalColdActivation(controller: TerminalParkingFoundation) {
  const {
    activationDeferralPlanRevisionRef,
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeWorktreeDeferralHostId,
    activeWorktreeSessionRowKey,
    activityTerminalPortals,
    backgroundMountTabIdsByWorktreeRef,
    groupsByWorktree,
    hydrationSucceeded,
    lastActivationWorktreeIdRef,
    layoutByWorktree,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    startupTerminalTabHoldRef,
    startupWorktreeRefreshCompleted,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalTitleSnapshotAuthorityEnabled,
    workspaceSessionReady,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller
  // Why the surface mounts on the tab model alone: the hydrated tabs, groups, and layout are
  // everything the tab strip and the chat, browser, and editor panes need. Only terminal
  // panes wait, held below, for startup restoration to publish PTY ownership — gating the
  // whole surface on that chain left a restored session blank until its last step.
  const startupHeldWorktreeId =
    renderedActiveWorktreeId &&
    !canAdmitTerminalTabsForStartup({
      workspaceSessionReady,
      hydrationSucceeded,
      startupWorktreeRefreshCompleted
    })
      ? renderedActiveWorktreeId
      : null
  releaseStartupTerminalTabHold(
    startupTerminalTabHoldRef,
    backgroundMountTabIdsByWorktreeRef.current,
    mountedWorktreeIdsRef.current,
    startupHeldWorktreeId
  )
  if (renderedActiveWorktreeId && !startupHeldWorktreeId) {
    // Why the row key and not the bare id: the workbench mounts on the bare id, but a contested
    // id's rows live under `host|id` and the bucket projection passes keys through — so every
    // read below has to ask for the active host's row. `?? ''` only narrows: the key is derived
    // from `renderedActiveWorktreeId` so it is never null here, and an empty key matches no row.
    const rowKey = activeWorktreeSessionRowKey ?? ''
    const worktreeTabs = tabsByWorktree[rowKey] ?? []
    const coldActivationDeferralEnabled =
      terminalParkingEnabled && terminalTitleSnapshotAuthorityEnabled
    const immediateTabIds = new Set<string>()
    if (activeTabId) {
      immediateTabIds.add(activeTabId)
    }
    const rememberedActiveTabId = activeTabIdByWorktree[rowKey]
    if (rememberedActiveTabId) {
      immediateTabIds.add(rememberedActiveTabId)
    }
    const unifiedTabById = new Map(
      (useAppStore.getState().unifiedTabsByWorktree[rowKey] ?? []).map((unifiedTab) => [
        unifiedTab.id,
        unifiedTab
      ])
    )
    for (const group of groupsByWorktree[rowKey] ?? []) {
      if (!group.activeTabId) {
        continue
      }
      immediateTabIds.add(group.activeTabId)
      const activeUnifiedTab = unifiedTabById.get(group.activeTabId)
      if (activeUnifiedTab?.contentType === 'terminal') {
        immediateTabIds.add(activeUnifiedTab.entityId)
      }
    }
    for (const portal of activityTerminalPortals) {
      if (portal.worktreeId === renderedActiveWorktreeId) {
        immediateTabIds.add(portal.tabId)
      }
    }
    for (const tab of worktreeTabs) {
      if (pendingStartupByTabId[tab.id] !== undefined) {
        immediateTabIds.add(tab.id)
      }
    }
    const activationHostSupportsDeferral = canDeferColdActivationTabsForHost({
      executionHostId: activeWorktreeDeferralHostId,
      pairedRuntimeParkingEnvironmentIds
    })
    const isColdActivationPtyEligible = (ptyId: string): boolean =>
      isRemoteRuntimePtyId(ptyId)
        ? isParkRestorableTerminalPty(ptyId, renderedActiveWorktreeId, {
            pairedRuntimeParkingEnvironmentIds
          })
        : terminalProviderHasAuthoritativeSnapshot(ptyId)
    // Why the row key here and not the bare id: clicking another host's card of a colliding id
    // keeps `renderedActiveWorktreeId`, so a bare-id comparison would call the new host's tabs a
    // repeat activation and skip the deferral plan those tabs need.
    if (lastActivationWorktreeIdRef.current !== rowKey) {
      lastActivationWorktreeIdRef.current = rowKey
      const tabById = new Map(worktreeTabs.map((tab) => [tab.id, tab]))
      const installedDeferralPlan = planColdActivationTabDeferral({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        isTabLive: (tabId, worktreeId) => hasRegisteredRuntimeTerminalTab(tabId, worktreeId),
        // Why the coverage gate: parked byte watchers own an unmounted tab's bells/titles/completions, so a tab they can't cover must mount immediately.
        isTabDeferrable: (tabId) => {
          const tab = tabById.get(tabId)
          return (
            coldActivationDeferralEnabled &&
            activationHostSupportsDeferral &&
            tab !== undefined &&
            canWatcherCoverParkedTerminalTab(
              renderedActiveWorktreeId,
              tab,
              isColdActivationPtyEligible
            )
          )
        },
        immediateTabIds
      })
      // Why: the install mutates only refs, so without a returned revision the
      // admission drain's effect deps never change and the plan strands.
      if (installedDeferralPlan) {
        activationDeferralPlanRevisionRef.current += 1
      }
    } else if (!coldActivationDeferralEnabled || !activationHostSupportsDeferral) {
      backgroundMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(renderedActiveWorktreeId)
    } else {
      for (const tab of worktreeTabs) {
        if (
          !canWatcherCoverParkedTerminalTab(
            renderedActiveWorktreeId,
            tab,
            isColdActivationPtyEligible
          )
        ) {
          immediateTabIds.add(tab.id)
        }
      }
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId: renderedActiveWorktreeId,
        allTabIds: worktreeTabs.map((tab) => tab.id),
        immediateTabIds
      })
    }
    mountedWorktreeIdsRef.current.add(renderedActiveWorktreeId)
  } else {
    lastActivationWorktreeIdRef.current = null
  }
  pruneClosedBackgroundMountTabs(
    backgroundMountTabIdsByWorktreeRef.current,
    mountedWorktreeIdsRef.current,
    tabsByWorktree,
    activationDeferredMountTabIdsByWorktreeRef.current,
    // Why the mapper: the restriction maps are mount-keyed (bare id, like `mountedWorktreeIds`),
    // so the prune has to translate each to the key its tab row lives under — otherwise a
    // contested id finds no live tabs and prunes every deferred tab as closed.
    resolveWorkspaceRowKeyFromStore
  )
  if (startupHeldWorktreeId) {
    holdTerminalTabsForStartup(
      startupTerminalTabHoldRef,
      backgroundMountTabIdsByWorktreeRef.current,
      mountedWorktreeIdsRef.current,
      startupHeldWorktreeId,
      (tabsByWorktree[activeWorktreeSessionRowKey ?? ''] ?? []).map((tab) => tab.id)
    )
  }
  for (const id of mountedWorktreeIdsRef.current) {
    if (!workspaceSurfaceIdSet.has(id)) {
      mountedWorktreeIdsRef.current.delete(id)
      backgroundMountTabIdsByWorktreeRef.current.delete(id)
      activationDeferredMountTabIdsByWorktreeRef.current.delete(id)
    }
  }
  const anyMountedWorktreeHasLayout = computeAnyMountedWorktreeHasLayout(
    workspaceSurfaceIds,
    mountedWorktreeIdsRef.current,
    layoutByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    resolveWorkspaceRowKeyFromStore
  )
  return {
    anyMountedWorktreeHasLayout,
    activationDeferralPlanRevision: activationDeferralPlanRevisionRef.current,
    startupTerminalTabHold: startupTerminalTabHoldRef.current
  }
}

export type TerminalColdActivationController = TerminalParkingFoundation &
  ReturnType<typeof applyTerminalColdActivation>
