import { useAppStore } from '@/store/index'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import {
  getWorktreeIdsWithLiveAgent,
  isInactiveWorkspace
} from '@/lib/workspace/activity/worktree-activity-state'
import { getWorktreeIdsWithStructuredChat } from '../../worktree-list/listing/visible-worktree-activity-inputs'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  hasUnknownStructuredChat,
  type StructuredChatSleptAtByPaneKey
} from '@/store/slices/agent-status/structured-sessions/structured-chat-slept-at'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getContestedWorktreeIds } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { resolveWorkspaceSessionHost } from '@/store/workspace-session-key'
import { workspaceSessionKey } from '../../../../../../shared/workspace-session-worktree-key'

type TabLike = { id: string }

// Partial store mocks may omit slices; shared predicates treat absence as empty.
type SleepStateInput = {
  agentStatusByPaneKey?: ReadonlyMap<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
  structuredChatSleptAtByPaneKey?: StructuredChatSleptAtByPaneKey
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

// Cache the whole-store live-agent scan across cards by relevant snapshots and freshness epoch.
export function selectWorktreeIdsWithLiveAgent(state: SleepStateInput): ReadonlySet<string> {
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
  // The rows live under the SESSION ROW KEY (STA-4343): a contested id's tabs and
  // chats carry the host prefix, so a bare read would find nothing for either
  // claimant and paint a moon on a card with a live console. An uncontested id
  // keeps the bare key byte-identically.
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
  if (
    hasUnknownStructuredChat(
      state.unifiedTabsByWorktree?.[rowKey],
      state.structuredChatSleptAtByPaneKey
    )
  ) {
    return false
  }
  return isInactiveWorkspace(
    rowKey,
    state.tabsByWorktree,
    state.ptyIdsByTabId,
    state.browserTabsByWorktree,
    selectWorktreeIdsWithLiveAgent(state),
    getWorktreeIdsWithStructuredChat(
      state.unifiedTabsByWorktree,
      state.structuredChatSleptAtByPaneKey
    )
  )
}

export function useIsSleepingWorktree(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): boolean {
  return useAppStore((state) => selectIsSleepingWorktree(state, worktreeId, hostId))
}
