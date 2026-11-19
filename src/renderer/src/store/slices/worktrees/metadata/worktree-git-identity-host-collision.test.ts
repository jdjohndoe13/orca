/**
 * Defect 3 candidate root cause: `updateWorktreeGitIdentity` is not host-gated.
 *
 * It matches rows by the bare id, so a two-host collision patches BOTH rows with
 * one host's head/branch — and re-derives the auto title from that branch, which
 * is exactly the "both rows show the clicked host's name and branch" symptom.
 * Each row keeps its own hostId, so the host chip stays correct while the
 * content flips.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'

const REPO_ID = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
const VMD_ID = `${REPO_ID}::C:/vmd`
const WIN_A: ExecutionHostId = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
const WIN_B: ExecutionHostId = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'

function row(hostId: ExecutionHostId, branch: string): Worktree {
  return {
    id: VMD_ID,
    repoId: REPO_ID,
    path: 'C:/vmd',
    hostId,
    displayName: branch,
    displayNameMode: 'automatic',
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

function seed(): void {
  useAppStore.setState({
    worktreesByRepo: {
      [REPO_ID]: [row(WIN_A, 'issue-3.5-wip'), row(WIN_B, 'issue-3.6-wip')]
    }
  })
}

function rowOf(hostId: ExecutionHostId): Worktree | undefined {
  return (useAppStore.getState().worktreesByRepo[REPO_ID] ?? []).find(
    (worktree) => worktree.hostId === hostId
  )
}

afterEach(() => {
  useAppStore.setState({ worktreesByRepo: {} })
})

describe('updateWorktreeGitIdentity host gate', () => {
  it('patches ONLY the named host row when the id is contested', () => {
    seed()
    // The win-b git watcher reports a branch move on ITS row.
    useAppStore
      .getState()
      .updateWorktreeGitIdentity(
        VMD_ID,
        { branch: 'refs/heads/issue-3.6-wip-moved', head: 'fff0001' },
        WIN_B
      )

    expect(rowOf(WIN_B)?.branch).toBe('refs/heads/issue-3.6-wip-moved')
    expect(rowOf(WIN_B)?.displayName).toBe('issue-3.6-wip-moved')
    // The sibling host's row must be untouched.
    expect(rowOf(WIN_A)?.branch).toBe('refs/heads/issue-3.5-wip')
    expect(rowOf(WIN_A)?.displayName).toBe('issue-3.5-wip')
  })

  it('keeps patching the single row of an uncontested id byte-identically', () => {
    const id = `${REPO_ID}::C:/other`
    useAppStore.setState({
      worktreesByRepo: { [REPO_ID]: [{ ...row(WIN_A, 'solo'), id, path: 'C:/other' }] }
    })
    useAppStore
      .getState()
      // The host arg is required: null names "no twin shares this id", the
      // uncontested case this test pins.
      .updateWorktreeGitIdentity(id, { branch: 'refs/heads/solo-2', head: 'eee0002' }, null)

    const only = useAppStore.getState().worktreesByRepo[REPO_ID][0]
    expect(only.branch).toBe('refs/heads/solo-2')
    expect(only.displayName).toBe('solo-2')
  })
})
