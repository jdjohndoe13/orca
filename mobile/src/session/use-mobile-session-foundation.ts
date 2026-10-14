import { useState, useEffect, useMemo } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { useRouteHandoff } from '../navigation/route-handoff'
import { HOST_DOCK_MIN_WIDTH } from '../storage/preferences'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../transport/client-context-connection-metrics'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { type ActivePanel, canDockSessionPanel } from './session-panel-host'
import { useMobilePrBranchContext } from './use-mobile-pr-branch-context'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { useLiveWorktreeName } from './use-live-worktree-name'
import { useMissingWorktreeBounce } from './use-missing-worktree-bounce'
import { hostRouteWithNotice } from '../host-route-notice'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { resolveRelayTabsSource } from './mobile-remote-runtime-session-tabs'

export function useMobileSessionFoundation() {
  const {
    hostId,
    worktreeId,
    name: routeWorktreeName,
    created,
    warning: createdWarning
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
    warning?: string
  }>()
  const isFolderWorkspaceRoute = worktreeId.startsWith('folder:') // Synthetic ids have no repo scope.
  // Why: the floating sentinel has no repo/worktree, so repo-backed surfaces hide.
  const isFloatingWorkspaceRoute = isFloatingWorkspaceWorktreeId(worktreeId)
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  // Why: shared client per host owned by RpcClientProvider (docs/mobile-shared-client-per-host.md).
  const { client, clientId, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const forceReconnectHost = useForceReconnect()
  const {
    name: worktreeName,
    resolution: worktreeResolution,
    hostId: worktreeHostId,
    stampKnown: worktreeStampKnown
  } = useLiveWorktreeName({
    client,
    connState,
    routeName: routeWorktreeName,
    worktreeId
  })
  // Why: a workspace deleted on the desktop leaves every RPC on this route failing forever.
  useMissingWorktreeBounce({
    hostId,
    worktreeId,
    resolution: worktreeResolution,
    bounce: (id) => router.replace(hostRouteWithNotice(id, 'worktree-missing'))
  })
  // Master-detail state: wide layouts dock a tapped panel beside the session; narrow keeps it null and pushes full-screen routes.
  const { isWideLayout } = useResponsiveLayout()
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)
  const [sessionContentRowWidth, setSessionContentRowWidth] = useState(0)
  const canDockPanel =
    !isFloatingWorkspaceRoute &&
    canDockSessionPanel({
      isWideLayout,
      availableWidth: sessionContentRowWidth,
      dockWidth: HOST_DOCK_MIN_WIDTH
    })
  // Why: if rotation/split-screen makes the docked row too narrow, clear activePanel so it doesn't survive into overlay/push mode.
  useEffect(() => {
    if (!canDockPanel && activePanel !== null) {
      setActivePanel(null)
    }
  }, [canDockPanel, activePanel])
  // GitHub remote probe gates the PR dock icon so non-GitHub providers can't open the hosted-review surface; skip the unused identity RPCs.
  const { isGithubRepo: prIsGithubRepo, repoLoaded: prRepoContextLoaded } =
    useMobilePrBranchContext({
      // Why: a null client parks the hook in its not-ready state — the floating
      // sentinel has no repo to probe.
      client: isFloatingWorkspaceRoute ? null : client,
      connState,
      worktreeId,
      includeBranchIdentity: false
    })
  useEffect(() => {
    if (prRepoContextLoaded && !prIsGithubRepo && activePanel === 'pr') {
      setActivePanel(null)
    }
  }, [activePanel, prRepoContextLoaded, prIsGithubRepo])
  const initialCreateWarning = typeof createdWarning === 'string' ? createdWarning.trim() : ''
  // Mirrored (runtime-backed) rows read every one-shot method and open their
  // terminal stream through the gateway relay; the stamp rides the same
  // `worktree.show` read the live title uses. Computing it here — the root of the
  // controller's Object.assign chain — puts one source in front of the terminal
  // list, the subscription, and the input surface, not just the tab list.
  // Memoized so the derived object is identity-stable across renders: it is a
  // dependency of the subscribe/send/activate callbacks, none of which should
  // re-identity on every render.
  const sessionRelay = useMemo(
    () => resolveRelayTabsSource(worktreeHostId, worktreeStampKnown),
    [worktreeHostId, worktreeStampKnown]
  )
  return {
    hostId,
    worktreeId,
    sessionRelay,
    routeWorktreeName,
    created,
    createdWarning,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    router,
    insets,
    client,
    clientId,
    connState,
    hostCapabilities,
    reconnectAttempts,
    lastConnectedAt,
    forceReconnectHost,
    worktreeName,
    worktreeResolution,
    worktreeHostId,
    worktreeStampKnown,
    isWideLayout,
    activePanel,
    setActivePanel,
    sessionContentRowWidth,
    setSessionContentRowWidth,
    canDockPanel,
    prIsGithubRepo,
    prRepoContextLoaded,
    initialCreateWarning
  }
}

export type MobileSessionFoundationModel = ReturnType<typeof useMobileSessionFoundation>
