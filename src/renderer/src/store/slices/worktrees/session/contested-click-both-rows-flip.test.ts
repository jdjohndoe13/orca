/**
 * Defect 3 repro: clicking one host's vmd row repaints BOTH host rows to the
 * clicked host's name/branch/child-tabs.
 *
 * Seeds the live two-host shape the store dump shows: one repo id registered on
 * two runtime hosts, one row per host with the same `repoId::C:/vmd` id, each
 * host's own tab in its own contested session bucket. Then activates the win-b
 * row the way the sidebar click does and asserts the win-a row is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import { useAppStore } from '@/store'
import { getContestedWorktreeIds } from '../../worktrees/listing/worktree-catalog-index'
import { resolveWorkspaceSessionKey } from '../../../workspace-session-key'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { refreshGitStatusForWorktree } from '@/components/right-sidebar/source-control/sync/git-status-refresh'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type * as RuntimeGitStatusClient from '@/runtime/source-control/git/runtime-git-status-client'
import type * as RuntimeGitSyncClient from '@/runtime/source-control/git/runtime-git-sync-client'

vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeGitStatusClient>()
  return {
    ...actual,
    getRuntimeGitStatus: vi.fn()
  }
})

vi.mock('@/runtime/source-control/git/runtime-git-sync-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeGitSyncClient>()
  return {
    ...actual,
    getRuntimeGitUpstreamStatus: vi.fn().mockResolvedValue(null)
  }
})

const REPO_ID = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
const VMD_ID = `${REPO_ID}::C:/vmd`
const WIN_A: ExecutionHostId = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
const WIN_B: ExecutionHostId = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'

function row(hostId: ExecutionHostId, displayName: string, branch: string): Worktree {
  return {
    id: VMD_ID,
    repoId: REPO_ID,
    path: 'C:/vmd',
    hostId,
    displayName,
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
    branch: `refs/heads/${branch}`,
    isBare: false,
    isMainWorktree: true
  }
}

function repo(hostId: ExecutionHostId): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested-host reads touch; the store never narrows the rest.
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

function tab(hostLabel: string, ptyEnv: string): TerminalTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested-host reads touch; the store never narrows the rest.
  return {
    id: `web-terminal-${hostLabel}`,
    worktreeId: VMD_ID,
    title: `OC | board: ${hostLabel} task`,
    ptyId: `remote:${ptyEnv}@@term_1`,
    cwd: 'C:/vmd',
    createdAt: 0
  } as unknown as TerminalTab
}

function seed(): void {
  const winA = row(WIN_A, 'issue-3.5-wip', 'issue-3.5-wip')
  const winB = row(WIN_B, 'issue-3.6-wip', 'issue-3.6-wip')
  useAppStore.setState({
    repos: [repo(WIN_A), repo(WIN_B)],
    worktreesByRepo: { [REPO_ID]: [winA, winB] },
    detectedWorktreesByRepo: {},
    tabsByWorktree: {
      [`${WIN_A}|${VMD_ID}`]: [tab('win-a', WIN_A.slice('runtime:'.length))],
      [`${WIN_B}|${VMD_ID}`]: [tab('win-b', WIN_B.slice('runtime:'.length))]
    },
    activeRepoId: REPO_ID,
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null,
    refreshGitHubForWorktreeIfStale: () => undefined,
    refreshGitHubForWorktree: () => undefined
  })
}

function rowsOf(id: string): Worktree[] {
  return (useAppStore.getState().worktreesByRepo[REPO_ID] ?? []).filter(
    (worktree) => worktree.id === id
  )
}

function rowName(hostId: ExecutionHostId): string {
  return rowsOf(VMD_ID).find((worktree) => worktree.hostId === hostId)?.displayName ?? '(missing)'
}

function rowBranch(hostId: ExecutionHostId): string {
  return rowsOf(VMD_ID).find((worktree) => worktree.hostId === hostId)?.branch ?? '(missing)'
}

function tabTitles(hostId: ExecutionHostId): string[] {
  const state = useAppStore.getState()
  const key = resolveWorkspaceSessionKey(state, VMD_ID, hostId)
  return (state.tabsByWorktree[key] ?? []).map((tab) => tab.title ?? '(untitled)')
}

afterEach(() => {
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    tabsByWorktree: {},
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null
  })
})

describe('contested two-host click keeps the sibling row intact', () => {
  it('the seed is genuinely contested and each host keeps its own row', () => {
    seed()
    expect(getContestedWorktreeIds(useAppStore.getState().worktreesByRepo)).toContain(VMD_ID)
    expect(rowsOf(VMD_ID)).toHaveLength(2)
    expect(tabTitles(WIN_A)).toEqual(['OC | board: win-a task'])
    expect(tabTitles(WIN_B)).toEqual(['OC | board: win-b task'])
  })

  it('activating win-b leaves win-a row name/branch/tabs alone', () => {
    seed()
    useAppStore.getState().setActiveWorktree(VMD_ID, WIN_B)

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(WIN_B)
    expect(rowName(WIN_B)).toBe('issue-3.6-wip')
    expect(rowName(WIN_A)).toBe('issue-3.5-wip')
    expect(rowBranch(WIN_A)).toBe('refs/heads/issue-3.5-wip')
    expect(tabTitles(WIN_A)).toEqual(['OC | board: win-a task'])
    expect(tabTitles(WIN_B)).toEqual(['OC | board: win-b task'])
  })

  it('activating win-a leaves win-b row name/branch/tabs alone', () => {
    seed()
    useAppStore.getState().setActiveWorktree(VMD_ID, WIN_A)

    expect(rowName(WIN_A)).toBe('issue-3.5-wip')
    expect(rowName(WIN_B)).toBe('issue-3.6-wip')
    expect(rowBranch(WIN_B)).toBe('refs/heads/issue-3.6-wip')
    expect(tabTitles(WIN_B)).toEqual(['OC | board: win-b task'])
  })

  it('the full sidebar click on win-b leaves the win-a row intact', () => {
    seed()
    const result = activateAndRevealWorktree(VMD_ID, {
      executionHostId: WIN_B,
      notifyHostRuntime: false
    })
    expect(result).not.toBe(false)

    expect(rowName(WIN_B)).toBe('issue-3.6-wip')
    expect(rowName(WIN_A)).toBe('issue-3.5-wip')
    expect(rowBranch(WIN_A)).toBe('refs/heads/issue-3.5-wip')
    expect(tabTitles(WIN_A)).toEqual(['OC | board: win-a task'])
    expect(tabTitles(WIN_B)).toEqual(['OC | board: win-b task'])
  })

  it('the post-click git-status poll for win-b leaves the win-a row intact', async () => {
    seed()
    // The click activates win-b, then the git-status poll runs routed to the
    // clicked host and reports ITS branch. The identity write must land on the
    // win-b row only.
    useAppStore.getState().setActiveWorktree(VMD_ID, WIN_B)
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'fff0001',
      branch: 'refs/heads/issue-3.6-wip-moved'
    }
    vi.mocked(getRuntimeGitStatus).mockResolvedValue(status)

    const state = useAppStore.getState()
    await refreshGitStatusForWorktree({
      target: { kind: 'environment', environmentId: WIN_B.slice('runtime:'.length) },
      ownerHostId: WIN_B,
      worktreeId: VMD_ID,
      worktreePath: 'C:/vmd',
      deps: {
        setGitStatus: state.setGitStatus,
        updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
        setUpstreamStatus: state.setUpstreamStatus,
        fetchUpstreamStatus: state.fetchUpstreamStatus
      }
    })

    expect(rowName(WIN_B)).toBe('issue-3.6-wip-moved')
    expect(rowBranch(WIN_B)).toBe('refs/heads/issue-3.6-wip-moved')
    expect(rowName(WIN_A)).toBe('issue-3.5-wip')
    expect(rowBranch(WIN_A)).toBe('refs/heads/issue-3.5-wip')
  })

  it('a local head-identity watcher event for the shared path leaves the runtime rows intact', () => {
    seed()
    // The local watcher has no vmd row (the repo lives on the two runtimes),
    // but the same path exists on both host rows: a watcher event must never
    // reach the runtime rows at all.
    const state = useAppStore.getState()
    state.updateWorktreeGitIdentity(
      VMD_ID,
      { head: 'fff0001', branch: 'refs/heads/local-detached-noise' },
      'local'
    )

    expect(rowName(WIN_A)).toBe('issue-3.5-wip')
    expect(rowName(WIN_B)).toBe('issue-3.6-wip')
    expect(rowBranch(WIN_A)).toBe('refs/heads/issue-3.5-wip')
    expect(rowBranch(WIN_B)).toBe('refs/heads/issue-3.6-wip')
  })
})
