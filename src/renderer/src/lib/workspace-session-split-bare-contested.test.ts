/**
 * STA-4343 fix 2 — the split-collision PIN (asserts CURRENT behavior, not a RED test).
 *
 * This file documents WHY the controller (the `web-session-tabs-sync` mirror) must never write
 * a contested id under the bare key: `assignWorktreeKeyed` routes a bare key by the catalog's
 * owner — the pinned primary (the lowest runtime id = win-b) — and strips the prefix, so the
 * bare row collides with the primary's own `win-b|id` row in the same bucket and the
 * last-written one wins. If the bare row carried win-a's tabs (the win-a mirror wrote the bare
 * key last), win-b's partition DB-pollutes with win-a's tab.
 *
 * The fix is controller-side (the mirror re-spells the patch to `host|id`), so the split's
 * last-wins rule is deliberately NOT changed here — the unified store must never hold a bare
 * contested key for the split to misroute. This pin asserts the CURRENT hazard so a future
 * controller regression that re-introduces the bare write is caught by the companion
 * `web-session-tabs-sync-mirror-contested-key.test.ts`, and this file stays green as the
 * mechanism's documentation. See C:\temp\orca-diag\fix2-design.md (split guard out of scope).
 */
import { describe, it, expect } from 'vitest'
import { splitWorkspaceSessionByHost } from './workspace-session-host-split'
import { buildHostIdByWorktreeId } from './workspace-session-host-persistence'
import type { HostPersistenceState } from './workspace-session-host-persistence'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

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

describe('the persistence split misroutes a bare contested key to the primary (PIN)', () => {
  it('the catalog pins the bare id to the lowest runtime id (win-b)', () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    expect(hostIdByWorktreeId(VMD_ID)).toBe(WIN_B)
  })

  it('the bare row collides into the primary partition and overwrites its own row', () => {
    const hostIdByWorktreeId = buildHostIdByWorktreeId(persistenceState())
    const slices = splitWorkspaceSessionByHost(session(), hostIdByWorktreeId)

    // The qualified rows land in their own partitions under the bare id (the disk format).
    expect(slices[WIN_A]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-a-tab'])
    // The bare row is routed to the primary (win-b) and, written last, overwrites the
    // primary's own row — the win-b partition now holds win-a's tab. This is the pollution.
    expect(slices[WIN_B]?.tabsByWorktree?.[VMD_ID]?.map((t) => t.id)).toEqual(['win-a-tab'])
    // Local never sees the contested id.
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.tabsByWorktree?.[VMD_ID]).toBeUndefined()
  })
})
