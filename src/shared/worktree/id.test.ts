import { describe, expect, it } from 'vitest'
import {
  WORKTREE_ID_SEPARATOR,
  canonicalizeWorktreeId,
  getRepoMainWorktreeId,
  normalizeWorktreePathForId,
  splitWorktreeId,
  swapWorktreeIdPathSpelling,
  worktreeIdentityKey
} from './id'

import { worktreeIdsShareCheckout } from './id'

const BASE_ID = 'folder-repo::/home/ada/notes'
const INSTANCE_A = `${BASE_ID}::workspace:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b`
const INSTANCE_B = `${BASE_ID}::workspace:9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a`

describe('getRepoMainWorktreeId', () => {
  it('round-trips through the id parsers on posix paths', () => {
    for (const repo of [{ id: 'repo-123', path: '/abs/path' }]) {
      const worktreeId = getRepoMainWorktreeId(repo)
      expect(worktreeId).toBe(`${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`)
      expect(splitWorktreeId(worktreeId)).toEqual({ repoId: repo.id, worktreePath: repo.path })
    }
  })

  it('keeps the repo path byte-faithful — the host compares this id byte-exactly', () => {
    const repo = { id: 'repo-123', path: 'C:\\Users\\me\\repo' }
    const worktreeId = getRepoMainWorktreeId(repo)
    expect(worktreeId).toBe(`${repo.id}${WORKTREE_ID_SEPARATOR}C:\\Users\\me\\repo`)
    expect(splitWorktreeId(worktreeId)?.worktreePath).toBe('C:\\Users\\me\\repo')
  })
})

describe('canonicalizeWorktreeId', () => {
  it('normalizes only the separator spelling of a Windows path', () => {
    expect(normalizeWorktreePathForId('C:\\vmd')).toBe('C:/vmd')
    expect(normalizeWorktreePathForId('C:/vmd')).toBe('C:/vmd')
    expect(normalizeWorktreePathForId('\\\\server\\share\\wt')).toBe('//server/share/wt')
    // A POSIX path keeps its own identity — a backslash is a filename character.
    expect(normalizeWorktreePathForId('/a\\b')).toBe('/a\\b')
  })

  it('folds the Windows separator spelling onto the canonical one', () => {
    expect(canonicalizeWorktreeId('repo-123::C:\\vmd')).toBe('repo-123::C:/vmd')
    expect(canonicalizeWorktreeId('repo-123::C:/vmd')).toBe('repo-123::C:/vmd')
    expect(canonicalizeWorktreeId('repo-123::\\\\server\\share\\wt')).toBe(
      'repo-123:://server/share/wt'
    )
  })

  it('keeps POSIX paths byte-faithful — a backslash is a valid filename character', () => {
    expect(canonicalizeWorktreeId('repo-123::/a\\b')).toBe('repo-123::/a\\b')
    expect(canonicalizeWorktreeId('repo-123::/srv/workspaces')).toBe('repo-123::/srv/workspaces')
  })

  it('preserves case — the fold is separators only, never case', () => {
    expect(canonicalizeWorktreeId('repo-123::C:\\Vmd')).toBe('repo-123::C:/Vmd')
  })

  it('preserves a folder workspace instance suffix', () => {
    expect(
      canonicalizeWorktreeId('repo-123::C:\\folder::workspace:123e4567-e89b-12d3-a456-426614174000')
    ).toBe('repo-123::C:/folder::workspace:123e4567-e89b-12d3-a456-426614174000')
  })

  it('leaves ids without a repo boundary unchanged', () => {
    expect(canonicalizeWorktreeId('repo-a')).toBe('repo-a')
    expect(canonicalizeWorktreeId('')).toBe('')
  })

  it('is idempotent', () => {
    const once = canonicalizeWorktreeId('repo-123::C:\\vmd')
    expect(canonicalizeWorktreeId(once)).toBe(once)
  })

  it('swaps a Windows id to the other spelling and back', () => {
    expect(swapWorktreeIdPathSpelling('repo-123::C:\\vmd')).toBe('repo-123::C:/vmd')
    expect(swapWorktreeIdPathSpelling('repo-123::C:/vmd')).toBe('repo-123::C:\\vmd')
    expect(swapWorktreeIdPathSpelling(swapWorktreeIdPathSpelling('repo-123::C:\\vmd'))).toBe(
      'repo-123::C:\\vmd'
    )
  })

  it('never swaps a POSIX path — a backslash there is a filename character', () => {
    expect(swapWorktreeIdPathSpelling('repo-123::/a\\b')).toBe('repo-123::/a\\b')
    expect(swapWorktreeIdPathSpelling('repo-123::/srv/workspaces')).toBe(
      'repo-123::/srv/workspaces'
    )
    expect(swapWorktreeIdPathSpelling('repo-a')).toBe('repo-a')
  })

  it('agrees with the comparison key so both spellings address one workspace', () => {
    expect(worktreeIdentityKey('repo-123::C:\\vmd')).toBe(worktreeIdentityKey('repo-123::C:/vmd'))
    // The canonical id is the id the comparison key folds TO (minus case), so a canonical id
    // never needs folding to match itself.
    expect(canonicalizeWorktreeId('repo-123::C:\\vmd')).toBe('repo-123::C:/vmd')
  })
})

describe('worktreeIdsShareCheckout', () => {
  it('matches a folder workspace id with an instance of the same folder', () => {
    expect(worktreeIdsShareCheckout(BASE_ID, INSTANCE_A)).toBe(true)
    expect(worktreeIdsShareCheckout(INSTANCE_A, BASE_ID)).toBe(true)
  })

  it('matches two instances of one folder', () => {
    expect(worktreeIdsShareCheckout(INSTANCE_A, INSTANCE_B)).toBe(true)
  })

  it('keeps repo ids exact on a shared path', () => {
    expect(worktreeIdsShareCheckout(BASE_ID, 'other-repo::/home/ada/notes')).toBe(false)
    expect(
      worktreeIdsShareCheckout(
        INSTANCE_A,
        `other-repo::/home/ada/notes::workspace:${'0'.repeat(36)}`
      )
    ).toBe(false)
  })

  it('falls back to strict equality for malformed and folder: ids', () => {
    expect(worktreeIdsShareCheckout('folder:home-1', 'folder:home-1')).toBe(true)
    expect(worktreeIdsShareCheckout('folder:home-1', 'folder:home-2')).toBe(false)
    expect(worktreeIdsShareCheckout('folder:home-1', BASE_ID)).toBe(false)
    expect(worktreeIdsShareCheckout('repo-only', 'repo-only')).toBe(true)
    expect(worktreeIdsShareCheckout('repo-only', 'repo-other')).toBe(false)
  })

  it('folds path spelling like worktreeIdsEqual', () => {
    const left = 'repo::C:\\Users\\Ada\\Notes'
    const right = 'repo::c:/users/ada/notes/::workspace:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
    expect(worktreeIdsShareCheckout(left, right)).toBe(true)
    expect(worktreeIdsShareCheckout('repo::/home/Ada', 'repo::/home/ada')).toBe(false)
  })

  it('keeps distinct git worktrees apart', () => {
    expect(worktreeIdsShareCheckout('repo::/src/app', 'repo::/src/app-feature')).toBe(false)
  })
})
