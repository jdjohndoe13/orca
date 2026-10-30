import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { resolveAgentStatusWorktreeId } from './agent-status-worktree-attribution'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { ContestedWorkspaceIds } from '../../../shared/workspace-session-worktree-key'
import { agentRowBucketKey } from '../../../shared/worktree/agent-row-bucket-key'

type TerminalLikeTab = Pick<TerminalTab, 'id'>
type BrowserLikeTab = { id: string }

type TabsByWorktree = Record<string, readonly TerminalLikeTab[]>
type PtyIdsByTabId = Record<string, string[]>
type BrowserTabsByWorktree = Record<string, readonly BrowserLikeTab[]>
export type LiveAgentWorktreeStatus = 'working' | 'monitoring' | 'permission'

const EMPTY_WORKTREE_IDS: ReadonlySet<string> = new Set()

/**
 * Session row keys (STA-4343) that currently have a live agent session,
 * derived from the live `agentStatusByPaneKey` map. A contested id's rows
 * bucket under `host|id` — the same spelling the card reads its tabs by — so
 * one host's agent never keeps another claimant's card awake.
 *
 * Why only fresh in-progress rows: disconnected SSH and completed headless
 * agents can retain status entries without an open session.
 */
export function getWorktreeIdsWithLiveAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | null | undefined,
  tabsByWorktree: TabsByWorktree | null | undefined,
  now: number,
  contested?: ContestedWorkspaceIds
): Set<string> {
  return new Set(
    getLiveAgentStatusByWorktreeId(agentStatusByPaneKey, tabsByWorktree, now, contested).keys()
  )
}

export function getLiveAgentStatusByWorktreeId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | null | undefined,
  tabsByWorktree: TabsByWorktree | null | undefined,
  now: number,
  contested?: ContestedWorkspaceIds
): Map<string, LiveAgentWorktreeStatus> {
  const entries = Object.values(agentStatusByPaneKey ?? {}).filter((entry) =>
    isFreshNonDoneAgentStatus(entry, now)
  )
  if (entries.length === 0) {
    return new Map()
  }
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  const result = new Map<string, LiveAgentWorktreeStatus>()
  for (const entry of entries) {
    const resolvedWorktreeId = resolveAgentStatusWorktreeId(entry, worktreeIdByTabId)
    if (!resolvedWorktreeId) {
      continue
    }
    // Why the row key (STA-4343): a paired host reports its OWN bare id, so the
    // resolved id alone merges both claimants' rows into one bucket — the bug
    // behind one host's agent keeping every claimant's card awake. The entry's
    // transport stamp names the host, exactly as the sidebar's inline rows
    // bucket them (`agentRowBucketKey`); an uncontested id keeps the bare key.
    const tabId = entry.paneKey ? parsePaneTabId(entry.paneKey) : undefined
    const remote = Boolean(entry.connectionId) || isWebTerminalSurfaceTabId(tabId ?? '')
    const worktreeId =
      agentRowBucketKey({
        worktreeId: resolvedWorktreeId,
        // A mirrored tab id can collide, so the tab index is not evidence here.
        tabRowKey: remote ? undefined : tabId ? worktreeIdByTabId.get(tabId) : undefined,
        tabId: tabId ?? '',
        entry,
        contested
      }) ?? resolvedWorktreeId
    const status =
      entry.state === 'working'
        ? entry.workingMode === 'monitoring'
          ? 'monitoring'
          : 'working'
        : 'permission'
    const current = result.get(worktreeId)
    if (
      status === 'permission' ||
      current === undefined ||
      (status === 'working' && current === 'monitoring')
    ) {
      result.set(worktreeId, status)
    }
  }
  return result
}

function parsePaneTabId(paneKey: string): string | undefined {
  const parsed = parsePaneKey(paneKey)
  return parsed?.tabId
}

/**
 * Whether the workspace's activity is awake. `rowKey` is the workspace's
 * SESSION ROW KEY (STA-4343): a contested id's rows live under `host|id`, so
 * every read here must use the same spelling or the card reads no tabs at all
 * and a live console reads as asleep.
 */
function hasActiveWorkspaceActivity(
  rowKey: string,
  tabsByWorktree: TabsByWorktree | null | undefined,
  ptyIdsByTabId: PtyIdsByTabId | null | undefined,
  browserTabsByWorktree: BrowserTabsByWorktree | null | undefined,
  worktreeIdsWithLiveAgent: ReadonlySet<string>,
  worktreeIdsWithStructuredChat: ReadonlySet<string> = EMPTY_WORKTREE_IDS
): boolean {
  const tabs = tabsByWorktree?.[rowKey] ?? []
  const hasLiveTerminal =
    ptyIdsByTabId != null && tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  const hasBrowser = (browserTabsByWorktree?.[rowKey] ?? []).length > 0
  // Why: a running agent keeps the workspace visible through brief PTY gaps
  // such as an SSH reconnect or an unmounted remote pane. #7197
  const hasLiveAgent = worktreeIdsWithLiveAgent.has(rowKey)
  // Why not folded into hasLiveTerminal: a structured chat has no PTY and no entry in
  // tabsByWorktree, so every terminal-shaped signal above reads it as absent.
  const hasStructuredChat = worktreeIdsWithStructuredChat.has(rowKey)
  return hasLiveTerminal || hasBrowser || hasLiveAgent || hasStructuredChat
}

export function isInactiveWorkspace(
  rowKey: string,
  tabsByWorktree: TabsByWorktree | null | undefined,
  ptyIdsByTabId: PtyIdsByTabId | null | undefined,
  browserTabsByWorktree: BrowserTabsByWorktree | null | undefined,
  worktreeIdsWithLiveAgent: ReadonlySet<string>,
  worktreeIdsWithStructuredChat: ReadonlySet<string> = EMPTY_WORKTREE_IDS
): boolean {
  return !hasActiveWorkspaceActivity(
    rowKey,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  )
}
