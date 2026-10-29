/**
 * The one rule that decides when a workspace's session key names a host (STA-4343).
 *
 * A worktree id is `repoId::path` with no host component, so one repo registered on several hosts
 * publishes the SAME id for several different workspaces. Only a contested id gains a host prefix,
 * and every claimant of one — including the primary — carries it, so a reader that guesses the
 * wrong host MISSES instead of painting another host's tabs.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { ExecutionHostId } from './execution-host'
import type { TerminalTab } from './terminal-tab-types'
import {
  getExecutionHostIdFromSessionKey,
  getWorkspaceIdFromSessionKey,
  readWorkspaceSessionEntry,
  rekeyWorkspaceSessionFields,
  rekeyWorkspaceSessionRecord,
  WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS,
  workspaceSessionKey,
  workspaceSessionKeyCandidates,
  type ContestedWorkspaceIds
} from './workspace-session-worktree-key'
import type { WorkspaceSessionState } from './workspace-session-state-types'

const SHARED_ID = 'repo-shared::/work/orca'
const SSH_HOST = 'ssh:build-box'

const contested: ContestedWorkspaceIds = new Set([SHARED_ID])

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: SHARED_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('workspaceSessionKey', () => {
  it('keeps the bare id for every uncontested workspace', () => {
    // The whole gate: an install without a collision never sees a qualified key, so the store
    // shape, the persisted partitions, and the paired-host wire are unchanged for it.
    expect(workspaceSessionKey('repo-a::/a', 'local', contested)).toBe('repo-a::/a')
    expect(workspaceSessionKey('repo-a::/a', SSH_HOST, contested)).toBe('repo-a::/a')
    expect(workspaceSessionKey('repo-a::/a', null, contested)).toBe('repo-a::/a')
    expect(workspaceSessionKey('repo-a::/a', 'local', undefined)).toBe('repo-a::/a')
  })

  it('qualifies every claimant of a contested id, including the primary', () => {
    // A contested id has no bare key at all: a reader that falls back to the bare key would land
    // on the primary's row from another host's card, which is the exact bug being fixed.
    expect(workspaceSessionKey(SHARED_ID, 'local', contested)).toBe(`local|${SHARED_ID}`)
    expect(workspaceSessionKey(SHARED_ID, SSH_HOST, contested)).toBe(`${SSH_HOST}|${SHARED_ID}`)
  })

  it('routes an unknown host on a contested id to the canonical empty-prefix bucket', () => {
    // Matches `composeWorktreeHostIdentity`: an unqualified row is its own bucket, never folded
    // into a host it cannot prove.
    expect(workspaceSessionKey(SHARED_ID, null, contested)).toBe(`|${SHARED_ID}`)
    expect(workspaceSessionKey(SHARED_ID, undefined, contested)).toBe(`|${SHARED_ID}`)
  })

  it('never double-qualifies an already-qualified key', () => {
    // A legacy id that happens to contain `|` must not become `host|host|id`.
    expect(workspaceSessionKey(`${SSH_HOST}|${SHARED_ID}`, 'local', contested)).toBe(
      `${SSH_HOST}|${SHARED_ID}`
    )
  })
})

describe('readWorkspaceSessionEntry', () => {
  it('attempts exactly one key and never falls back to the bare id', () => {
    // The miss IS the answer: a contested id has one spelling per host, and falling back to the
    // bare key would show the primary's tabs in another host's card.
    expect(workspaceSessionKeyCandidates(SHARED_ID, SSH_HOST, contested)).toEqual([
      `${SSH_HOST}|${SHARED_ID}`
    ])
    const record = { [`local|${SHARED_ID}`]: 'primary-row' }
    expect(readWorkspaceSessionEntry(record, SHARED_ID, SSH_HOST, contested)).toBeUndefined()
    expect(readWorkspaceSessionEntry(record, SHARED_ID, 'local', contested)).toEqual({
      entry: 'primary-row',
      key: `local|${SHARED_ID}`
    })
  })

  it('returns the key it found the row under so a caller writes back to the same place', () => {
    const record = { 'repo-a::/a': 'row' }
    expect(readWorkspaceSessionEntry(record, 'repo-a::/a', 'local', contested)).toEqual({
      entry: 'row',
      key: 'repo-a::/a'
    })
  })
})

describe('session key decoders', () => {
  it('decode both halves of a qualified key', () => {
    expect(getWorkspaceIdFromSessionKey(`${SSH_HOST}|${SHARED_ID}`)).toBe(SHARED_ID)
    expect(getExecutionHostIdFromSessionKey(`${SSH_HOST}|${SHARED_ID}`)).toBe(SSH_HOST)
  })

  it('read a bare key as its own id and no host', () => {
    expect(getWorkspaceIdFromSessionKey(SHARED_ID)).toBe(SHARED_ID)
    expect(getExecutionHostIdFromSessionKey(SHARED_ID)).toBeNull()
  })

  it('treat a legacy id containing a pipe as bare, not as a qualified key', () => {
    // `isWorktreeHostIdentity` is the shared shape test; a `|` that names no host must not
    // mis-split the id.
    const legacy = 'weird|id::/path'
    expect(getWorkspaceIdFromSessionKey(legacy)).toBe(legacy)
    expect(getExecutionHostIdFromSessionKey(legacy)).toBeNull()
  })
})

describe('rekeyWorkspaceSessionRecord', () => {
  it('splits one bare row into one qualified row per claimant when a contest appears', () => {
    const hostOf = (id: string): ExecutionHostId | null => (id === SHARED_ID ? 'local' : null)
    const rekeyed = rekeyWorkspaceSessionRecord(
      { [SHARED_ID]: 'row' },
      new Set([SHARED_ID]),
      hostOf
    )

    // The bare row belongs to the host the catalog names for it; the co-claimant's row arrives
    // through its own partition, not through this record.
    expect(rekeyed).toEqual({ [`local|${SHARED_ID}`]: 'row' })
  })

  it('collapses qualified rows back to the bare id when the contest clears', () => {
    const hostOf = (): ExecutionHostId | null => 'local'
    const rekeyed = rekeyWorkspaceSessionRecord(
      { [`${SSH_HOST}|${SHARED_ID}`]: 'ssh-row', [`local|${SHARED_ID}`]: 'local-row' },
      new Set(),
      hostOf
    )

    // Two rows with no host to distinguish them are the same workspace twice: the later one wins,
    // the same convention the worktree listing uses to drop the duplicate row.
    expect(rekeyed).toEqual({ [SHARED_ID]: 'local-row' })
  })

  it('returns the same reference when no key needs to move', () => {
    // Reference stability is what stops a catalog refresh that changes nothing from fanning out
    // through session persistence.
    const record = { 'repo-a::/a': 'row', [`${SSH_HOST}|${SHARED_ID}`]: 'row' }
    expect(rekeyWorkspaceSessionRecord(record, new Set([SHARED_ID]), () => 'local')).toBe(record)
  })
})

describe('rekeyWorkspaceSessionFields', () => {
  it('re-keys every worktree-keyed field and leaves the others alone', () => {
    const layout = { root: null, activeLeafId: null, expandedLeafId: null }
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [SHARED_ID]: [makeTab('tab-1')] },
      activeTabIdByWorktree: { [SHARED_ID]: 'tab-1' },
      // A tab-keyed field follows its owning tab, it is not re-keyed with the workspace.
      terminalLayoutsByTabId: { 'tab-1': layout },
      activeTabId: 'tab-1'
    }

    const next = rekeyWorkspaceSessionFields(session, new Set([SHARED_ID]), () => SSH_HOST)

    expect(next.tabsByWorktree).toEqual({
      [`${SSH_HOST}|${SHARED_ID}`]: [makeTab('tab-1')]
    })
    expect(next.activeTabIdByWorktree).toEqual({ [`${SSH_HOST}|${SHARED_ID}`]: 'tab-1' })
    expect(next.terminalLayoutsByTabId).toEqual(session.terminalLayoutsByTabId)
    expect(next.activeTabId).toBe('tab-1')
  })

  it('returns the same session when nothing moves', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'repo-a::/a': [] }
    }
    expect(rekeyWorkspaceSessionFields(session, new Set([SHARED_ID]), () => null)).toBe(session)
  })

  it('covers every worktree-keyed field of the ownership table', () => {
    // The rekey pass iterates the same table the persistence split routes by, so a new
    // `worktreeKeyed` field cannot skip the flip.
    expect(WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS).toContain('tabsByWorktree')
    expect(WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS).toContain('lastVisitedAtByWorktreeId')
    expect(WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS).not.toContain('terminalLayoutsByTabId')
  })
})
