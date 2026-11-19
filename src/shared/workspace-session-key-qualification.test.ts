/**
 * The read-side pass that gives a contested id its per-host spelling inside a session slice.
 *
 * Persistence holds one partition per execution host, so a partition's own id IS the host its rows
 * belong to — the boot read re-qualifies with that, without consulting the repo catalog. The disk
 * never sees these keys: the split strips the prefix back off.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './orca-profiles/constants'
import type { ExecutionHostId } from './execution-host/execution-host'
import type { SleepingAgentSessionRecord } from './agent-session/lifecycle/agent-session-resume'
import type { TerminalTab } from './workspace-layout/terminal-tab-types'
import {
  buildRuntimeHostIdByWorkspaceSessionKey,
  isHostQualifiableWorkspaceId,
  qualifyHostWorkspaceSessionSlice,
  qualifyHostWorkspaceSessionSlices,
  splitHostForSessionKey,
  workspaceSessionKeysNamedByHostPartition
} from './workspace-session-key-qualification'
import type { WorkspaceSessionState } from './workspace-session/workspace-session-state-types'

const SHARED_ID = 'repo-shared::/work/orca'
const FOLDER_KEY = 'folder:11111111-2222-3333-4444-555555555555'
const SSH_HOST: ExecutionHostId = 'ssh:build-box'
const RUNTIME_HOST: ExecutionHostId = 'runtime:env-1'

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: SHARED_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sleeping(worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey: 'pane-1',
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'p',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('isHostQualifiableWorkspaceId', () => {
  it('qualifies a repo-backed id, which is host-blind by construction', () => {
    expect(isHostQualifiableWorkspaceId(SHARED_ID)).toBe(true)
  })

  it('never qualifies a folder key, which is minted per workspace', () => {
    // The same folder key in two partitions is one workspace written twice (#12723), which the
    // stranded-partition repair deliberately reunites — splitting it into rival buckets would
    // re-break that repair.
    expect(isHostQualifiableWorkspaceId(FOLDER_KEY)).toBe(false)
  })
})

describe('splitHostForSessionKey', () => {
  it('routes by the key prefix, never the catalog, so a transient disagreement cannot lose a row', () => {
    // The catalog's opinion is deliberately wrong here (it answers 'local' for everything); the
    // key's own prefix wins, which is what makes the two contested sets disagreeing briefly
    // harmless — the split follows the key, so the row returns to the partition it names.
    const catalog = (): ExecutionHostId => 'local'
    expect(splitHostForSessionKey(`${SSH_HOST}|${SHARED_ID}`, catalog)).toBe(SSH_HOST)
    expect(splitHostForSessionKey(`${RUNTIME_HOST}|${SHARED_ID}`, catalog)).toBe(RUNTIME_HOST)
  })

  it('falls back to the catalog for a bare key, decoded to the bare id it asks about', () => {
    const asked: string[] = []
    const catalog = (worktreeId: string): ExecutionHostId => {
      asked.push(worktreeId)
      return SSH_HOST
    }
    expect(splitHostForSessionKey(SHARED_ID, catalog)).toBe(SSH_HOST)
    // The catalog is asked about the bare id, not the raw key — same value for a bare key, but
    // the decoded form is what the write path's catalog lookup expects.
    expect(asked).toEqual([SHARED_ID])
  })
})

describe('qualifyHostWorkspaceSessionSlice', () => {
  it('re-keys every worktree-keyed row of a contested id to the partition host', () => {
    const slice = session({
      tabsByWorktree: { [SHARED_ID]: [tab('tab-1')] },
      activeTabIdByWorktree: { [SHARED_ID]: 'tab-1' }
    })

    const qualified = qualifyHostWorkspaceSessionSlice(slice, SSH_HOST, new Set([SHARED_ID]))

    expect(qualified.tabsByWorktree).toEqual({ [`${SSH_HOST}|${SHARED_ID}`]: [tab('tab-1')] })
    expect(qualified.activeTabIdByWorktree).toEqual({ [`${SSH_HOST}|${SHARED_ID}`]: 'tab-1' })
  })

  it('leaves a folder key alone even when the partitions co-name it', () => {
    const slice = session({ tabsByWorktree: { [FOLDER_KEY]: [tab('tab-1')] } })

    const qualified = qualifyHostWorkspaceSessionSlice(slice, SSH_HOST, new Set([FOLDER_KEY]))

    expect(qualified.tabsByWorktree).toEqual({ [FOLDER_KEY]: [tab('tab-1')] })
  })

  it('leaves the visit-recency field to its own host-qualified convention', () => {
    // `worktree-visit-recency.ts` already writes `host|id` and its reader accepts either
    // spelling; qualifying a bare legacy key would move bytes on disk no reader needs moved.
    const slice = session({
      lastVisitedAtByWorktreeId: { [SHARED_ID]: 1, [`${SSH_HOST}|${SHARED_ID}`]: 2 }
    })

    const qualified = qualifyHostWorkspaceSessionSlice(slice, SSH_HOST, new Set([SHARED_ID]))

    expect(qualified.lastVisitedAtByWorktreeId).toEqual({
      [SHARED_ID]: 1,
      [`${SSH_HOST}|${SHARED_ID}`]: 2
    })
  })

  it('is idempotent — an already-qualified key re-composes to the same key', () => {
    // The merge hands the pass slices the contention split may already have qualified.
    const once = qualifyHostWorkspaceSessionSlice(
      session({ tabsByWorktree: { [SHARED_ID]: [tab('tab-1')] } }),
      SSH_HOST,
      new Set([SHARED_ID])
    )
    const twice = qualifyHostWorkspaceSessionSlice(once, SSH_HOST, new Set([SHARED_ID]))

    expect(twice).toBe(once)
  })

  it('returns the same reference when nothing moves', () => {
    // The overwhelming majority of installs have no collision: the read must allocate nothing and
    // every downstream identity check must still hold.
    const slice = session({ tabsByWorktree: { 'repo-a::/a': [] } })
    expect(qualifyHostWorkspaceSessionSlice(slice, SSH_HOST, new Set([SHARED_ID]))).toBe(slice)
    expect(qualifyHostWorkspaceSessionSlice(slice, SSH_HOST, new Set())).toBe(slice)
  })
})

describe('qualifyHostWorkspaceSessionSlices', () => {
  it('qualifies each partition with its own host', () => {
    const slices = {
      local: session({ tabsByWorktree: { [SHARED_ID]: [tab('tab-local')] } }),
      [SSH_HOST]: session({ tabsByWorktree: { [SHARED_ID]: [tab('tab-ssh')] } })
    }

    const qualified = qualifyHostWorkspaceSessionSlices(slices, new Set([SHARED_ID]))

    expect(qualified.local?.tabsByWorktree).toEqual({
      [`local|${SHARED_ID}`]: [tab('tab-local')]
    })
    expect(qualified[SSH_HOST]?.tabsByWorktree).toEqual({
      [`${SSH_HOST}|${SHARED_ID}`]: [tab('tab-ssh')]
    })
  })

  it('returns the same map when there is no contest', () => {
    const slices = { local: session({ tabsByWorktree: { 'repo-a::/a': [] } }) }
    expect(qualifyHostWorkspaceSessionSlices(slices, new Set())).toBe(slices)
  })
})

describe('buildRuntimeHostIdByWorkspaceSessionKey', () => {
  it('names the runtime host for a workspace its partition alone holds', () => {
    const owners = buildRuntimeHostIdByWorkspaceSessionKey(
      {
        [RUNTIME_HOST]: session({
          tabsByWorktree: {
            'repo-rt::/srv/app': [{ ...tab('t'), worktreeId: 'repo-rt::/srv/app' }]
          }
        })
      },
      new Set()
    )

    expect(owners).toEqual({ 'repo-rt::/srv/app': RUNTIME_HOST })
  })

  it('names no host at all for a contested id', () => {
    // Every reader of this map is keyed by the bare id: a placeholder for the wrong host, or a
    // repo-fetch that stops covering the other claimant, is worse than a partial map.
    const owners = buildRuntimeHostIdByWorkspaceSessionKey(
      { [RUNTIME_HOST]: session({ tabsByWorktree: { [SHARED_ID]: [tab('t')] } }) },
      new Set([SHARED_ID])
    )

    expect(owners).toEqual({})
  })

  it('names no host for an id two partitions both claim without a contest', () => {
    const owners = buildRuntimeHostIdByWorkspaceSessionKey(
      {
        [RUNTIME_HOST]: session({ tabsByWorktree: { [SHARED_ID]: [tab('t')] } }),
        [SSH_HOST]: session({ tabsByWorktree: { [SHARED_ID]: [tab('t')] } })
      },
      new Set()
    )

    expect(owners).toEqual({})
  })

  it('never names the local partition', () => {
    // The map exists for the catalog placeholders a remote host's boot needs; 'local' rows are
    // never a runtime placeholder.
    const owners = buildRuntimeHostIdByWorkspaceSessionKey(
      { local: session({ tabsByWorktree: { 'repo-a::/a': [] } }) },
      new Set()
    )

    expect(owners).toEqual({})
  })
})

describe('workspaceSessionKeysNamedByHostPartition', () => {
  it('collects every session key the partition names, across records and lists', () => {
    const keys = workspaceSessionKeysNamedByHostPartition(
      session({
        tabsByWorktree: { [`${SSH_HOST}|${SHARED_ID}`]: [tab('t')] },
        activeWorktreeIdsOnShutdown: ['repo-a::/a'],
        sleepingAgentSessionsByPaneKey: { 'pane-1': sleeping('repo-b::/b') }
      })
    )

    expect([...keys].sort()).toEqual(
      [`${SSH_HOST}|${SHARED_ID}`, 'repo-a::/a', 'repo-b::/b'].sort()
    )
  })
})
