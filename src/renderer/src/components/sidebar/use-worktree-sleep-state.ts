import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getContestedWorktreeIds } from '@/store/worktree-repo-index'
import { resolveWorkspaceSessionHost } from '@/store/workspace-session-key'
import { workspaceSessionKey } from '../../../../shared/workspace-session-worktree-key'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'

type TabLike = { id: string }

// Why optional: suites mount cards with partial store mocks, and the shared
// predicate already reads a missing slice as empty.
type SleepStateInput = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
  /** Only the contested-id set is read; an absent catalog means no collision. */
  worktreesByRepo?: AppState['worktreesByRepo']
  activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
  activeWorktreeId?: AppState['activeWorktreeId']
}

type LiveAgentGeneration = {
  agentStatusByPaneKey: SleepStateInput['agentStatusByPaneKey']
  tabsByWorktree: SleepStateInput['tabsByWorktree']
  worktreesByRepo: SleepStateInput['worktreesByRepo']
  agentStatusNow: number
  worktreeIds: ReadonlySet<string>
}

let liveAgentGeneration: LiveAgentGeneration | null = null

// Why cached across cards: zustand re-runs every mounted card's selector on every
// store write, and the live-agent set is a whole-store scan. Keyed on the same
// slices plus the status epoch, so it rebuilds exactly when the filter's own
// snapshot would.
function selectWorktreeIdsWithLiveAgent(state: SleepStateInput): ReadonlySet<string> {
  const agentStatusNow = getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
  if (
    liveAgentGeneration &&
    liveAgentGeneration.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    liveAgentGeneration.tabsByWorktree === state.tabsByWorktree &&
    liveAgentGeneration.worktreesByRepo === state.worktreesByRepo &&
    liveAgentGeneration.agentStatusNow === agentStatusNow
  ) {
    return liveAgentGeneration.worktreeIds
  }
  const worktreeIds = getWorktreeIdsWithLiveAgent(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    agentStatusNow,
    getContestedWorktreeIds(state.worktreesByRepo)
  )
  liveAgentGeneration = {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    worktreesByRepo: state.worktreesByRepo,
    agentStatusNow,
    worktreeIds
  }
  return worktreeIds
}

/**
 * Whether a workspace is asleep: no live terminal, no browser tab, no live
 * agent holding it awake through a PTY gap, and no structured chat.
 *
 * Why not `status === 'inactive'`: a slept workspace keeps its retained done
 * rows, so its status still reads 'done' — keying the sleeping glyph on status
 * misses exactly the completed-but-slept cards it must distinguish (#19624).
 *
 * Why `isInactiveWorkspace`: the hide-sleeping filter decides with that same
 * predicate, so the moon and the filter cannot disagree about which workspaces
 * are asleep.
 *
 * `hostId` is the card's own row's host (STA-4343): the rows live under the
 * session row key, so a bare read of a contested id would find no tabs and
 * paint a moon on a card with a live console.
 */
export function selectIsSleepingWorktree(
  state: SleepStateInput,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): boolean {
  const rowKey = workspaceSessionKey(
    worktreeId,
    resolveWorkspaceSessionHost(
      {
        activeWorktreeId: state.activeWorktreeId ?? null,
        activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId ?? null
      },
      worktreeId,
      hostId
    ),
    getContestedWorktreeIds(state.worktreesByRepo)
  )
  return isInactiveWorkspace(
    rowKey,
    state.tabsByWorktree,
    state.ptyIdsByTabId,
    state.browserTabsByWorktree,
    selectWorktreeIdsWithLiveAgent(state),
    getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree)
  )
}

export function useIsSleepingWorktree(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): boolean {
  return useAppStore((state) => selectIsSleepingWorktree(state, worktreeId, hostId))
}

export function resetWorktreeSleepStateCacheForTests(): void {
  liveAgentGeneration = null
}
