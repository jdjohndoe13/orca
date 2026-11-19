import { createPortal } from 'react-dom'
import TerminalPane from '../../terminal-pane/TerminalPane'
import { TerminalRestoringPlaceholder } from '../../terminal-pane/mounting/TerminalRestoringPlaceholder'
import { findActivityTerminalPortal } from '../../activity/terminal-portal/activity-terminal-portal'
import { shouldMountBackgroundWorktreeTab } from '../workspace-mounting/background-terminal-worktree-mount'
import { resolveWorkspaceRowKeyFromStore } from '../../terminal-workspace-session-row'
import type { TerminalController } from './use-terminal-controller'

export function TerminalLegacyTerminalPanes({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const {
    activeTabId,
    activeTabType,
    activeView,
    activityTerminalPortals,
    backgroundMountTabIdsByWorktreeRef,
    effectiveParkedTerminalWorktreeIds,
    evictionExemptTerminalTabIds,
    handleCloseTab,
    handlePtyExit,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    tabsByWorktree,
    worktreeBrowserTabs,
    worktreeFiles,
    workspaceSurfaces
  } = controller
  return (
    <div
      className={`relative flex-1 min-h-0 overflow-hidden ${
        (activeTabType === 'editor' && worktreeFiles.length > 0) ||
        (activeTabType === 'browser' && worktreeBrowserTabs.length > 0) ||
        activeTabType === 'simulator'
          ? 'hidden'
          : ''
      }`}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const isVisible = activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
          const shouldMeasureHiddenWorktree =
            !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
          const shouldColdParkTerminalPanes =
            !isVisible &&
            !shouldMeasureHiddenWorktree &&
            effectiveParkedTerminalWorktreeIds.has(workspace.id)
          // Why the row key: the surface list is bare-id keyed (one surface per workspace), so a
          // contested id's tab row — host-qualified — has to be asked for by name. The active
          // surface's host is the user's own pick, which the shared resolver honors over the
          // catalog's first-wins row.
          const rowKey = resolveWorkspaceRowKeyFromStore(workspace.id)
          return (
            <div
              key={workspace.id}
              className={
                isVisible
                  ? 'absolute inset-0'
                  : shouldMeasureHiddenWorktree
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'absolute inset-0 hidden'
              }
              aria-hidden={!isVisible}
            >
              {(tabsByWorktree[rowKey] ?? []).map((tab) => {
                const isActiveTerminalTab =
                  isVisible && tab.id === activeTabId && activeTabType === 'terminal'
                if (
                  !shouldMountBackgroundWorktreeTab(
                    backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null,
                    tab.id
                  )
                ) {
                  // Only startup-held tabs remain visibly deferred; reveal admits other visible tabs in this render.
                  return isActiveTerminalTab ? <TerminalRestoringPlaceholder key={tab.id} /> : null
                }
                const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
                  worktreeId: workspace.id,
                  tabId: tab.id
                })
                const isActivityPortalTab = activityTerminalPortal !== null
                if (
                  shouldColdParkTerminalPanes &&
                  !isActivityPortalTab &&
                  !evictionExemptTerminalTabIds.has(tab.id)
                ) {
                  return null
                }
                const terminalPane = (
                  <TerminalPane
                    // Why the row key: the two rows of a contested id can hold the SAME tab id
                    // (mirrored `web-terminal-<hostTabId>`), so switching hosts must change the
                    // mount identity or the pane keeps its xterm on the other host's dead stream.
                    // An uncontested id resolves to the bare row key, keeping the key byte-identical.
                    key={`${rowKey === workspace.id ? '' : `${rowKey}|`}${tab.id}-${tab.generation ?? 0}`}
                    tabId={tab.id}
                    worktreeId={workspace.id}
                    cwd={tab.startupCwd ?? workspace.path}
                    isActive={isActiveTerminalTab || activityTerminalPortal?.active === true}
                    isVisible={isActiveTerminalTab || isActivityPortalTab}
                    isWorktreeActive={isVisible || isActivityPortalTab}
                    isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
                    onPtyExit={(ptyId, exitCode) => handlePtyExit(tab.id, ptyId, exitCode)}
                    onCloseTab={(reason) => handleCloseTab(tab.id, reason)}
                  />
                )
                if (activityTerminalPortal) {
                  return createPortal(
                    terminalPane,
                    activityTerminalPortal.target,
                    `activity-terminal-${tab.id}`
                  )
                }
                return terminalPane
              })}
            </div>
          )
        })}
    </div>
  )
}
