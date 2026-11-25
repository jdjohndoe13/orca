// Why (STA-4343): one repo path on two hosts publishes the SAME worktree id, so every
// claimant card used to read the same bare-keyed agent bucket and show the same agent
// line. The row index must bucket by the session row key (`host|id`) so exactly one
// card shows a row, and the bare key must be no card's read.
//
// Upstream re-shaped the live read into a pass-through of the agent-status projection,
// which derives a row's owner from the `tabsByWorktree` RECORD KEY — the session row
// key — inside the store's ownership boundary (`withAgentStatusOwnership`). The
// projection is only populated by that write path, so the bucketing is pinned through
// the store rather than a hand-assembled state object.

import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { workspaceSessionKey } from '../../../../shared/workspace-session-worktree-key'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import type { AppState } from '@/store/types'
import { getContestedWorktreeIds } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { selectLiveAgentStatusEntriesForWorktree } from './workspace-card/activity/worktree-agent-row-selectors'

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an ExecutionHostId is a branded string; the literal is one of the two spellings the host-id parser accepts.
const RUNTIME_HOST = 'runtime:web-env-1' as ExecutionHostId
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an ExecutionHostId is a branded string; the literal is one of the two spellings the host-id parser accepts.
const LOCAL_HOST = 'local' as ExecutionHostId
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NOW = 1_700_000_000_000

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

describe('contested worktree id agent-row bucketing', () => {
  it('buckets a live row under its tab row key, not the bare id every claimant reads', () => {
    const store = createTestStore()
    const entry = status('tab-local', CONTESTED_ID)
    store.setState({
      worktreesByRepo: worktreesByRepo(),
      tabsByWorktree: {
        [localKey]: [makeTab({ id: 'tab-local', worktreeId: CONTESTED_ID })]
      },
      agentStatusByPaneKey: acceptedAgentStatuses([[entry.paneKey, entry]])
    })

    const state = store.getState()
    // Exactly one claimant card shows the row: the host whose tab row the projection
    // read the pane out of.
    expect(selectLiveAgentStatusEntriesForWorktree(state, localKey)).toHaveLength(1)
    expect(selectLiveAgentStatusEntriesForWorktree(state, runtimeKey)).toEqual([])
    // The bare key is no card's row key for a contested id — reading it would
    // be the bug: every claimant card showing the same agent line.
    expect(selectLiveAgentStatusEntriesForWorktree(state, CONTESTED_ID)).toEqual([])
  })

  it('keeps an uncontested id on the bare key for every host', () => {
    const worktreeId = `${REPO_ID}::C:\\other`
    const store = createTestStore()
    const entry = status('tab-other', worktreeId)
    store.setState({
      worktreesByRepo: {
        [REPO_ID]: [makeWorktree(worktreeId, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-other', worktreeId })]
      },
      agentStatusByPaneKey: acceptedAgentStatuses([[entry.paneKey, entry]])
    })

    const state = store.getState()
    // The card reads the canonical bare key — the row key the store composes —
    // and an uncontested id keeps that bare shape with no host prefix.
    expect(
      selectLiveAgentStatusEntriesForWorktree(
        state,
        workspaceSessionKey(worktreeId, LOCAL_HOST, contested)
      )
    ).toHaveLength(1)
  })
})
