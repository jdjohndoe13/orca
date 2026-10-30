import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status-epoch-clock'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  useIsSleepingWorktree,
  resetWorktreeSleepStateCacheForTests
} from './use-worktree-sleep-state'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type MockState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusEpoch: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey: Record<string, NonNullable<AgentStatusEntry['orchestration']>>
  migrationUnsupportedByPtyId: Record<string, never>
  retainedAgentsByPaneKey: Record<string, unknown>
  worktreesByRepo: Record<string, Worktree[]>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  worktreeId?: string
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    orchestration: undefined
  }
}

function makeUnifiedTab(args: {
  id: string
  worktreeId: string
  contentType: Tab['contentType']
  agentSessionAgent?: Tab['agentSessionAgent']
}): Tab {
  return {
    id: args.id,
    entityId: `entity-${args.id}`,
    groupId: 'group-1',
    worktreeId: args.worktreeId,
    contentType: args.contentType,
    label: args.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(args.agentSessionAgent ? { agentSessionAgent: args.agentSessionAgent } : {})
  }
}

function SleepProbe({
  worktreeId,
  hostId
}: {
  worktreeId: string
  hostId?: ExecutionHostId | null
}) {
  return <span>{String(useIsSleepingWorktree(worktreeId, hostId))}</span>
}

describe('useIsSleepingWorktree', () => {
  beforeEach(() => {
    resetWorktreeSleepStateCacheForTests()
    // Why: the epoch clock samples wall time once per epoch, so a suite that keeps
    // epoch 0 would otherwise reuse the previous test's timestamp.
    resetAgentStatusEpochClockForTests()
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    mockState = {
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {},
      ptyIdsByTabId: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {},
      worktreesByRepo: {}
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats a worktree with no tabs or agents as sleeping', () => {
    expect(renderToStaticMarkup(<SleepProbe worktreeId="repo1::/path/wt1" />)).toBe(
      '<span>true</span>'
    )
  })

  it('treats a worktree whose only surface is a structured chat as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId,
            contentType: 'agent-session',
            agentSessionAgent: 'claude'
          })
        ]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('keeps a structured chat awake once its turn has finished', () => {
    // The reported bug: an idle structured session reports state 'done', which is exactly what
    // isFreshNonDoneAgentStatus refuses, so the live-agent term cannot hold this workspace open.
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('chat-1', LEAF_ID)
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId,
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      },
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done', worktreeId })
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('does not treat a non-chat unified tab as activity', () => {
    // Negative control: the term keys on a structured chat, not on any unified tab existing.
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [makeUnifiedTab({ id: 'file-1', worktreeId, contentType: 'editor' })]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('does not treat a structured chat as activity for a different worktree', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        'repo1::/path/wt2': [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId: 'repo1::/path/wt2',
            contentType: 'agent-session',
            agentSessionAgent: 'claude'
          })
        ]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('treats a worktree with a live PTY as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId)] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('treats a worktree with only a dead tab as sleeping', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId)] },
      ptyIdsByTabId: {}
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('treats a browser tab as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      browserTabsByWorktree: { [worktreeId]: [{ id: 'browser-1' }] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('treats retained done rows without runtime as sleeping (#19624)', () => {
    const worktreeId = 'repo1::/path/wt1'
    const tab = makeTab('tab-1', worktreeId)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      retainedAgentsByPaneKey: {
        [paneKey]: {
          entry: makeAgentStatusEntry({ paneKey, state: 'done' }),
          worktreeId,
          tab,
          agentType: 'codex',
          startedAt: 1_000
        }
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('keeps a fresh working agent awake through a PTY gap', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'working', worktreeId })
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('agrees with the hide-sleeping filter on a stale agent row', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const entry = makeAgentStatusEntry({ paneKey, state: 'working', worktreeId })
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    resetAgentStatusEpochClockForTests()
    mockState = {
      ...mockState,
      // Why: the filter's freshness window is the shared predicate, so an agent row
      // this old must stop holding the workspace awake for the moon too.
      agentStatusByPaneKey: { [paneKey]: { ...entry, updatedAt: 0 } },
      agentStatusEpoch: 1
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  // The moon must follow the row key (STA-4343): a contested id's rows live
  // under `host|id`, so the bare read would paint a moon on a card with a
  // live console, and one host's agent would keep the co-claimant awake.
  it('keeps the contested card with a live console awake and the agentless one asleep', () => {
    const repoId = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
    const vmdId = `${repoId}::C:/vmd`
    const winA = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
    const winB = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'
    const keyA = composeWorktreeHostIdentity(winA, vmdId)
    const keyB = composeWorktreeHostIdentity(winB, vmdId)
    const row = (hostId: string): Worktree =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested gate reads.
      ({ id: vmdId, repoId, hostId }) as unknown as Worktree
    const paneKey = makePaneKey('tab-a', LEAF_ID)
    const entry: AgentStatusEntry = {
      ...makeAgentStatusEntry({ paneKey, state: 'working', worktreeId: vmdId }),
      connectionId: null
    }
    mockState = {
      ...mockState,
      worktreesByRepo: { [repoId]: [row(winA), row(winB)] },
      tabsByWorktree: {
        [keyA]: [makeTab('tab-a', keyA)],
        [keyB]: [makeTab('tab-b', keyB)]
      },
      ptyIdsByTabId: { 'tab-a': ['pty-a'] },
      agentStatusByPaneKey: { [paneKey]: entry }
    }

    // win-a: live PTY + its own working agent → awake.
    expect(renderToStaticMarkup(<SleepProbe worktreeId={vmdId} hostId={winA} />)).toBe(
      '<span>false</span>'
    )
    // win-b: a tab with no live PTY and no agent of its own → asleep, even
    // though win-a's agent shares the bare id.
    expect(renderToStaticMarkup(<SleepProbe worktreeId={vmdId} hostId={winB} />)).toBe(
      '<span>true</span>'
    )
  })
})
