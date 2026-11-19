/**
 * STA-4343 fix 2 + fix 3 — the split's bare-vs-qualified collision.
 *
 * This file documents WHY the controller (the `web-session-tabs-sync` mirror) must never write
 * a contested id under the bare key: `assignWorktreeKeyed` routes a bare key by the catalog's
 * owner — the pinned primary (the lowest runtime id = win-b) — and strips the prefix, so the
 * bare row would land in the same bucket as the primary's own `win-b|id` row.
 *
 * Fix 3 added the guard: within one worktree-keyed record, a bare key of an id that ALREADY
 * has a qualified row landing in the same partition is dropped — the qualified row wins
 * regardless of entry order. A bare-only row still routes to the pinned primary (the split
 * cannot tell which claimant a lone bare row belongs to, and the bare id is the only spelling
 * the disk format has ever had). See C:\temp\orca-diag\fix2-design.md.
 */
import { describe, it, expect } from 'vitest'
import { splitWorkspaceSessionByHost } from './workspace/persistence/workspace-session-host-split'
import { buildHostIdByWorktreeId } from './workspace/persistence/workspace-session-host-persistence'
import type { HostPersistenceState } from './workspace/persistence/workspace-session-host-persistence'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

const REPO_ID = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
const VMD_ID = `${REPO_ID}::C:/vmd`
const WIN_A: ExecutionHostId = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
const WIN_B: ExecutionHostId = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'
const KEY_A = `${WIN_A}|${VMD_ID}`
const KEY_B = `${WIN_B}|${VMD_ID}`

function row(hostId: ExecutionHostId): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested routing reads.
  return {
    id: VMD_ID,
    repoId: REPO_ID,
    path: 'C:/vmd',
    hostId,
    displayName: `row-${hostId.slice(-4)}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc1234',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  } as unknown as Worktree
}

function repo(hostId: ExecutionHostId): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested routing reads.
  return {
    id: REPO_ID,
    path: 'C:/vmd',
    displayName: 'vmd',
    executionHostId: hostId,
    connectionId: hostId.slice('runtime:'.length),
    addedAt: 0,
    lastOpenedAt: 0,
    preferredView: 'terminal'
  } as unknown as Repo
}

function tab(id: string): TerminalTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the split reads.
  return {
    id,
    ptyId: null,
    worktreeId: VMD_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as unknown as TerminalTab
}

function persistenceState(): HostPersistenceState {
  return {
    repos: [repo(WIN_A), repo(WIN_B)],
    worktreesByRepo: { [REPO_ID]: [row(WIN_A), row(WIN_B)] }
  }
}

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [KEY_A]: [tab('win-a-tab')],
      [KEY_B]: [tab('win-b-tab')],
      // The bare row the unfixed mirror writes — win-a's tab (the win-a frame wrote the bare
      // key last), inserted last so it collides last-wins in the primary's bucket.
      [VMD_ID]: [tab('win-a-tab')]
    }
  }
}

describe('the persistence split keeps qualified rows whole against a bare contested key', () => {
  it('the catalog pins the bare id to the lowest runtime id (win-b)', () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    expect(hostIdByWorktreeId(VMD_ID)).toBe(WIN_B)
  })

  it("the bare row cannot overwrite the primary partition's qualified row", () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    const slices = splitWorkspaceSessionByHost(session(), hostIdByWorktreeId)

    // The qualified rows land in their own partitions under the bare id (the disk format).
    expect(slices[WIN_A]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-a-tab'])
    // Fix 3: the bare row is dropped because the same partition already holds a qualified row
    // for this id — the win-b partition keeps its own tab regardless of entry order.
    expect(slices[WIN_B]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-b-tab'])
    // Local never sees the contested id.
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.tabsByWorktree?.[VMD_ID]).toBeUndefined()
  })

  it('a bare-only contested row still routes to the pinned primary (the split cannot guess)', () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    const bareOnly = {
      ...session(),
      tabsByWorktree: { [VMD_ID]: [tab('win-a-tab')] }
    }
    const slices = splitWorkspaceSessionByHost(bareOnly, hostIdByWorktreeId)
    // A lone bare row of a contested id has no other evidence — the pinned primary owns it,
    // the same routing the pollution cleanup relies on.
    expect(slices[WIN_B]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-a-tab'])
  })

  it('a bare row of an UNCONTESTED id in the same partition is untouched by the guard', () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId({
      repos: [repo(WIN_A), repo(WIN_B), { ...repo(WIN_B), id: 'other-repo' }],
      worktreesByRepo: { [REPO_ID]: [row(WIN_A), row(WIN_B)] }
    })
    const other = {
      ...session(),
      tabsByWorktree: {
        [KEY_A]: [tab('win-a-tab')],
        [KEY_B]: [tab('win-b-tab')],
        // win-b's own uncontested id, bare, lands in the same partition as the guarded id.
        'other-repo::C:/other': [tab('other-tab')]
      }
    }
    const slices = splitWorkspaceSessionByHost(other, hostIdByWorktreeId)
    expect(slices[WIN_B]?.tabsByWorktree?.['other-repo::C:/other']?.map((t) => t.id)).toEqual([
      'other-tab'
    ])
    expect(slices[WIN_B]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-b-tab'])
  })

  it('routes a unified-only tab of a contested id to the PUBLISHING host, not the pinned primary', () => {
    // Item 3: the tab→worktree index resolves a unified-only tab through the RECORD
    // KEY, which carries the host prefix (`win-a|id`). The layout then follows the
    // publishing host's partition. Reading the tab's own bare `worktreeId` field
    // instead would route it to the pinned primary (win-b) and cross-pollute.
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    const unifiedOnly = {
      ...getDefaultWorkspaceSession(),
      unifiedTabs: {
        [KEY_A]: [
          {
            id: 'win-a-only-tab',
            entityId: 'win-a-only-tab',
            groupId: 'g1',
            worktreeId: VMD_ID,
            contentType: 'terminal' as const,
            label: 'win-a-only-tab',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'win-a-only-tab': { root: null, activeLeafId: null, expandedLeafId: null }
      }
    }
    const slices = splitWorkspaceSessionByHost(unifiedOnly, hostIdByWorktreeId)
    expect(slices[WIN_A]?.terminalLayoutsByTabId?.['win-a-only-tab']).toBeDefined()
    expect(slices[WIN_B]?.terminalLayoutsByTabId?.['win-a-only-tab']).toBeUndefined()
  })
})
