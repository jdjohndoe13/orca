import { createPortal } from 'react-dom'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { useAppStore } from '../../../store/index'
import { selectActiveTabForWorktree } from '../../../store/slices/tabs/active-tab-selection'
import TabBar from '../../tab-bar/TabBar'
import {
  readWorktreeSessionRow,
  resolveWorkspaceRowKey
} from '../../terminal-workspace-session-row'
import type { TerminalController } from './use-terminal-controller'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

// Isolate title subscriptions so renames do not rerender the topology-owning Terminal root.
function LiveTerminalTabBar(
  props: Omit<React.ComponentProps<typeof TabBar>, 'tabs'>
): React.JSX.Element {
  // Why the row key inside the selector: the strip is mounted with the bare id, but a contested
  // id's tab row lives under `host|id`. Resolving in the same snapshot the read comes from is
  // what makes a host switch — which keeps the bare id — re-point this subscription.
  const tabs = useAppStore(
    (state) =>
      readWorktreeSessionRow(state, state.tabsByWorktree, props.worktreeId) ?? EMPTY_TERMINAL_TABS
  )
  return <TabBar {...props} tabs={tabs} />
}

export function TerminalTitlebarTabs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const {
    activeBrowserTabId,
    activeFileId,
    activeTabId,
    activeTabType,
    activeWorktreeSessionRowKey,
    effectiveActiveLayout,
    expandedPaneByTabId,
    handleActivateBrowserTab,
    handleActivateTab,
    handleCloseAllFiles,
    handleCloseBrowserTab,
    handleCloseFile,
    handleCloseOthers,
    handleCloseTab,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleDuplicateBrowserTab,
    handleNewBrowserTab,
    handleNewFile,
    handleNewSimulatorTab,
    handleNewTab,
    handleOpenEntry,
    handleTogglePaneExpand,
    makePreviewFilePermanent,
    mobileEmulatorEnabled,
    pinFile,
    renderedActiveWorktreeId,
    setActiveFile,
    setActiveTab,
    setActiveTabType,
    setTabColor,
    setTabCustomTitle,
    tabBarOrder,
    titlebarTabsTarget,
    worktreeBrowserTabs,
    worktreeClientHostedBrowserRows,
    worktreeFiles
  } = controller
  // Why the row key inside the selector: the strip is mounted with the bare id, but a contested
  // id's rows live under `host|id`. Resolving in the same snapshot the read comes from is what
  // makes a host switch — which keeps the bare id — re-point this subscription.
  const activeSimulatorTabId = useAppStore((state) =>
    activeTabType === 'simulator' && renderedActiveWorktreeId
      ? (selectActiveTabForWorktree(state, resolveWorkspaceRowKey(state, renderedActiveWorktreeId))
          ?.id ?? null)
      : null
  )
  if (!renderedActiveWorktreeId || effectiveActiveLayout || !titlebarTabsTarget) {
    return null
  }
  return createPortal(
    <LiveTerminalTabBar
      activeTabId={activeTabId}
      worktreeId={renderedActiveWorktreeId}
      onActivate={handleActivateTab}
      onClose={(tabId) => handleCloseTab(tabId, 'user')}
      onCloseOthers={handleCloseOthers}
      onCloseToRight={handleCloseTabsToRight}
      onCloseToLeft={handleCloseTabsToLeft}
      onNewTerminalTab={() => handleNewTab()}
      onNewTerminalWithShell={handleNewTab}
      onNewBrowserTab={handleNewBrowserTab}
      onNewSimulatorTab={mobileEmulatorEnabled ? handleNewSimulatorTab : undefined}
      onOpenEntry={handleOpenEntry}
      onNewFileTab={handleNewFile}
      onSetCustomTitle={setTabCustomTitle}
      onSetTabColor={setTabColor}
      expandedPaneByTabId={expandedPaneByTabId}
      onTogglePaneExpand={handleTogglePaneExpand}
      editorFiles={worktreeFiles}
      browserTabs={worktreeBrowserTabs}
      clientHostedBrowserRows={worktreeClientHostedBrowserRows}
      activeFileId={activeFileId}
      activeBrowserTabId={activeBrowserTabId}
      activeSimulatorTabId={activeSimulatorTabId}
      activeTabType={activeTabType}
      onActivateFile={(fileId) => {
        const unifiedTabs =
          (activeWorktreeSessionRowKey !== null
            ? useAppStore.getState().unifiedTabsByWorktree[activeWorktreeSessionRowKey]
            : undefined) ?? []
        const unifiedTab = unifiedTabs.find((tab) => tab.id === fileId)
        if (unifiedTab?.contentType === 'simulator') {
          setActiveTab(fileId)
          setActiveTabType('simulator', renderedActiveWorktreeId)
          return
        }
        setActiveFile(fileId)
        setActiveTabType('editor', renderedActiveWorktreeId)
      }}
      onCloseFile={handleCloseFile}
      onActivateBrowserTab={handleActivateBrowserTab}
      onCloseBrowserTab={handleCloseBrowserTab}
      onDuplicateBrowserTab={handleDuplicateBrowserTab}
      onCloseAllFiles={handleCloseAllFiles}
      onMakePreviewFilePermanent={makePreviewFilePermanent}
      onPinFile={pinFile}
      tabBarOrder={tabBarOrder}
    />,
    titlebarTabsTarget
  )
}
