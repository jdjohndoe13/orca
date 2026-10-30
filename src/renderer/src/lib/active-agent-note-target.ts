import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { resolveWorkspaceSessionKey } from '@/store/workspace-session-key'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  classifyTitleActivity,
  isExplicitAgentStatusFresh,
  resolveTitleActivityLabel
} from '@/lib/pane-agent-evidence'
import { resolveRuntimePaneTitleForLeaf } from './runtime-pane-title-leaf-id'

const ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS = 3000
const ACTIVE_AGENT_TERMINAL_LIST_LIMIT = 200

export type ActiveTerminalNoteTarget = {
  tabId: string
  leafId: string
}

export type ActiveTerminalNoteTargetState = {
  activeWorktreeId: AppState['activeWorktreeId']
  activeTabType: AppState['activeTabType']
  activeTabId: AppState['activeTabId']
  activeTabIdByWorktree: AppState['activeTabIdByWorktree']
  tabsByWorktree: Record<
    string,
    readonly { id: string; title?: string; launchAgent?: unknown }[] | undefined
  >
  ptyIdsByTabId?: Record<string, readonly string[] | undefined>
  terminalLayoutsByTabId: Record<
    string,
    | {
        activeLeafId: string | null
        root?: TerminalLayoutSnapshot['root']
        ptyIdsByLeafId?: Record<string, string | undefined>
      }
    | undefined
  >
  runtimePaneTitlesByTabId?: Record<string, Record<number, string> | undefined>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry | undefined>
  settings: Parameters<typeof getActiveRuntimeTarget>[0]
  // The note target only ever resolves for the ACTIVE worktree (the guard below), so
  // the row key needs the active host stamp and the catalog's contested set — read
  // from the store rather than threaded through every caller.
  activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
  repos?: AppState['repos']
  worktreesByRepo?: AppState['worktreesByRepo']
}

type ActiveAgentRuntimeProbeDescriptor = {
  key: string
  worktreeId: string
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>
  noteTarget: ActiveTerminalNoteTarget
}

/**
 * The tab rows live under the worktree's SESSION ROW KEY (STA-4343): a contested
 * id's rows carry the host prefix, so a bare read would find no tab and the note
 * send would silently target nothing. The host here is the active workspace's own
 * stamp, which the callers' guard just proved applies.
 */
function noteTargetRowKey(state: ActiveTerminalNoteTargetState, worktreeId: string): string {
  return resolveWorkspaceSessionKey(
    {
      worktreesByRepo: state.worktreesByRepo ?? {},
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId ?? null,
      activeWorktreeId: state.activeWorktreeId
    },
    worktreeId
  )
}

export function getActiveTerminalNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string
): ActiveTerminalNoteTarget | null {
  if (state.activeWorktreeId !== worktreeId) {
    return null
  }

  const rowKey = noteTargetRowKey(state, worktreeId)
  const tabId =
    state.activeTabType === 'terminal'
      ? (state.activeTabId ?? state.activeTabIdByWorktree[rowKey])
      : state.activeTabIdByWorktree[rowKey]
  if (!tabId || !(state.tabsByWorktree[rowKey] ?? []).some((tab) => tab.id === tabId)) {
    return null
  }

  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  return leafId ? { tabId, leafId } : null
}

export function getActiveAgentNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  now = Date.now()
): ActiveTerminalNoteTarget | null {
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget || !isTerminalLeafId(noteTarget.leafId)) {
    return null
  }

  const activePtyId = getActivePanePtyId(state, noteTarget)
  if (!activePtyId) {
    return null
  }

  const entry = state.agentStatusByPaneKey?.[makePaneKey(noteTarget.tabId, noteTarget.leafId)]
  if (entry && isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return noteTarget
  }
  // Why: freshly opened agents can be idle before their first hook event. Use
  // renderer title/launch hints only to show the option; runtime still verifies
  // the focused terminal is an idle agent before sending Enter.
  if (!hasFocusedPaneAgentHint(state, worktreeId, noteTarget)) {
    return null
  }

  return noteTarget
}

