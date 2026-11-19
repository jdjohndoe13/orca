/**
 * The boot read of a store written before host-qualified keys existed.
 *
 * Every partition on disk keeps the bare `repoId::path` spelling it has always had — the split
 * strips the prefix back off — so qualification happens in memory on the read, once, from the
 * partitions' own hosts. What this pins: a contested id has no bare key in the unified session
 * (the four host-colliding cards each show their own host's tabs), and the one shape that cannot
 * be separated by host — a `folder:<uuid>` co-named by two partitions — is still parked, not
 * qualified (one workspace written twice, #12723).
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace/persistence/workspace-session-host-hydration'

const SHARED_ID = 'repo-shared::/work/orca'
const FOLDER_KEY = 'folder:11111111-2222-3333-4444-555555555555'
const RUNTIME_HOST: ExecutionHostId = 'runtime:env-1'
const RUNTIME_ONLY_ID = 'repo-rt::/srv/app'

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tab(id: string, worktreeId = SHARED_ID): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** A session read whose partitions are exactly what persistence holds. */
function partitionedApi(
  partitions: Partial<Record<ExecutionHostId | 'local', WorkspaceSessionState>>
) {
  return {
    get: async (hostId?: ExecutionHostId) =>
      partitions[hostId ?? 'local'] ?? getDefaultWorkspaceSession()
  }
}

const repos: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[] = [
  { id: 'repo-shared', connectionId: null, executionHostId: 'local' },
  { id: 'repo-shared', connectionId: null, executionHostId: RUNTIME_HOST },
  { id: 'repo-rt', connectionId: null, executionHostId: RUNTIME_HOST }
]

describe('boot read of a pre-qualification store', () => {
  it('gives every claimant of a contested id its own bucket and keeps no bare key', async () => {
    // Both partitions hold the bare key — the shape every install on disk has. The read migrates
    // it in memory: one bucket per claimant, so a card for one host can never fall back to the
    // other's row.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [SHARED_ID]: [tab('tab-local')] } }),
        [RUNTIME_HOST]: session({
          tabsByWorktree: {
            [SHARED_ID]: [tab('tab-runtime')],
            [RUNTIME_ONLY_ID]: [tab('tab-own', RUNTIME_ONLY_ID)]
          }
        })
      }),
      repos
    )

    expect(read.session.tabsByWorktree[`local|${SHARED_ID}`]?.map((t) => t.id)).toEqual([
      'tab-local'
    ])
    expect(read.session.tabsByWorktree[`${RUNTIME_HOST}|${SHARED_ID}`]?.map((t) => t.id)).toEqual([
      'tab-runtime'
    ])
    expect(read.session.tabsByWorktree[SHARED_ID]).toBeUndefined()
    // An uncontested id keeps its bare key — the whole gate.
    expect(read.session.tabsByWorktree[RUNTIME_ONLY_ID]?.map((t) => t.id)).toEqual(['tab-own'])
  })

  it('leaves a contested id unnamed in the runtime-owner map and names an uncontested one', async () => {
    // Every reader of this map is keyed by the bare id — a placeholder for the wrong host or a
    // repo-fetch that stops covering the other claimant is worse than a partial map.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [SHARED_ID]: [tab('tab-local')] } }),
        [RUNTIME_HOST]: session({
          tabsByWorktree: {
            [SHARED_ID]: [tab('tab-runtime')],
            [RUNTIME_ONLY_ID]: [tab('tab-own', RUNTIME_ONLY_ID)]
          }
        })
      }),
      repos
    )

    expect(read.runtimeHostIdByWorkspaceSessionKey[RUNTIME_ONLY_ID]).toBe(RUNTIME_HOST)
    expect(read.runtimeHostIdByWorkspaceSessionKey[SHARED_ID]).toBeUndefined()
  })
})

describe('boot read of a co-named folder key', () => {
  it('parks the co-claimant instead of qualifying it', async () => {
    // A `folder:<uuid>` key is minted per workspace, so two partitions holding it is ONE
    // workspace written twice (#12723) — reuniting it is the repair's job and qualifying it would
    // split it into two rival buckets. The shadow is what keeps the co-claimant's rows from being
    // erased by the primary's write, and this is the proof it was not deleted blind.
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      partitionedApi({
        local: session({ tabsByWorktree: { [FOLDER_KEY]: [tab('tab-local', FOLDER_KEY)] } }),
        [RUNTIME_HOST]: session({
          tabsByWorktree: { [FOLDER_KEY]: [tab('tab-runtime', FOLDER_KEY)] }
        })
      }),
      // A repo row that names the runtime host is only what makes the boot read its partition;
      // the folder key itself is unrelated to any repo.
      [{ id: 'repo-rt', connectionId: null, executionHostId: RUNTIME_HOST }]
    )

    // The primary keeps the bare key — the folder key is never host-qualified.
    expect(read.session.tabsByWorktree[FOLDER_KEY]?.map((t) => t.id)).toEqual(['tab-local'])
    expect(Object.keys(read.session.tabsByWorktree)).toEqual([FOLDER_KEY])
    // The co-claimant's row survives in the shadow, to be written back to its own partition.
    expect(
      read.contestedHostWorkspaceSessions[RUNTIME_HOST]?.tabsByWorktree?.[FOLDER_KEY]?.map(
        (t) => t.id
      )
    ).toEqual(['tab-runtime'])
    expect(read.contestedPrimaryHostBySessionKey[FOLDER_KEY]).toBe('local')
  })
})
