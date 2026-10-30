import type { AppState } from '@/store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  mergeAgentStatusOrchestration,
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from '@/lib/agent-status-worktree-attribution'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import { applyAgentPaneActivityFlags } from '@/lib/agent-pane-activity-flags'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { getContestedWorktreeIds } from '@/store/worktree-repo-index'
import { agentRowBucketKey } from '../../../../shared/worktree/agent-row-bucket-key'

export type WorktreeAgentActivitySummary = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  /** A fresh failed main agent, also while its subagents run; kept apart from clean done. */
  hasFailed: boolean
  /** Fresh interrupted completion, kept separate from clean done outcomes. */
  hasInterrupted: boolean
  /** A fresh end Orca cannot prove, likewise never a clean done. */
  hasUnconfirmed: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  /** A departed agent's failure; unlike `hasFailed` it yields to live work. */
  hasRetainedFailed: boolean
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
  /** Stale rows suppress generated permission labels while preserving native title fallback. */
  stalePaneIdsByTabId: Record<string, ReadonlySet<string>>
}

const EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID: Record<string, ReadonlySet<string>> = {}

const EMPTY_SUMMARY: WorktreeAgentActivitySummary = {
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveMonitoring: false,
  hasFailed: false,
  hasInterrupted: false,
  hasUnconfirmed: false,
  hasLiveDone: false,
  hasRetainedDone: false,
  hasRetainedFailed: false,
  agentStatusPaneIdsByTabId: EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID,
  stalePaneIdsByTabId: EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID
}

type AgentActivityTabsByWorktree = Record<string, readonly { id: string }[]>

export type AgentActivityInput = Pick<
  AppState,
  | 'agentStatusEpoch'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
> & {
  tabsByWorktree: AgentActivityTabsByWorktree
  runtimeAgentOrchestrationByPaneKey?: AppState['runtimeAgentOrchestrationByPaneKey']
  /** Only the contested-id set is read; an absent catalog means no collision. */
  worktreesByRepo?: AppState['worktreesByRepo']
}

type AgentActivityCache = {
  tabsByWorktree: AgentActivityTabsByWorktree
  agentStatusEpoch: number
  migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId']
  retainedAgentsByPaneKey: AppState['retainedAgentsByPaneKey']
  runtimeAgentOrchestrationByPaneKey: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
  worktreesByRepo: AppState['worktreesByRepo'] | undefined
  summaries: Map<string, WorktreeAgentActivitySummary>
}

let agentActivityCache: AgentActivityCache | null = null

/**
 * The summary for one card, keyed by the card's SESSION ROW KEY (STA-4343): a
 * contested id's rows live under `host|id`, so a bare read would show every
 * claimant the same agent's state — the bug behind one host's spinner painting
 * every host's card. An uncontested id keeps the bare key byte-identically.
 */
export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  return getWorktreeAgentActivitySummaries(state).get(worktreeId) ?? EMPTY_SUMMARY
}

