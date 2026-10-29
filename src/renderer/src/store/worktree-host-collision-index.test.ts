/**
 * STA-4343: the same repo at the same path on two hosts is TWO workspaces.
 *
 * `worktreeId` is `repoId::path` with no host component, so a repo registered on
 * both the local host and an SSH host publishes the SAME id twice. Every id-keyed
 * projection therefore has to decide what a second row means. Collapsing them
 * leaves the user one row for two workspaces — and no way to confirm the other
 * one, which makes correct host-qualified routing unreachable.
 *
 * The dedup these indices were built for is a different thing: a race between
 * createWorktree (which appends) and fetchWorktrees (which replaces) can leave
 * two IDENTICAL entries in one repo array. That still collapses.
 */
import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from './types'
import {
  getContestedWorktreeIds,
  getIndexedAllWorktrees,
  getIndexedWorktreeMap,
  getIndexedWorktreesById
} from './worktree-repo-index'
import { buildWorktreeByIdIndex } from './slices/worktree-by-id-index'

const SHARED_ID = 'repo-1::/work/orca'

const baseWorktree: Worktree = {
  id: SHARED_ID,
  repoId: 'repo-1',
  path: '/work/orca',
  branch: 'refs/heads/feature',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false
} as Worktree

const localRow: Worktree = { ...baseWorktree, hostId: 'local', displayName: 'local orca' }
const sshRow: Worktree = { ...baseWorktree, hostId: 'ssh:build-box', displayName: 'ssh orca' }

function byRepo(...worktrees: Worktree[]): AppState['worktreesByRepo'] {
  return { 'repo-1': worktrees }
}

describe('id-keyed worktree projections keep distinct hosts distinct', () => {
  it('lists a colliding id once per host', () => {
    const all = getIndexedAllWorktrees(byRepo(localRow, sshRow))

    expect(all).toHaveLength(2)
    expect(all.map((entry) => entry.hostId)).toEqual(['local', 'ssh:build-box'])
  })

  it('still collapses the createWorktree/fetchWorktrees duplicate on one host', () => {
    // Same id AND same host: this is the append/replace race the dedup exists for.
    const stale: Worktree = { ...localRow, head: 'stale' }
    const fresh: Worktree = { ...localRow, head: 'fresh' }

    const all = getIndexedAllWorktrees(byRepo(stale, fresh))

    expect(all).toHaveLength(1)
    // Last wins: fetchWorktrees replaces, so the later entry is the current one.
    expect(all[0]?.head).toBe('fresh')
  })

  it('treats an unqualified row as its own bucket rather than inventing a host', () => {
    const unqualified: Worktree = { ...baseWorktree, displayName: 'unqualified orca' }

    const all = getIndexedAllWorktrees(byRepo(unqualified, sshRow))

    expect(all).toHaveLength(2)
  })

  it('enumerates every host that publishes an id', () => {
    const rows = getIndexedWorktreesById(byRepo(localRow, sshRow), SHARED_ID)

    expect(rows.map((entry) => entry.hostId)).toEqual(['local', 'ssh:build-box'])
  })

  it('agrees with the other id index on which row a bare id resolves to', () => {
    const worktreesByRepo = byRepo(localRow, sshRow)

    // Both indices flatten the same data; disagreeing meant one caller saw the
    // local row and another the SSH row for the same lookup.
    expect(getIndexedWorktreeMap(worktreesByRepo).get(SHARED_ID)).toBe(
      buildWorktreeByIdIndex(worktreesByRepo).get(SHARED_ID)
    )
  })
})

/**
 * The same Windows checkout reaches the client through two separator spellings — the host's
 * git scan emits `C:/vmd`, an id built from a persisted `repo.path` yields `C:\vmd`. The
 * contested gate and every id index key byte-exactly, so the two spellings must converge onto
 * the canonical id: one entry, one contested verdict, one lookup.
 */
describe('id-keyed projections fold the two Windows separator spellings', () => {
  const WINDOWS_ID = 'repo-1::C:/vmd'
  const RAW_ID = 'repo-1::C:\\vmd'

  const slashRow: Worktree = { ...baseWorktree, id: WINDOWS_ID, path: 'C:/vmd' }
  const backslashRow: Worktree = { ...baseWorktree, id: RAW_ID, path: 'C:\\vmd' }

  it('collapses the two spellings on one host to one canonical row', () => {
    const all = getIndexedAllWorktrees(byRepo(slashRow, backslashRow))

    expect(all).toHaveLength(1)
  })

  it('keeps the two spellings as ONE contested id when two hosts publish them', () => {
    const local: Worktree = { ...slashRow, hostId: 'local' }
    const ssh: Worktree = { ...backslashRow, hostId: 'ssh:build-box' }
    const contested = getContestedWorktreeIds(byRepo(local, ssh))

    // The gate must fire on the canonical id — with the old byte-exact key the two spellings
    // never deduped, the id never became contested, and the session keys stayed bare.
    expect(contested).toEqual(new Set([WINDOWS_ID]))
    expect(getIndexedWorktreesById(byRepo(local, ssh), RAW_ID)).toHaveLength(2)
  })

  it('finds a row by either spelling of the id', () => {
    const worktreesByRepo = byRepo(slashRow)

    expect(getIndexedWorktreesById(worktreesByRepo, RAW_ID)).toHaveLength(1)
    expect(getIndexedWorktreesById(worktreesByRepo, WINDOWS_ID)).toHaveLength(1)
  })
})
