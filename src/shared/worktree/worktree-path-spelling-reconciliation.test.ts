/**
 * The same Windows checkout persisted under both separator spellings must reconcile onto the
 * canonical id at load: one metadata row, one session row per field, one contested id — and no
 * row lost.
 *
 * The two spellings are the same workspace by definition (the fold is separator-only and
 * case-preserving), so a row keyed by the raw spelling is a duplicate of the canonical one, not
 * a second workspace. Before ingest canonicalization, installs accumulated both spellings inside
 * one partition, which split the workspace's rows and kept the contested gate from ever firing.
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../orca-profiles/constants'
import type { PersistedState } from '../orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import { reconcilePersistedWorktreeIdPathSpellings } from './worktree-path-spelling-reconciliation'
import { collectWorktreeIdSpellings } from './worktree-id-spellings'

const RAW = 'repo-1::C:\\vmd'
const CANONICAL = 'repo-1::C:/vmd'
const POSIX_RAW = 'repo-1::/a\\b'

function makeState(): PersistedState {
  const state = getDefaultPersistedState(homedir())
  state.worktreeMeta[CANONICAL] = {
    ...state.worktreeMeta[CANONICAL],
    displayName: 'vmd',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 500
  }
  state.worktreeMeta[RAW] = {
    ...state.worktreeMeta[RAW],
    displayName: 'vmd',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 900
  }
  return state
}

function sessionWith(partial: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...partial }
}

describe('reconcilePersistedWorktreeIdPathSpellings', () => {
  it('merges the two spellings of one workspace onto the canonical id', () => {
    const state = makeState()
    state.workspaceSession = sessionWith({
      activeWorktreeId: RAW,
      activeWorkspaceKey: `worktree:${RAW}`,
      tabsByWorktree: {
        [RAW]: [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: RAW,
            title: 't',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      activeTabTypeByWorktree: { [RAW]: 'terminal', [CANONICAL]: 'editor' },
      lastVisitedAtByWorktreeId: { [RAW]: 100, [CANONICAL]: 400 },
      activeWorktreeIdsOnShutdown: [RAW, CANONICAL]
    })

    expect(reconcilePersistedWorktreeIdPathSpellings(state)).toBe(true)

    // One metadata row, newest `lastActivityAt` wins, and the folded spelling is remembered.
    expect(Object.keys(state.worktreeMeta)).toEqual([CANONICAL])
    expect(state.worktreeMeta[CANONICAL]?.lastActivityAt).toBe(900)
    expect(state.worktreeMeta[CANONICAL]?.priorWorktreeIds).toContain(RAW)

    // One row per session field, keyed canonically.
    const session = state.workspaceSession
    expect(Object.keys(session.tabsByWorktree)).toEqual([CANONICAL])
    // Later wins on collision, matching the rekey convention.
    expect(session.activeTabTypeByWorktree).toEqual({ [CANONICAL]: 'editor' })
    // Recency merges by max, matching the migrateWorktreeIdentity convention.
    expect(session.lastVisitedAtByWorktreeId).toEqual({ [CANONICAL]: 400 })
    // Row values that name their worktree follow the key.
    expect(session.tabsByWorktree[CANONICAL]?.[0]?.worktreeId).toBe(CANONICAL)
    expect(session.activeWorktreeId).toBe(CANONICAL)
    expect(session.activeWorkspaceKey).toBe(`worktree:${CANONICAL}`)
    expect(session.activeWorktreeIdsOnShutdown).toEqual([CANONICAL])
  })

  it('keeps both spellings when they are genuinely different workspaces', () => {
    const state = makeState()
    state.worktreeMeta[POSIX_RAW] = {
      ...state.worktreeMeta[CANONICAL],
      lastActivityAt: 100
    }
    state.workspaceSession = sessionWith({
      activeTabTypeByWorktree: { [POSIX_RAW]: 'terminal' }
    })

    reconcilePersistedWorktreeIdPathSpellings(state)

    // A POSIX backslash is a filename character — never folded.
    expect(state.worktreeMeta[POSIX_RAW]).toBeDefined()
    expect(state.workspaceSession.activeTabTypeByWorktree).toEqual({ [POSIX_RAW]: 'terminal' })
  })

  it('never folds the ids the host compares byte-exactly', () => {
    // A folder repo's workspace and a folder-upgrade repo's locator are the host's own
    // byte-exact keys: the host's `isFolderWorkspaceIdForRepo` and the folder-locator's OMP
    // meta lookup both compare the id verbatim. Folding them would orphan the metadata and
    // call the folder's own workspace a different repo's.
    const state = makeState()
    const folderRoot = 'folder-1::D:\\shared\\models'
    const folderInstance = `${folderRoot}::workspace:123e4567-e89b-12d3-a456-426614174000`
    const upgradeRoot = 'upgraded-1::B:\\intersub\\temp\\ribbon'
    const upgradeSibling = 'upgraded-1::B:\\intersub\\temp\\ribbon\\worktree'
    const repoBase = {
      displayName: 'r',
      badgeColor: '#000',
      addedAt: 1,
      kind: 'git' as const
    }
    state.repos = [
      { ...repoBase, id: 'folder-1', path: 'D:\\shared\\models', kind: 'folder' },
      {
        ...repoBase,
        id: 'upgraded-1',
        path: 'B:\\intersub\\temp\\ribbon',
        folderUpgradeGitRootPath: 'B:/intersub/temp/ribbon'
      }
    ]
    for (const id of [folderRoot, folderInstance, upgradeRoot, upgradeSibling]) {
      state.worktreeMeta[id] = {
        ...state.worktreeMeta[CANONICAL],
        lastActivityAt: 100
      }
    }
    state.workspaceSession = sessionWith({
      activeTabTypeByWorktree: {
        [folderRoot]: 'terminal',
        [upgradeRoot]: 'terminal',
        [upgradeSibling]: 'terminal'
      }
    })

    const map = collectWorktreeIdSpellings(state)
    // Only the folder-upgrade repo's OTHER worktree folds — the locator itself is protected.
    expect(map.get(RAW)).toBe(CANONICAL)
    expect(map.get(upgradeSibling)).toBe('upgraded-1::B:/intersub/temp/ribbon/worktree')
    expect(map.has(folderRoot)).toBe(false)
    expect(map.has(folderInstance)).toBe(false)
    expect(map.has(upgradeRoot)).toBe(false)

    reconcilePersistedWorktreeIdPathSpellings(state)

    for (const id of [folderRoot, folderInstance, upgradeRoot]) {
      expect(state.worktreeMeta[id]).toBeDefined()
    }
    expect(state.workspaceSession.activeTabTypeByWorktree?.[folderRoot]).toBe('terminal')
    expect(state.workspaceSession.activeTabTypeByWorktree?.[upgradeRoot]).toBe('terminal')
    // The unprotected sibling did fold.
    expect(
      state.workspaceSession.activeTabTypeByWorktree?.[
        'upgraded-1::B:/intersub/temp/ribbon/worktree'
      ]
    ).toBe('terminal')
  })

  it('is a no-op on a state without two spellings', () => {
    const state = getDefaultPersistedState(homedir())
    state.worktreeMeta[CANONICAL] = {
      ...state.worktreeMeta[CANONICAL],
      displayName: 'vmd',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    }
    const session = state.workspaceSession
    expect(reconcilePersistedWorktreeIdPathSpellings(state)).toBe(false)
    expect(state.workspaceSession).toBe(session)
  })

  it('collects the spellings from every partition and record', () => {
    const state = makeState()
    state.workspaceSessionsByHostId = {
      'runtime:env-1': sessionWith({
        activeTabTypeByWorktree: { [RAW]: 'terminal' },
        lastVisitedAtByWorktreeId: { [`runtime:env-1|${RAW}`]: 7 }
      })
    }
    state.worktreeIdentityAliases = { [`local|${RAW}`]: ['wt2:local:one'] }
    state.mobileClientTabSelectionsByDeviceId = {
      device1: { [RAW]: { activeTabId: null, activeGroupId: null, activeTabIdByGroupId: {} } }
    }
    state.worktreeLineageById = {
      [RAW]: {
        worktreeId: RAW,
        worktreeInstanceId: 'inst-1',
        parentWorktreeId: RAW,
        parentWorktreeInstanceId: 'inst-0',
        origin: 'manual',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }

    const map = collectWorktreeIdSpellings(state)
    expect(map.get(RAW)).toBe(CANONICAL)

    expect(reconcilePersistedWorktreeIdPathSpellings(state)).toBe(true)
    expect(
      Object.keys(state.workspaceSessionsByHostId!['runtime:env-1']!.activeTabTypeByWorktree!)
    ).toEqual([CANONICAL])
    // A qualified visit key folds its id part and keeps its host prefix.
    expect(state.workspaceSessionsByHostId!['runtime:env-1']!.lastVisitedAtByWorktreeId).toEqual({
      [`runtime:env-1|${CANONICAL}`]: 7
    })
    expect(Object.keys(state.worktreeIdentityAliases!)).toEqual([`local|${CANONICAL}`])
    expect(Object.keys(state.mobileClientTabSelectionsByDeviceId!.device1)).toEqual([CANONICAL])
    expect(Object.keys(state.worktreeLineageById)).toEqual([CANONICAL])
    expect(state.worktreeLineageById[CANONICAL]?.worktreeId).toBe(CANONICAL)
  })
})
