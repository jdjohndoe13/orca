import { useShallow } from 'zustand/react/shallow'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { useAppStore } from '../../../store/index'
import { resolveWorkspaceRowKey } from '../../terminal-workspace-session-row'
import { useTabGroupItemProjections } from './useTabGroupItemProjections'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'
import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserWorkspace[] = []
const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: NonNullable<
  ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
> = {}

export function useTabGroupWorkspaceModel({
  groupId,
  worktreeId
}: {
  groupId: string
  worktreeId: string
}) {
  const worktreeState = useAppStore(
    useShallow((state) => {
      // Why the row key: the split surface hands this hook the bare worktree id (the workbench
      // mounts one surface per id), while a contested id's rows live under `host|id`. Resolved
      // inside the selector so a host switch — which keeps the bare id — re-points the read.
      const rowKey = resolveWorkspaceRowKey(state, worktreeId)
      return {
        // Why: reuse stable EMPTY_* fallbacks; fresh `?? []` arrays break Zustand v5 snapshot identity and cause an infinite render loop.
        groups: state.groupsByWorktree[rowKey] ?? EMPTY_GROUPS,
        unifiedTabs: state.unifiedTabsByWorktree[rowKey] ?? EMPTY_UNIFIED_TABS,
        terminalTabs: state.tabsByWorktree[rowKey] ?? EMPTY_TERMINAL_TABS,
        openFiles: state.openFiles,
        browserTabs: state.browserTabsByWorktree[rowKey] ?? EMPTY_BROWSER_TABS,
        expandedPaneByTabId: state.expandedPaneByTabId,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID,
        generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
        mobileEmulatorEnabled: state.settings?.mobileEmulatorEnabled !== false
      }
    })
  )

  const focusGroup = useAppStore((state) => state.focusGroup)
  const makePreviewFilePermanent = useAppStore((state) => state.makePreviewFilePermanent)
  const pinFile = useAppStore((state) => state.pinFile)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)

  const {
    group,
    groupTabs,
    activeTab,
    terminalTabs,
    editorItems,
    browserItems,
    agentSessionItems,
    tabBarOrder
  } = useTabGroupItemProjections({ groupId, worktreeId, worktreeState })

  const { closeItem, closeMany } = useTabGroupTabCloseCommands({ worktreeId })

  const { closeGroup, closeAllEditorTabsInGroup, closeOthers, closeToRight, closeToLeft } =
    useTabGroupCloseScopeCommands({
      groupId,
      worktreeId,
      closeItem,
      closeMany
    })

  const {
    activateTerminal,
    toggleTerminalPaneExpand,
    activateEditor,
    activateBrowser,
    activateAgentSession
  } = useTabGroupActivationCommands({ groupId, worktreeId, groupTabs, worktreeState })

  const creationCommands = useTabGroupCreationCommands({ groupId, worktreeId, worktreeState })

  return {
    group,
    activeTab,
    browserItems,
    editorItems,
    agentSessionItems,
    terminalTabs,
    tabBarOrder,
    groupTabs,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateAgentSession,
      activateBrowser,
      activateEditor,
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      closeToLeft,
      ...creationCommands,
      makePreviewFilePermanent,
      pinFile,
      setTabColor,
      setTabCustomTitle,
      toggleTerminalPaneExpand
    }
  }
}