function getWorktreeAgentActivitySummaries(
  state: AgentActivityInput
): Map<string, WorktreeAgentActivitySummary> {
  const runtimeAgentOrchestrationByPaneKey = state.runtimeAgentOrchestrationByPaneKey
  const worktreesByRepo = state.worktreesByRepo
  if (
    agentActivityCache &&
    agentActivityCache.tabsByWorktree === state.tabsByWorktree &&
    agentActivityCache.agentStatusEpoch === state.agentStatusEpoch &&
    agentActivityCache.migrationUnsupportedByPtyId === state.migrationUnsupportedByPtyId &&
    agentActivityCache.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey &&
    agentActivityCache.runtimeAgentOrchestrationByPaneKey === runtimeAgentOrchestrationByPaneKey &&
    agentActivityCache.worktreesByRepo === worktreesByRepo
  ) {
    return agentActivityCache.summaries
  }
  const contested = getContestedWorktreeIds(worktreesByRepo)

  // Why: status dots render once per visible worktree. Build the tab/worktree
  // index once per store snapshot so agent pings are O(worktrees + agents),
  // not O(worktrees * agents).
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }

  const summaries = new Map<string, WorktreeAgentActivitySummary>()
  const summaryForWorktree = (worktreeId: string): WorktreeAgentActivitySummary => {
    let summary = summaries.get(worktreeId)
    if (!summary) {
      summary = { ...EMPTY_SUMMARY }
      summaries.set(worktreeId, summary)
    }
    return summary
  }

  const now = Date.now()
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const paneIdentity = parseAgentStatusPaneIdentity(paneKey)
    if (!paneIdentity) {
      continue
    }
    const orchestration = mergeAgentStatusOrchestration(
      entry,
      runtimeAgentOrchestrationByPaneKey?.[paneKey]
    )
    const resolvedWorktreeId = resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId, orchestration)
    if (!resolvedWorktreeId) {
      continue
    }
    // Why the row key (STA-4343): a paired host reports its OWN bare id, so the
    // resolved id alone merges both claimants' rows into one bucket — the bug
    // behind one host's working agent spinning every host's card. The entry's
    // transport stamp names the host, exactly as the sidebar's inline rows
    // bucket them (`liveEntryWorktreeId`); an uncontested id keeps the bare key.
    const remote = Boolean(entry.connectionId) || isWebTerminalSurfaceTabId(paneIdentity.tabId)
    const worktreeId =
      agentRowBucketKey({
        worktreeId: resolvedWorktreeId,
        // A mirrored tab id can collide, so the tab index is not evidence here.
        tabRowKey: remote ? undefined : tabIdToWorktreeId.get(paneIdentity.tabId),
        tabId: paneIdentity.tabId,
        entry,
        contested
      }) ?? resolvedWorktreeId
    const summary = summaryForWorktree(worktreeId)
    if (entry.restoredUnconfirmed) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
      continue
    }
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      // Why: staleness ends this row's authority but not the pane's identity — see
      // `stalePaneIdsByTabId`. Dropping both let Orca's self-authored permission title outlive
      // the row it came from and pin the card to a question nobody was asking.
      addStalePaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
      continue
    }
    addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    if (entry.state === 'done') {
      addParentPaneId(summary, orchestration, worktreeId, tabIdToWorktreeId)
    }
    applyAgentPaneActivityFlags(summary, entry)
  }

  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId ?? {})) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    const worktreeId = entry ? worktreeIdForPaneKey(entry.paneKey, tabIdToWorktreeId) : null
    if (worktreeId) {
      summaryForWorktree(worktreeId).hasPermission = true
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey ?? {})) {
    // The retained row's own worktreeId stays bare by design; the bucket is the
    // card's row key, so a contested id splits per host like the live rows
    // (same rule as the sidebar's inline rows in `worktree-agent-row-selectors`).
    const bucketedWorktreeId =
      agentRowBucketKey({
        worktreeId: retained.worktreeId,
        tabRowKey: tabIdToWorktreeId.get(retained.tab.id),
        tabId: retained.tab.id,
        entry: retained.entry,
        contested
      }) ?? retained.worktreeId
    const summary = summaryForWorktree(bucketedWorktreeId)
    // Why: a failed agent is retained so its failure stays visible, not so it reads done.
    if (agentVerdictDisplayMark(retained.entry) === 'failed') {
      summary.hasRetainedFailed = true
    } else {
      summary.hasRetainedDone = true
    }
    const paneIdentity = parseAgentStatusPaneIdentity(retained.entry?.paneKey)
    if (paneIdentity) {
      addAgentStatusPaneId(summary, paneIdentity.tabId, paneIdentity.paneId)
    }
    const orchestration = mergeAgentStatusOrchestration(
      retained.entry,
      runtimeAgentOrchestrationByPaneKey?.[retained.entry.paneKey]
    )
    addParentPaneId(summary, orchestration, bucketedWorktreeId, tabIdToWorktreeId)
  }

  // Why: epoch changes rebuild every summary, so reuse structurally equal results
  // to keep unrelated worktree subscriptions from scheduling card renders.
  const previousSummaries = agentActivityCache?.summaries
  if (previousSummaries) {
    for (const [worktreeId, summary] of summaries) {
      const previous = previousSummaries.get(worktreeId)
      if (previous && summariesEqual(previous, summary)) {
        summaries.set(worktreeId, previous)
      }
    }
  }

  agentActivityCache = {
    tabsByWorktree: state.tabsByWorktree,
    agentStatusEpoch: state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    runtimeAgentOrchestrationByPaneKey,
    worktreesByRepo,
    summaries
  }
  return summaries
}

