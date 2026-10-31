// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../components/worktree-jump-palette-test-fixtures'
import type { AppState } from '../store/types'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))

import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTab,
  findStructuredAgentSessionTab
} from './structured-agent-session-tab-activation'

// Why (STA-4343): the reported row — an `OC | board:` OpenCode chat on a repo claimed by several
// paired hosts — is activated through this module. The row lives under the claimant's `host|id`
// session key; a bare-key read missed, so the click activated the worktree and focused nothing.

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`
const LOCAL_HOST = 'local' as const
const SSH_HOST = 'ssh:paired-box' as const

const localKey = `${LOCAL_HOST}|${CONTESTED_ID}`
const sshKey = `${SSH_HOST}|${CONTESTED_ID}`

const initialState = useAppStore.getInitialState()

function catalog(): Pick<AppState, 'repos' | 'worktreesByRepo'> {
  return {
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: LOCAL_HOST, path: 'C:\\vmd' }),
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: SSH_HOST, path: 'C:\\vmd' }),
        makeWorktree(UNCONTESTED_ID, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })
      ]
    }
  }
}

function makeStructuredTab(id: string, sessionId: string, groupId: string): Tab {
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
    agentSessionAgent: 'opencode'
  }
}

/** The session the store holds once both hosts' mirrors landed: one structured row per claimant. */
function contestedRows(): Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'> {
  return {
    unifiedTabsByWorktree: {
      [localKey]: [makeStructuredTab('tab-local', 'session-local', 'group-local')],
      [sshKey]: [makeStructuredTab('tab-ssh', 'session-ssh', 'group-ssh')]
    },
    groupsByWorktree: {
      [localKey]: [
        {
          id: 'group-local',
          worktreeId: CONTESTED_ID,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local'],
          recentTabIds: ['tab-local']
        }
      ],
      [sshKey]: [
        {
          id: 'group-ssh',
          worktreeId: CONTESTED_ID,
          activeTabId: 'tab-ssh',
          tabOrder: ['tab-ssh'],
          recentTabIds: ['tab-ssh']
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

  it('activates the claimant row found by the explicit host', () => {
    // The card's click path: the activation stamps the host, then the tab activation runs with it.
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: SSH_HOST
    })

    expect(
      activateStructuredAgentSessionTab({
        worktreeId: CONTESTED_ID,
        tabId: 'tab-ssh',
        executionHostId: SSH_HOST
      })
    ).toBe(true)

    const state = useAppStore.getState()
    expect(state.activeTabTypeByWorktree[sshKey]).toBe('agent-session')
    expect(state.activeGroupIdByWorktree[sshKey]).toBe('group-ssh')
    expect(
      (state.groupsByWorktree[sshKey] ?? []).find((group) => group.id === 'group-ssh')?.activeTabId
    ).toBe('tab-ssh')
    // The co-claimant's row is untouched.
    expect(state.activeTabTypeByWorktree[localKey]).toBeUndefined()
    expect(state.activeGroupIdByWorktree[localKey]).toBeUndefined()
  })

  it('resolves the row from the active stamp when the caller names no host', () => {
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    })

    expect(
      activateStructuredAgentSessionById({
        worktreeId: CONTESTED_ID,
        sessionId: 'session-local'
      })
    ).toBe(true)
    expect(useAppStore.getState().activeTabTypeByWorktree[localKey]).toBe('agent-session')
  })

  it('misses a contested row whose host is unknown instead of painting the other host', () => {
    // No stamp, no explicit host: the empty-prefix bucket holds no row, and falling back to the
    // bare key would focus the FIRST claimant's chat from the other host's card.
    expect(
      activateStructuredAgentSessionTab({ worktreeId: CONTESTED_ID, tabId: 'tab-local' })
    ).toBe(false)
    expect(
      findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
        workspaceId: CONTESTED_ID,
        sessionId: 'session-local'
      })
    ).toBeNull()
  })

  it('finds the row under the named host even while the other host is active', () => {
    // A card renders a NON-active workspace: the explicit host must beat the active stamp.
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: SSH_HOST
    })

    expect(
      findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
        workspaceId: CONTESTED_ID,
        sessionId: 'session-local',
        executionHostId: LOCAL_HOST
      })?.id
    ).toBe('tab-local')
  })

  it('keeps the bare key for a workspace only one host publishes', () => {
    const tab: Tab = {
      ...makeStructuredTab('tab-plain', 'session-plain', 'group-plain'),
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
