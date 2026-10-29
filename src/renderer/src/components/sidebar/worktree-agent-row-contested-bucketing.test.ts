// Why (STA-4343): one repo path on two hosts publishes the SAME worktree id, so every
// claimant card used to read the same bare-keyed agent bucket and show the same agent
// line. The agent-row index must bucket by the session row key (`host|id`) so exactly
// one card shows a row, and the row's click must activate the card's own host.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { workspaceSessionKey } from '../../../../shared/workspace-session-worktree-key'
import { applyWebSessionTabsSnapshot } from '../../runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../../runtime/web-session-tabs-sync-test-harness'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import type { AppState } from '@/store/types'
import { getContestedWorktreeIds } from '@/store/worktree-repo-index'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './worktree-agent-row-selectors'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const RUNTIME_HOST = `runtime:${ENV}`
const LOCAL_HOST = 'local' as const

const contested = getContestedWorktreeIds({
  [REPO_ID]: [
    makeWorktree(CONTESTED_ID, 'vmd', { hostId: LOCAL_HOST, path: 'C:\\vmd' }),
    makeWorktree(CONTESTED_ID, 'vmd', { hostId: RUNTIME_HOST, path: 'C:\\vmd' })
  ]
})
const runtimeKey = workspaceSessionKey(CONTESTED_ID, RUNTIME_HOST, contested)
const localKey = workspaceSessionKey(CONTESTED_ID, LOCAL_HOST, contested)

function worktreesByRepo(): AppState['worktreesByRepo'] {
  return {
    [REPO_ID]: [
      makeWorktree(CONTESTED_ID, 'vmd', { hostId: LOCAL_HOST, path: 'C:\\vmd' }),
      makeWorktree(CONTESTED_ID, 'vmd', { hostId: RUNTIME_HOST, path: 'C:\\vmd' })
    ]
  }
}

function status(tabId: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId, LEAF_ID),
    tabId,
    worktreeId,
    agentType: 'omp',
    state: 'done',
    prompt: 'Finished the change',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: []
  }
}

function selectorState(state: ReturnType<typeof makeState>) {
  return {
    ...state,
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    worktreesByRepo: worktreesByRepo()
  }
}

describe('contested worktree id agent-row bucketing', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('buckets a mirrored row under its own host, not the bare id every claimant reads', () => {
    const initial = makeState({ activeWorktreeId: 'other-workspace' })
    const mirror = {
      ...initial,
      ...applyWebSessionTabsSnapshot(
        initial,
        makeSnapshot(
          [
            {
              type: 'terminal',
              id: `host-tab::${LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: LEAF_ID,
              title: 'OMP',
              isActive: false,
              status: 'ready',
              terminal: 'terminal-1',
              agentStatus: status('host-tab', CONTESTED_ID)
            }
          ],
          { worktree: CONTESTED_ID }
        ),
        ENV,
        NOW
      )
    }
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId('host-tab'), LEAF_ID)
    expect(mirror.agentStatusByPaneKey[paneKey].connectionId).toBe(ENV)

    const state = selectorState(mirror)
    // Exactly one claimant card shows the row: the publishing runtime host's.
    expect(selectLiveAgentStatusEntriesForWorktree(state, runtimeKey)).toHaveLength(1)
    expect(selectLiveAgentStatusEntriesForWorktree(state, localKey)).toEqual([])
    // The bare key is no card's row key for a contested id — reading it would
    // be the bug: every claimant card showing the same agent line.
    expect(selectLiveAgentStatusEntriesForWorktree(state, CONTESTED_ID)).toEqual([])
  })

  it('keeps an uncontested id on the bare key for every host', () => {
    const worktreeId = 'repo-1::C:\\other'
    const entry = status('ssh-tab', worktreeId)
    const state = {
      ...makeState({
        agentStatusByPaneKey: { [entry.paneKey]: { ...entry, connectionId: 'ssh-1' } }
      }),
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {},
      worktreesByRepo: {
        [REPO_ID]: [makeWorktree(worktreeId, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })]
      }
    }
    // The card reads the canonical bare key — the row key the store composes —
    // and an uncontested id keeps that bare shape with no host prefix.
    expect(
      selectLiveAgentStatusEntriesForWorktree(
        state,
        workspaceSessionKey(worktreeId, null, contested)
      )
    ).toHaveLength(1)
  })

  it('splits retained rows by the entry host stamp so each claimant keeps its own', () => {
    const localEntry = { ...status('tab-local', CONTESTED_ID), connectionId: null }
    const remoteEntry = { ...status('tab-ssh', CONTESTED_ID), connectionId: 'paired-box' }
    const makeRetained = (entry: AgentStatusEntry) => ({
      entry,
      worktreeId: CONTESTED_ID,
      tab: {
        id: entry.tabId!,
        worktreeId: CONTESTED_ID,
        ptyId: null,
        title: 'x',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      },
      agentType: 'omp' as const,
      startedAt: NOW
    })
    const state = {
      ...makeState(),
      migrationUnsupportedByPtyId: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      worktreesByRepo: worktreesByRepo(),
      retainedAgentsByPaneKey: {
        [localEntry.paneKey]: makeRetained(localEntry),
        [remoteEntry.paneKey]: makeRetained(remoteEntry)
      }
    }
    expect(
      selectRetainedAgentEntriesForWorktree(state, localKey).map((r) => r.entry.paneKey)
    ).toEqual([localEntry.paneKey])
    expect(
      selectRetainedAgentEntriesForWorktree(
        state,
        workspaceSessionKey(CONTESTED_ID, 'ssh:paired-box', contested)
      ).map((r) => r.entry.paneKey)
    ).toEqual([remoteEntry.paneKey])
    expect(selectRetainedAgentEntriesForWorktree(state, CONTESTED_ID)).toEqual([])
  })
})