function summariesEqual(
  previous: WorktreeAgentActivitySummary,
  next: WorktreeAgentActivitySummary
): boolean {
  return (
    previous.hasPermission === next.hasPermission &&
    previous.hasLiveWorking === next.hasLiveWorking &&
    previous.hasLiveMonitoring === next.hasLiveMonitoring &&
    previous.hasFailed === next.hasFailed &&
    previous.hasInterrupted === next.hasInterrupted &&
    previous.hasUnconfirmed === next.hasUnconfirmed &&
    previous.hasLiveDone === next.hasLiveDone &&
    previous.hasRetainedDone === next.hasRetainedDone &&
    previous.hasRetainedFailed === next.hasRetainedFailed &&
    agentStatusPaneIdsByTabIdEqual(
      previous.agentStatusPaneIdsByTabId,
      next.agentStatusPaneIdsByTabId
    ) &&
    agentStatusPaneIdsByTabIdEqual(previous.stalePaneIdsByTabId, next.stalePaneIdsByTabId)
  )
}

function agentStatusPaneIdsByTabIdEqual(
  previous: Record<string, ReadonlySet<string>>,
  next: Record<string, ReadonlySet<string>>
): boolean {
  if (previous === next) {
    return true
  }
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== Object.keys(next).length) {
    return false
  }
  for (const tabId of previousKeys) {
    const previousPaneIds = previous[tabId]
    const nextPaneIds = next[tabId]
    if (!nextPaneIds || previousPaneIds.size !== nextPaneIds.size) {
      return false
    }
    for (const paneId of previousPaneIds) {
      if (!nextPaneIds.has(paneId)) {
        return false
      }
    }
  }
  return true
}

function addAgentStatusPaneId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  paneId: string
): void {
  summary.agentStatusPaneIdsByTabId = withPaneId(summary.agentStatusPaneIdsByTabId, tabId, paneId)
}

function addStalePaneId(
  summary: WorktreeAgentActivitySummary,
  tabId: string,
  paneId: string
): void {
  summary.stalePaneIdsByTabId = withPaneId(summary.stalePaneIdsByTabId, tabId, paneId)
}

function withPaneId(
  byTabId: Record<string, ReadonlySet<string>>,
  tabId: string,
  paneId: string
): Record<string, ReadonlySet<string>> {
  // Why: the shared empty record is the frozen default for every summary; copy on first write.
  const next = byTabId === EMPTY_AGENT_STATUS_PANE_IDS_BY_TAB_ID ? {} : byTabId
  let paneIds = next[tabId] as Set<string> | undefined
  if (!paneIds) {
    paneIds = new Set<string>()
    next[tabId] = paneIds
  }
  paneIds.add(paneId)
  return next
}

function worktreeIdForPaneKey(
  paneKey: string | undefined,
  tabIdToWorktreeId: Map<string, string>
): string | null {
  const paneIdentity = parseAgentStatusPaneIdentity(paneKey)
  return paneIdentity ? (tabIdToWorktreeId.get(paneIdentity.tabId) ?? null) : null
}

function addParentPaneId(
  summary: WorktreeAgentActivitySummary,
  orchestration: AgentStatusOrchestrationContext | undefined,
  worktreeId: string,
  tabIdToWorktreeId: Map<string, string>
): void {
  const parentPaneIdentity = parseAgentStatusPaneIdentity(orchestration?.parentPaneKey)
  if (!parentPaneIdentity) {
    return
  }
  // Why: a completed worker can be the only visible row for a worktree while
  // its parent pane still carries a stale spinner title. Let that row own the
  // parent pane's title for this worktree without touching other worktrees.
  if (tabIdToWorktreeId.get(parentPaneIdentity.tabId) !== worktreeId) {
    return
  }
  addAgentStatusPaneId(summary, parentPaneIdentity.tabId, parentPaneIdentity.paneId)
}
