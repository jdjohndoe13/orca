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
import type { Worktree } from '../../../../../../shared/worktree/types'
import { hasContestedClaim } from '../../../../../../shared/workspace-session-worktree-key'
import type { AppState } from '../../../types'
import { getWorktreeOnHostFromState } from '../../../workspaces/selection/worktree-on-host-selector'
import {
  getContestedWorktreeIds,
  getIndexedAllWorktrees,
  getIndexedWorktreeById,
  getIndexedWorktreeMap,
  getIndexedWorktreesById
} from './worktree-catalog-index'
import { buildWorktreeByIdIndex } from '../../../terminals/hydration/workspace-terminal-worktree-index'

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

describe('getWorktreeOnHostFromState refuses a lookup that still matches two copies', () => {
  const colliding = { worktreesByRepo: byRepo(localRow, sshRow) }

  it('answers undefined for an unqualified id two hosts share', () => {
    expect(getWorktreeOnHostFromState(colliding, SHARED_ID, undefined)).toBeUndefined()
  })

  it('answers the named host copy', () => {
    expect(getWorktreeOnHostFromState(colliding, SHARED_ID, 'ssh:build-box')).toBe(sshRow)
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

/**
 * The output maps are keyed by the ROW's own id, never the canonical one.
 *
 * A folder-workspace row is byte-faithful by contract — the host byte-compares the id it was
 * handed against `repoId::repo.path` — and the terminal workbench matches its mount set against
 * `activeWorktreeId`/`mountedWorktreeIdsRef`, which hold the raw id. Canonicalizing the OUTPUT
 * keys made the surface id differ from the active id, so the surface never mounted and no
 * `pty:spawn` was ever issued. Fold at comparison, never at construction.
 */
describe('id-keyed projections keep the row byte-faithful and fold the query', () => {
  const FOLDER_RAW_ID = 'repo-1::B:\\work\\vmd'
  const FOLDER_CANONICAL_ID = 'repo-1::B:/work/vmd'

  const folderRow: Worktree = {
    ...baseWorktree,
    id: FOLDER_RAW_ID,
    path: 'B:\\work\\vmd',
    hostId: 'local'
  }
  const folderRowOtherHost: Worktree = {
    ...folderRow,
    hostId: 'ssh:build-box',
    // The other host's git scan spells the same checkout with forward slashes.
    id: FOLDER_CANONICAL_ID
  }

  it('keys the first-wins map by the row raw id, not the canonical spelling', () => {
    const worktreesByRepo = { 'repo-1': [folderRow] }

    expect([...getIndexedWorktreeMap(worktreesByRepo).keys()]).toEqual([FOLDER_RAW_ID])
    expect(getIndexedWorktreeMap(worktreesByRepo).get(FOLDER_RAW_ID)).toBe(folderRow)
  })

  it('resolves a byte-faithful row from either spelling of the query', () => {
    const worktreesByRepo = { 'repo-1': [folderRow] }

    expect(getIndexedWorktreesById(worktreesByRepo, FOLDER_RAW_ID)).toEqual([folderRow])
    expect(getIndexedWorktreesById(worktreesByRepo, FOLDER_CANONICAL_ID)).toEqual([folderRow])
    expect(getIndexedWorktreeById(worktreesByRepo, FOLDER_RAW_ID)).toBe(folderRow)
    expect(getIndexedWorktreeById(worktreesByRepo, FOLDER_CANONICAL_ID)).toBe(folderRow)
  })

  it('keeps the two-host collision byte-faithful and still fires the contested gate', () => {
    const worktreesByRepo = { 'repo-1': [folderRow, folderRowOtherHost] }

    // The gate holds the canonical id — `hasContestedClaim` folds both sides, so a caller
    // holding either spelling hits it.
    expect(getContestedWorktreeIds(worktreesByRepo)).toEqual(new Set([FOLDER_CANONICAL_ID]))
    expect(hasContestedClaim(getContestedWorktreeIds(worktreesByRepo), FOLDER_RAW_ID)).toBe(true)
    // The maps stay on the first row's byte-faithful id and hold every host's row.
    expect([...getIndexedWorktreeMap(worktreesByRepo).keys()]).toEqual([FOLDER_RAW_ID])
    expect(getIndexedWorktreesById(worktreesByRepo, FOLDER_RAW_ID)).toEqual([
      folderRow,
      folderRowOtherHost
    ])
    expect(getIndexedWorktreesById(worktreesByRepo, FOLDER_CANONICAL_ID)).toHaveLength(2)
  })

  it('keeps the first row across hosts for a two-host id, keyed by its own id', () => {
    const worktreesByRepo = { 'repo-1': [folderRow, folderRowOtherHost] }

    expect(getIndexedWorktreeMap(worktreesByRepo).get(FOLDER_RAW_ID)).toBe(folderRow)
    // The other host's row is not a second entry: a bare-id lookup cannot name it.
    expect(getIndexedWorktreeMap(worktreesByRepo).get(FOLDER_CANONICAL_ID)).toBeUndefined()
  })
})