export function getActiveAgentRuntimeProbeDescriptor(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string
): ActiveAgentRuntimeProbeDescriptor | null {
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget || !isTerminalLeafId(noteTarget.leafId)) {
    return null
  }
  const activePtyId = getActivePanePtyId(state, noteTarget)
  if (!activePtyId) {
    return null
  }
  // Route by the worktree's owner host so the probe targets the host that runs
  // this worktree's agent terminal, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  )
  const runtimeKey =
    runtimeTarget.kind === 'environment' ? `env:${runtimeTarget.environmentId}` : 'local'
  return {
    key: `${runtimeKey}:${worktreeId}:${noteTarget.tabId}:${noteTarget.leafId}:${activePtyId}`,
    worktreeId,
    runtimeTarget,
    noteTarget
  }
}

export async function probeActiveAgentNoteTarget({
  worktreeId,
  runtimeTarget,
  noteTarget
}: ActiveAgentRuntimeProbeDescriptor): Promise<boolean> {
  const terminal = await findActiveRuntimeTerminal(
    runtimeTarget,
    worktreeId,
    noteTarget,
    ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS
  )
  if (!terminal) {
    return false
  }
  const agentCheck = await callRuntimeRpc<{ isRunningAgent: boolean }>(
    runtimeTarget,
    'terminal.isRunningAgent',
    { terminal: terminal.handle },
    { timeoutMs: ACTIVE_AGENT_PROBE_RPC_TIMEOUT_MS }
  )
  return agentCheck.isRunningAgent
}

export async function findActiveRuntimeTerminal(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget,
  timeoutMs: number
): Promise<RuntimeTerminalListResult['terminals'][number] | null> {
  const { terminals } = await callRuntimeRpc<RuntimeTerminalListResult>(
    runtimeTarget,
    'terminal.list',
    // Why: worktree ids can look like branch names or paths; keep the lookup unambiguous.
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      limit: ACTIVE_AGENT_TERMINAL_LIST_LIMIT,
      includeVisualLayouts: false
    },
    { timeoutMs }
  )
  // Why: paired renderer tabs wrap the host id with `web-terminal-*`.
  const runtimeTabId = toHostSessionTabId(noteTarget.tabId)
  return (
    terminals.find(
      (terminal) => terminal.tabId === runtimeTabId && terminal.leafId === noteTarget.leafId
    ) ?? null
  )
}

function getActivePanePtyId(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  const livePtyIds = state.ptyIdsByTabId?.[noteTarget.tabId] ?? []
  if (livePtyIds.length === 0) {
    return null
  }

  const ptyIdsByLeafId = state.terminalLayoutsByTabId[noteTarget.tabId]?.ptyIdsByLeafId
  if (ptyIdsByLeafId && Object.keys(ptyIdsByLeafId).length > 0) {
    const activeLeafPtyId = ptyIdsByLeafId[noteTarget.leafId]
    // Why: layout maps can survive sleep/reconnect; ptyIdsByTabId is the live
    // PTY source of truth for whether submitting with Enter is currently safe.
    return activeLeafPtyId && livePtyIds.includes(activeLeafPtyId) ? activeLeafPtyId : null
  }
  return livePtyIds[0] ?? null
}

function hasFocusedPaneAgentHint(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget
): boolean {
  const tab = (state.tabsByWorktree[noteTargetRowKey(state, worktreeId)] ?? []).find(
    (entry) => entry.id === noteTarget.tabId
  )
  const runtimeTitle = getFocusedRuntimePaneTitle(state, noteTarget)
  if (runtimeTitle !== null) {
    return isRecognizedAgentTitle(runtimeTitle)
  }
  if (tab?.launchAgent) {
    return true
  }

  return tab?.title ? isRecognizedAgentTitle(tab.title) : false
}

function getFocusedRuntimePaneTitle(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  return resolveRuntimePaneTitleForLeaf(
    state.terminalLayoutsByTabId[noteTarget.tabId],
    state.runtimePaneTitlesByTabId?.[noteTarget.tabId],
    noteTarget.leafId
  )
}

function isRecognizedAgentTitle(title: string): boolean {
  return classifyTitleActivity(title) !== null && resolveTitleActivityLabel(title) !== null
}
