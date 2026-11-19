// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../components/worktree-jump/worktree-jump-palette-test-fixtures'
import type { AppState } from '../store/types'
import type { Tab } from '../../../shared/workspace-layout/tab-groups/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTab,
  findStructuredAgentSessionTab
} from './agent-session/structured-agent-session-tab-activation'

// Why (STA-4343): the reported row — an `OC | board:` OpenCode chat on a repo claimed by several
// paired hosts — is activated through this module. The row lives under the claimant's `host|id`
// session key; a bare-key read missed, so the click activated the worktree and focused nothing.
// The upstream restructure carries the host as a `RuntimeClientTarget` (a runtime environment, or
// this app), so the claimants here are two runtime hosts rather than the pre-restructure `ssh:`
// spelling; the keying the test pins is unchanged.

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`
const LOCAL_HOST = 'local' as const
const ENV_A = 'env-a'
const ENV_B = 'env-b'
const HOST_A = `runtime:${ENV_A}` as const
const HOST_B = `runtime:${ENV_B}` as const

const targetA: RuntimeClientTarget = { kind: 'environment', environmentId: ENV_A }
const targetB: RuntimeClientTarget = { kind: 'environment', environmentId: ENV_B }

const aKey = `${HOST_A}|${CONTESTED_ID}`
const bKey = `${HOST_B}|${CONTESTED_ID}`

const initialState = useAppStore.getInitialState()

function catalog(): Pick<AppState, 'repos' | 'worktreesByRepo'> {
  return {
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: HOST_A, path: 'C:\\vmd' }),
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: HOST_B, path: 'C:\\vmd' }),
        makeWorktree(UNCONTESTED_ID, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })
      ]
    }
  }
}

function makeStructuredTab(
  id: string,
  sessionId: string,
  groupId: string,
  executionHostId: ExecutionHostId
): Tab {
  return {
    id,
    worktreeId: CONTESTED_ID,
    groupId,
    contentType: 'agent-session',
    entityId: sessionId,
    label: 'OC | board:',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: false,
    agentSessionAgent: 'opencode',
    executionHostId
  }
}

/** The session the store holds once both hosts' mirrors landed: one structured row per claimant. */
function contestedRows(): Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'> {
  return {
    unifiedTabsByWorktree: {
      [aKey]: [makeStructuredTab('tab-a', 'session-a', 'group-a', HOST_A)],
      [bKey]: [makeStructuredTab('tab-b', 'session-b', 'group-b', HOST_B)]
    },
    groupsByWorktree: {
      [aKey]: [
        {
          id: 'group-a',
          worktreeId: CONTESTED_ID,
          activeTabId: 'tab-a',
          tabOrder: ['tab-a'],
          recentTabIds: ['tab-a']
        }
      ],
      [bKey]: [
        {
          id: 'group-b',
          worktreeId: CONTESTED_ID,
          activeTabId: 'tab-b',
          tabOrder: ['tab-b'],
          recentTabIds: ['tab-b']
        }
      ]
    }
  }
}

describe('host-colliding structured session activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState(initialState, true)
    useAppStore.setState({ ...catalog(), ...contestedRows() })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('activates the claimant row found by the explicit target', () => {
    // The card's click path: the activation carries the host, and the tab activation runs with it.
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: HOST_B
    })

    expect(
      activateStructuredAgentSessionTab({
        worktreeId: CONTESTED_ID,
        tabId: 'tab-b',
        target: targetB
      })
    ).toBe(true)

    const state = useAppStore.getState()
    expect(state.activeTabTypeByWorktree[bKey]).toBe('agent-session')
    expect(state.activeGroupIdByWorktree[bKey]).toBe('group-b')
    expect(
      (state.groupsByWorktree[bKey] ?? []).find((group) => group.id === 'group-b')?.activeTabId
    ).toBe('tab-b')
    // The co-claimant's row is untouched.
    expect(state.activeTabTypeByWorktree[aKey]).toBeUndefined()
    expect(state.activeGroupIdByWorktree[aKey]).toBeUndefined()
  })

  it('resolves the row from the active stamp when the caller names no target', () => {
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: HOST_A
    })

    expect(
      activateStructuredAgentSessionById({
        worktreeId: CONTESTED_ID,
        sessionId: 'session-a'
      })
    ).toBe(true)
    expect(useAppStore.getState().activeTabTypeByWorktree[aKey]).toBe('agent-session')
  })

  it('misses a contested row whose host is unknown instead of painting the other host', () => {
    // No stamp, no explicit target: the empty-prefix bucket holds no row, and falling back to the
    // bare key would focus the FIRST claimant's chat from the other host's card.
    expect(
      activateStructuredAgentSessionTab({ worktreeId: CONTESTED_ID, tabId: 'tab-a' })
    ).toBe(false)
    expect(
      findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
        workspaceId: CONTESTED_ID,
        sessionId: 'session-a'
      })
    ).toBeNull()
  })

  it('finds the row under the named target even while the other host is active', () => {
    // A card renders a NON-active workspace: the explicit target must beat the active stamp.
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: HOST_B
    })

    expect(
      findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
        workspaceId: CONTESTED_ID,
        sessionId: 'session-a',
        target: targetA
      })?.id
    ).toBe('tab-a')
  })

  it('keeps the bare key for a workspace only one host publishes', () => {
    const tab: Tab = {
      ...makeStructuredTab('tab-plain', 'session-plain', 'group-plain', LOCAL_HOST),
      worktreeId: UNCONTESTED_ID
    }
    useAppStore.setState({
      unifiedTabsByWorktree: { [UNCONTESTED_ID]: [tab] },
      groupsByWorktree: {
        [UNCONTESTED_ID]: [
          {
            id: 'group-plain',
            worktreeId: UNCONTESTED_ID,
            activeTabId: 'tab-plain',
            tabOrder: ['tab-plain'],
            recentTabIds: ['tab-plain']
          }
        ]
      }
    })

    expect(
      findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
        workspaceId: UNCONTESTED_ID,
        sessionId: 'session-plain'
      })?.id
    ).toBe('tab-plain')
    expect(
      activateStructuredAgentSessionTab({ worktreeId: UNCONTESTED_ID, tabId: 'tab-plain' })
    ).toBe(true)
    expect(useAppStore.getState().activeTabTypeByWorktree[UNCONTESTED_ID]).toBe('agent-session')
  })
})
