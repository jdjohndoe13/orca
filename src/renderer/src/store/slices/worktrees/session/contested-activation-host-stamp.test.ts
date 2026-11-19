import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { getContestedWorktreeIds } from '../../worktrees/listing/worktree-catalog-index'

const CONTESTED_ID = 'repo-1::C:/vmd'
const UNCONTESTED_ID = 'repo-1::C:/other'

function worktree(overrides: { repoId: string; id: string; hostId?: ExecutionHostId }): Worktree {
  return {
    ...overrides,
    path: `C:/vmd/${overrides.id}`,
    displayName: 'vmd',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  }
}

function seedCatalog(worktreesByRepo: Record<string, Worktree[]>): void {
  useAppStore.setState({
    worktreesByRepo,
    refreshGitHubForWorktreeIfStale: () => undefined
  })
}

afterEach(() => {
  useAppStore.setState({
    worktreesByRepo: {},
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null
  })
})

describe('contested activation host stamp', () => {
  it('derives the host from the single catalog row when the contest is unambiguous', () => {
    // Two rows, one id: the unqualified row keeps the id contested, the `local` row is the
    // only one that names a host, so the activation stamps `local` instead of null.
    seedCatalog({
      'repo-1': [
        worktree({ repoId: 'repo-1', id: CONTESTED_ID }),
        worktree({ repoId: 'repo-1', id: CONTESTED_ID, hostId: 'local' })
      ]
    })
    expect(getContestedWorktreeIds(useAppStore.getState().worktreesByRepo)).toContain(CONTESTED_ID)

    useAppStore.getState().setActiveWorktree(CONTESTED_ID)

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
  })

  it('leaves the stamp null when the catalog names several hosts, so the guard matches nothing', () => {
    seedCatalog({
      'repo-1': [
        worktree({ repoId: 'repo-1', id: CONTESTED_ID, hostId: 'local' }),
        worktree({
          repoId: 'repo-1',
          id: CONTESTED_ID,
          hostId: 'runtime:host-b'
        }),
        worktree({
          repoId: 'repo-1',
          id: CONTESTED_ID,
          hostId: 'runtime:host-c'
        })
      ]
    })

    useAppStore.getState().setActiveWorktree(CONTESTED_ID)

    // The store cannot prove the host; `isWorkspaceRowActive` then matches NO row rather than
    // every claimant (the no-row case is covered at the render level in
    // host-collision-active-row.test.tsx).
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBeNull()
  })

  it('keeps an uncontested id unstamped even when its single row carries a host', () => {
    // Single-host installs never stamp the active host — the bare match must survive.
    seedCatalog({
      'repo-1': [worktree({ repoId: 'repo-1', id: UNCONTESTED_ID, hostId: 'local' })]
    })

    useAppStore.getState().setActiveWorktree(UNCONTESTED_ID)

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBeNull()
  })

  it('keeps an explicit host over the catalog-derived one', () => {
    seedCatalog({
      'repo-1': [
        worktree({ repoId: 'repo-1', id: CONTESTED_ID, hostId: 'local' }),
        worktree({
          repoId: 'repo-1',
          id: CONTESTED_ID,
          hostId: 'runtime:host-b'
        })
      ]
    })

    useAppStore.getState().setActiveWorktree(CONTESTED_ID, 'runtime:host-b')

    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:host-b')
  })
})
