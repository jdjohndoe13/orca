import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveWorktreeStatus } from '@/lib/worktree-status'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  selectWorktreeAgentActivitySummary,
  type AgentActivityInput
} from './worktree-agent-activity-summary'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  worktreeId?: string
  parentPaneKey?: string
  restoredUnconfirmed?: true
  workingMode?: AgentStatusEntry['workingMode']
  interrupted?: true
  mainAgent?: AgentStatusEntry['mainAgent']
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    restoredUnconfirmed: args.restoredUnconfirmed,
    workingMode: args.workingMode,
    interrupted: args.interrupted,
    mainAgent: args.mainAgent,
    orchestration: args.parentPaneKey
      ? {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey: args.parentPaneKey
        }
      : undefined
  }
}

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('selectWorktreeAgentActivitySummary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds one cached agent summary index for multiple worktree lookups', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const retainedTab = makeTab('tab-2', 'repo::/wt-2')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')],
        'repo::/wt-2': [retainedTab]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {
        'tab-2:0': {
          entry: makeAgentStatusEntry({ paneKey: 'tab-2:0', state: 'done' }),
          worktreeId: 'repo::/wt-2',
          tab: retainedTab,
          agentType: 'claude',
          startedAt: 1_000
        }
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true,
      hasRetainedDone: false
    })
    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-2')).toMatchObject({
      hasLiveWorking: false,
      hasRetainedDone: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached summary when same-state agent pings only clone the status map', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const tabsByWorktree = {
      'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')]
    }
    const migrationUnsupportedByPtyId = {}
    const retainedAgentsByPaneKey = {}
    const entry = makeAgentStatusEntry({ paneKey, state: 'working' })
    const state: AgentActivityInput = {
      tabsByWorktree,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [paneKey]: entry
      },
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey
    }
    const sameStatePing = {
      ...state,
      agentStatusByPaneKey: {
        [paneKey]: {
          ...entry,
          prompt: 'new prompt preview',
          updatedAt: 1_500
        }
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true
    })
    expect(selectWorktreeAgentActivitySummary(sameStatePing, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the summary when the agent status epoch changes', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const tabsByWorktree = {
      'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')]
    }
    const migrationUnsupportedByPtyId = {}
    const retainedAgentsByPaneKey = {}
    const state: AgentActivityInput = {
      tabsByWorktree,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'working' })
      },
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey
    }
    const changedState = {
      ...state,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done' })
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: true,
      hasLiveDone: false
    })
    expect(selectWorktreeAgentActivitySummary(changedState, 'repo::/wt-1')).toMatchObject({
      hasLiveWorking: false,
      hasLiveDone: true
    })
    expect(nowSpy).toHaveBeenCalledTimes(2)
  })

  it('separates passive monitoring from active working', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const summary = selectWorktreeAgentActivitySummary(
      {
        tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
        agentStatusEpoch: 1,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({
            paneKey,
            state: 'working',
            workingMode: 'monitoring'
          })
        },
        migrationUnsupportedByPtyId: {},
        runtimeAgentOrchestrationByPaneKey: {},
        retainedAgentsByPaneKey: {}
      },
      'repo::/wt-1'
    )

    expect(summary).toMatchObject({ hasLiveWorking: false, hasLiveMonitoring: true })
  })

  it.each([
    ['success', { hasLiveDone: true }],
    ['failure', { hasFailed: true, hasLiveDone: false }],
    // A user's Stop reads interrupted; a turn anything else cut short is a fault, like a failure.
    ['cancellation', { hasInterrupted: true, hasLiveDone: false }],
    ['interruption', { hasFailed: true, hasInterrupted: false, hasLiveDone: false }],
    ['unconfirmed', { hasUnconfirmed: true, hasLiveDone: false }]
  ] as const)('flags a %s outcome apart from the others', (outcome, flags) => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const summary = selectWorktreeAgentActivitySummary(
      {
        tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
        agentStatusEpoch: 2,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({
            paneKey,
            state: 'done',
            mainAgent: { state: 'done', outcome, stateStartedAt: 1_000 }
          })
        },
        migrationUnsupportedByPtyId: {},
        runtimeAgentOrchestrationByPaneKey: {},
        retainedAgentsByPaneKey: {}
      },
      'repo::/wt-1'
    )

    expect(summary).toMatchObject(flags)
  })

  it('separates a failed outcome from clean completion and from a cancellation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const summary = selectWorktreeAgentActivitySummary(
      {
        tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
        agentStatusEpoch: 3,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({
            paneKey,
            state: 'done',
            mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1_000 }
          })
        },
        migrationUnsupportedByPtyId: {},
        runtimeAgentOrchestrationByPaneKey: {},
        retainedAgentsByPaneKey: {}
      },
      'repo::/wt-1'
    )

    expect(summary).toMatchObject({ hasFailed: true, hasInterrupted: false, hasLiveDone: false })
  })

  it('reports a main agent that failed while its subagents run, beside their pending question', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const summaryFor = (state: 'working' | 'waiting', outcome: 'failure' | 'success') =>
      selectWorktreeAgentActivitySummary(
        {
          tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
          agentStatusEpoch: state === 'working' ? (outcome === 'failure' ? 5 : 6) : 7,
          agentStatusByPaneKey: {
            [paneKey]: makeAgentStatusEntry({
              paneKey,
              state,
              mainAgent: { state: 'done', outcome, stateStartedAt: 1_000 }
            })
          },
          migrationUnsupportedByPtyId: {},
          runtimeAgentOrchestrationByPaneKey: {},
          retainedAgentsByPaneKey: {}
        },
        'repo::/wt-1'
      )

    expect(summaryFor('working', 'failure')).toMatchObject({
      hasFailed: true,
      hasLiveWorking: false
    })
    expect(summaryFor('working', 'success')).toMatchObject({
      hasFailed: false,
      hasLiveWorking: true
    })
    expect(summaryFor('waiting', 'failure')).toMatchObject({ hasFailed: true, hasPermission: true })
  })

  describe('a failed agent on the worktree card', () => {
    const worktreeId = 'repo::/wt-2'
    const liveTab = makeTab('tab-1', worktreeId)
    const retainedTab = makeTab('tab-2', worktreeId)
    const failure = { state: 'done', outcome: 'failure', stateStartedAt: 1_000 } as const
    const workingKey = makePaneKey('tab-1', LEAF_ID)
    const failedKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
    const working = makeAgentStatusEntry({ paneKey: workingKey, state: 'working' })
    const retainedFailure = {
      'tab-2:0': {
        entry: makeAgentStatusEntry({ paneKey: 'tab-2:0', state: 'done', mainAgent: failure }),
        worktreeId,
        tab: retainedTab,
        agentType: 'claude' as const,
        startedAt: 1_000
      }
    }
    let epoch = 100
    const cardFor = (
      agentStatusByPaneKey: AgentActivityInput['agentStatusByPaneKey'],
      retainedAgentsByPaneKey: AgentActivityInput['retainedAgentsByPaneKey']
    ) => {
      vi.spyOn(Date, 'now').mockReturnValue(2_000)
      const summary = selectWorktreeAgentActivitySummary(
        {
          tabsByWorktree: { [worktreeId]: [liveTab, retainedTab] },
          agentStatusEpoch: epoch++,
          agentStatusByPaneKey,
          migrationUnsupportedByPtyId: {},
          runtimeAgentOrchestrationByPaneKey: {},
          retainedAgentsByPaneKey
        },
        worktreeId
      )
      return {
        summary,
        status: resolveWorktreeStatus({ tabs: [], browserTabs: [], ptyIdsByTabId: {}, ...summary })
      }
    }

    it('reads a retained failure as failed once nothing else is live, not done', () => {
      const { summary, status } = cardFor({}, retainedFailure)

      expect(summary).toMatchObject({ hasRetainedFailed: true, hasRetainedDone: false })
      expect(status).toBe('failed')
    })

    it('lets live work outrank a departed agent that failed', () => {
      const { summary, status } = cardFor({ [workingKey]: working }, retainedFailure)

      expect(summary).toMatchObject({ hasFailed: false, hasRetainedFailed: true })
      expect(status).toBe('working')
    })

    it('keeps a live failure above live work', () => {
      const { status } = cardFor(
        {
          [workingKey]: working,
          [failedKey]: makeAgentStatusEntry({
            paneKey: failedKey,
            state: 'done',
            mainAgent: failure
          })
        },
        {}
      )

      expect(status).toBe('failed')
    })
  })

  it('lets an unconfirmed restored row suppress only its pane title', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const summary = selectWorktreeAgentActivitySummary(
      {
        tabsByWorktree: {
          'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')]
        },
        agentStatusEpoch: 0,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({
            paneKey,
            state: 'working',
            restoredUnconfirmed: true
          })
        },
        migrationUnsupportedByPtyId: {},
        runtimeAgentOrchestrationByPaneKey: {},
        retainedAgentsByPaneKey: {}
      },
      'repo::/wt-1'
    )

    expect(summary).toMatchObject({ hasLiveWorking: false, hasPermission: false })
    expect(summary.agentStatusPaneIdsByTabId['tab-1']).toEqual(new Set([LEAF_ID]))
  })

  it('limits summary-reference churn to the transitioning worktree at scale', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeIds = Array.from({ length: 12 }, (_, index) => `repo::/wt-${index}`)
    const tabsByWorktree = Object.fromEntries(
      worktreeIds.map((worktreeId, index) => [worktreeId, [makeTab(`tab-${index}`, worktreeId)]])
    )
    const initialStatuses = Object.fromEntries(
      worktreeIds.map((_, index) => {
        const paneKey = makePaneKey(`tab-${index}`, LEAF_ID)
        return [paneKey, makeAgentStatusEntry({ paneKey, state: 'working' })]
      })
    )
    const changedPaneKey = makePaneKey('tab-11', LEAF_ID)
    const baseInputs = {
      tabsByWorktree,
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
    const state: AgentActivityInput = {
      ...baseInputs,
      agentStatusEpoch: 0,
      agentStatusByPaneKey: initialStatuses
    }
    const changedState: AgentActivityInput = {
      ...baseInputs,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        ...initialStatuses,
        [changedPaneKey]: makeAgentStatusEntry({ paneKey: changedPaneKey, state: 'done' })
      }
    }

    const before = worktreeIds.map((worktreeId) =>
      selectWorktreeAgentActivitySummary(state, worktreeId)
    )
    const after = worktreeIds.map((worktreeId) =>
      selectWorktreeAgentActivitySummary(changedState, worktreeId)
    )
    const changedReferenceCount = after.filter((summary, index) => summary !== before[index]).length
    const shallowNotificationCount = after.filter(
      (summary, index) => !shallow(summary, before[index])
    ).length

    // Why: shallow store subscriptions wake on the nested pane-id map reference.
    // One transition must not schedule downstream work for every other card.
    expect(changedReferenceCount).toBe(1)
    expect(shallowNotificationCount).toBe(1)
    expect(after[11]).toMatchObject({ hasLiveWorking: false, hasLiveDone: true })
  })

  it('reuses only summaries whose pane membership is still current', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const worktreeId = 'repo::/wt-1'
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-2', LEAF_ID)
    const replacementPaneKey = makePaneKey('tab-3', LEAF_ID)
    const sharedInputs = {
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
    const initial: AgentActivityInput = {
      ...sharedInputs,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId), makeTab('tab-2', worktreeId)]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' }),
        [secondPaneKey]: makeAgentStatusEntry({ paneKey: secondPaneKey, state: 'working' })
      }
    }
    const reordered: AgentActivityInput = {
      ...initial,
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [secondPaneKey]: initial.agentStatusByPaneKey[secondPaneKey],
        [firstPaneKey]: initial.agentStatusByPaneKey[firstPaneKey]
      }
    }
    const replacement: AgentActivityInput = {
      ...sharedInputs,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-3', worktreeId)] },
      agentStatusEpoch: 2,
      agentStatusByPaneKey: {
        [replacementPaneKey]: makeAgentStatusEntry({
          paneKey: replacementPaneKey,
          state: 'working'
        })
      }
    }
    const removed: AgentActivityInput = {
      ...replacement,
      agentStatusEpoch: 3,
      agentStatusByPaneKey: {}
    }

    const first = selectWorktreeAgentActivitySummary(initial, worktreeId)
    const afterReorder = selectWorktreeAgentActivitySummary(reordered, worktreeId)
    const afterReplacement = selectWorktreeAgentActivitySummary(replacement, worktreeId)
    const afterRemoval = selectWorktreeAgentActivitySummary(removed, worktreeId)

    expect(afterReorder).toBe(first)
    expect(afterReplacement).not.toBe(first)
    expect(afterReplacement.agentStatusPaneIdsByTabId).toEqual({
      'tab-3': new Set([LEAF_ID])
    })
    expect(afterRemoval).not.toBe(afterReplacement)
    expect(afterRemoval).toMatchObject({ hasLiveWorking: false })
    expect(afterRemoval.agentStatusPaneIdsByTabId).toEqual({})
  })

  it('summarizes worktree-attributed rows missing from the tab list', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1'
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }

    expect(selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')).toMatchObject({
      hasLiveDone: true
    })
  })

  it('uses completed worker orchestration to suppress a stale parent pane title', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1',
          parentPaneKey
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }

    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')
    expect(summary.agentStatusPaneIdsByTabId['tab-parent']).toEqual(new Set([LEAF_ID]))
  })

  it('uses runtime orchestration metadata for completed worker parent-pane suppression', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID)
    const childPaneKey = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
    const state: AgentActivityInput = {
      tabsByWorktree: {
        'repo::/wt-1': [makeTab('tab-parent', 'repo::/wt-1')]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId: 'repo::/wt-1'
        })
      },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {
        [childPaneKey]: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey
        }
      },
      retainedAgentsByPaneKey: {}
    }

    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')
    expect(summary.agentStatusPaneIdsByTabId['tab-parent']).toEqual(new Set([LEAF_ID]))
  })

  // Why: Orca injects its own "<Agent> - action required" OSC title on a blocked/waiting hook,
  // then classifies that title back as evidence. If a pane stopped registering its identity once
  // its row aged out, that self-authored title outranked the pane's own `done` row and pinned the
  // workspace card to the question icon with no agent asking anything.
  it('records a stale entry pane id separately so permission titles stay suppressed', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const entry = makeAgentStatusEntry({ paneKey, state: 'done', worktreeId: 'repo::/wt-1' })
    vi.spyOn(Date, 'now').mockReturnValue(entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS + 1)
    const state: AgentActivityInput = {
      tabsByWorktree: { 'repo::/wt-1': [makeTab('tab-1', 'repo::/wt-1')] },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: { [paneKey]: entry },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }

    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')

    expect(summary.stalePaneIdsByTabId['tab-1']).toEqual(new Set([LEAF_ID]))
    // Staleness still ends the row's authority: no fresh pane id, no liveness flag.
    expect(summary.agentStatusPaneIdsByTabId['tab-1']).toBeUndefined()
    expect(summary.hasLiveDone).toBe(false)
  })

  // Reproduces the reported card: a Codex pane parked at its composer, its only agent row `done`
  // and ~2h old, and the workspace still painting the amber question icon. `permission` outranks
  // `hasLiveDone` in resolveWorktreeStatus, so the pane's stale self-authored title decided the
  // card. With no fresh evidence the honest answer is `active`, never a question nobody asked.
  it('does not paint a stale self-authored action-required title as a live question', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const entry = makeAgentStatusEntry({ paneKey, state: 'done', worktreeId: 'repo::/wt-1' })
    vi.spyOn(Date, 'now').mockReturnValue(entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS + 1)
    const tab = { ...makeTab('tab-1', 'repo::/wt-1'), title: 'Codex - action required' }
    const state: AgentActivityInput = {
      tabsByWorktree: { 'repo::/wt-1': [tab] },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: { [paneKey]: entry },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
    const summary = selectWorktreeAgentActivitySummary(state, 'repo::/wt-1')

    const status = resolveWorktreeStatus({
      tabs: [tab],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      agentStatusPaneIdsByTabId: summary.agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId: summary.stalePaneIdsByTabId,
      hasPermission: summary.hasPermission,
      hasLiveWorking: summary.hasLiveWorking,
      hasLiveDone: summary.hasLiveDone,
      hasRetainedDone: summary.hasRetainedDone
    })

    expect(status).toBe('active')
  })

  // The reported multi-host bug (STA-4343): one repo registered on two paired
  // runtimes publishes the same id, so both cards share the bare id. win-a's
  // working agent arrives through the mirror with the HOST's own bare
  // `worktreeId` and the environment id as its transport stamp; the row's
  // bucket is the `host|id` key the mirror writes. Reading the bare key used
  // to merge both claimants into one bucket — one host's spinner painted
  // every claimant's card.
  const REPO_ID = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
  const VMD_ID = `${REPO_ID}::C:/vmd`
  const WIN_A = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
  const WIN_B = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'
  const ENV_A = WIN_A.slice('runtime:'.length)
  const KEY_A = composeWorktreeHostIdentity(WIN_A, VMD_ID)
  const KEY_B = composeWorktreeHostIdentity(WIN_B, VMD_ID)

  function catalogRow(hostId: string): Worktree {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested gate reads.
    return { id: VMD_ID, repoId: REPO_ID, hostId } as unknown as Worktree
  }

  function mirroredWorkingEntry(hostTabId: string): AgentStatusEntry {
    const tabId = toWebTerminalSurfaceTabId(hostTabId)
    return {
      ...makeAgentStatusEntry({
        paneKey: makePaneKey(tabId, LEAF_ID),
        state: 'working',
        worktreeId: VMD_ID
      }),
      connectionId: ENV_A
    }
  }

  function contestedState(worktreesByRepo: Record<string, Worktree[]>): AgentActivityInput {
    const entry = mirroredWorkingEntry('host-tab-a')
    return {
      tabsByWorktree: {
        [KEY_A]: [makeTab(toWebTerminalSurfaceTabId('host-tab-a'), KEY_A)],
        [KEY_B]: [makeTab(toWebTerminalSurfaceTabId('host-tab-b'), KEY_B)]
      },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: { [entry.paneKey]: entry },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {},
      worktreesByRepo
    }
  }

  it('buckets a contested paired-host working row under the publishing host only', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const state = contestedState({ [REPO_ID]: [catalogRow(WIN_A), catalogRow(WIN_B)] })

    expect(selectWorktreeAgentActivitySummary(state, KEY_A).hasLiveWorking).toBe(true)
    // The co-claimant's card and the bare key must not see the other host's
    // agent — the bug painted the spinner on every claimant's card.
    expect(selectWorktreeAgentActivitySummary(state, KEY_B).hasLiveWorking).toBe(false)
    expect(selectWorktreeAgentActivitySummary(state, VMD_ID).hasLiveWorking).toBe(false)
  })

  it('buckets a contested retained row under the publishing host only', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const entry = mirroredWorkingEntry('host-tab-a')
    const state: AgentActivityInput = {
      ...contestedState({ [REPO_ID]: [catalogRow(WIN_A), catalogRow(WIN_B)] }),
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          worktreeId: VMD_ID,
          tab: makeTab(toWebTerminalSurfaceTabId('host-tab-a'), KEY_A),
          agentType: 'claude',
          startedAt: 1_000
        }
      }
    }

    expect(selectWorktreeAgentActivitySummary(state, KEY_A).hasRetainedDone).toBe(true)
    expect(selectWorktreeAgentActivitySummary(state, KEY_B).hasRetainedDone).toBe(false)
    expect(selectWorktreeAgentActivitySummary(state, VMD_ID).hasRetainedDone).toBe(false)
  })

  it('keeps the bare key byte-identical when the id is uncontested', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const entry = mirroredWorkingEntry('host-tab-a')
    const state: AgentActivityInput = {
      // The store's uncontested shape: rows under the bare id, and the catalog
      // names a single host.
      tabsByWorktree: { [VMD_ID]: [makeTab(toWebTerminalSurfaceTabId('host-tab-a'), VMD_ID)] },
      agentStatusEpoch: 0,
      agentStatusByPaneKey: { [entry.paneKey]: entry },
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      retainedAgentsByPaneKey: {},
      worktreesByRepo: { [REPO_ID]: [catalogRow(WIN_A)] }
    }

    expect(selectWorktreeAgentActivitySummary(state, VMD_ID).hasLiveWorking).toBe(true)
  })
})
