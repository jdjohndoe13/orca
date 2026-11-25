// Fork split: the dashboard snapshot's store-shape types, moved out so the builder
// stays inside its max-lines budget.
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { AppState } from '@/store/types'
import type { DashboardCardTerminalInputState } from './dashboard-card-terminal-input'
import type { DashboardCardContextState } from './dashboard-card-context'

/** Keep builder inputs as a Pick so tests need only construct the store slices read here. */
export type DashboardSnapshotState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'acknowledgedAgentsByPaneKey'
  | 'settings'
> &
  Pick<AppState, 'remoteAgentOrchestrationByHost'> &
  DashboardCardContextState &
  Partial<
    DashboardCardTerminalInputState &
      Pick<
        AppState,
        | 'runtimeEnvironments'
        | 'sshTargetLabels'
        | 'unifiedTabsByWorktree'
        | 'activeWorktreeId'
        | 'activeWorkspaceExecutionHostId'
      >
  >

export type DashboardSnapshotInput = DashboardSnapshotState & { chatNames: StructuredChatTabNames }
