import { describe, expect, it } from 'vitest'
import { getRepoOwnedWorktreeMeta } from './worktree-metadata-ownership'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

const worktreeId = 'repo-1::/workspace/feature'
const localRepo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'Local repo',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const sshRepo: Repo = {
  ...localRepo,
  path: '/workspace/repo',
  connectionId: 'build-box',
  executionHostId: 'ssh:build-box'
}
const localMeta = { hostId: 'local', displayName: 'local metadata' } as WorktreeMeta

function resolve(repo: Repo, ownerCount: number): WorktreeMeta | undefined {
  return getRepoOwnedWorktreeMeta(repo, worktreeId, { [worktreeId]: localMeta }, ownerCount)
}

describe('getRepoOwnedWorktreeMeta', () => {
  it('rejects another host metadata when repo IDs and paths collide', () => {
    expect(resolve(sshRepo, 2)).toBeUndefined()
  })

  it('keeps legacy metadata for a single-owner repo', () => {
    expect(resolve(localRepo, 1)).toBe(localMeta)
  })

  it('rejects a host-stamped bare row when the repo count is stale', () => {
    // Two paired hosts claim one id, but the co-claimant's repo row is not registered here,
    // so repoOwnerCount still reads 1 — the row's own hostId is the only host evidence.
    expect(resolve(sshRepo, 1)).toBeUndefined()
  })

  it('keeps a host-stamped bare row for its own host at a single-owner count', () => {
    expect(resolve(localRepo, 1)).toBe(localMeta)
  })
})
