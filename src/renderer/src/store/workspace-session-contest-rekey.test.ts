/**
 * The contested gate flips mid-session, and the live rows have to follow it (STA-4343).
 *
 * The gate is derived from the catalog, so a second host registering a path another host already
 * has — or one of them dropping out — moves the key a workspace's rows live under. The write side
 * already routes each row by the key it resolves now, so a flip that leaves the rows behind strands
 * them: the workbench mounts, reads nothing, and paints black.
 *
 * These drive the real slice store with the listener installed the way the app's store creator
 * installs it, because the interesting part is that the flip is derived from the catalog rather
 * than threaded through every catalog write path.
 */
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { createTestStore } from './testing/app-store-test-fixture'
import { makeWorktree } from './slices/worktrees/worktree.test-fixture'
import { makeTab } from './terminals/testing/terminal-tab.test-fixture'
import { installContestRekey } from './workspace-session-contest-rekey'
import { readWorkspaceSessionRecord } from './workspace-session-key'
import { getContestedWorktreeIds } from './slices/worktrees/listing/worktree-catalog-index'

const REPO_ID = 'repo1'
const WORKTREE_ID = `${REPO_ID}::/srv/vmd`
const SSH_HOST = 'ssh:paired-box'
const SESSION_KEY = `${SSH_HOST}|${WORKTREE_ID}`

type TestStore = ReturnType<typeof createTestStore>

function catalog(store: TestStore, hostIds: readonly ExecutionHostId[]): void {
  store.setState({
    worktreesByRepo: {
      [REPO_ID]: hostIds.map((hostId) =>
        makeWorktree({ id: WORKTREE_ID, repoId: REPO_ID, path: '/srv/vmd', hostId })
      )
    },
    repos: [
      {
        id: REPO_ID,
        path: '/srv/vmd',
        displayName: 'Vmd',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: null
      }
    ]
  })
}

function seedRows(store: TestStore): void {
  const live = store.getState()
  store.setState({
    tabsByWorktree: {
      ...live.tabsByWorktree,
      [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID, title: 'tab' })]
    },
    activeTabIdByWorktree: { ...live.activeTabIdByWorktree, [WORKTREE_ID]: 'tab-1' },
    pendingReconnectWorktreeIds: [WORKTREE_ID],
    pendingReconnectTabByWorktree: { [WORKTREE_ID]: ['tab-1'] }
  })
}

/** The two-stage seed the flip's host evidence needs: the owner has to be provable BEFORE the flip. */
function createContestedStore(): TestStore {
  const store = createTestStore()
  installContestRekey(store)
  catalog(store, [SSH_HOST])
  seedRows(store)
  expect(getContestedWorktreeIds(store.getState().worktreesByRepo).size).toBe(0)
  expect(store.getState().tabsByWorktree[WORKTREE_ID]).toBeDefined()
  return store
}

describe('contested-gate flip re-keys the live session rows', () => {
  it('moves the rows to the qualified key when the contest appears', () => {
    const store = createContestedStore()
    const before = store.getState()

    catalog(store, [SSH_HOST, 'local'])

    const after = store.getState()
    expect(getContestedWorktreeIds(after.worktreesByRepo)).toContain(WORKTREE_ID)
    expect(
      after.tabsByWorktree[SESSION_KEY],
      'the flip left the rows at a key no reader resolves'
    ).toBe(before.tabsByWorktree[WORKTREE_ID])
    expect(after.tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(after.activeTabIdByWorktree[SESSION_KEY]).toBe('tab-1')
    expect(after.activeTabIdByWorktree[WORKTREE_ID]).toBeUndefined()
    // The reconnect queue indexes the maps by its own id, so it travels with them.
    expect(after.pendingReconnectWorktreeIds).toEqual([SESSION_KEY])
    expect(after.pendingReconnectTabByWorktree[SESSION_KEY]).toEqual(['tab-1'])
    // The read side finds the row from the store's own state.
    const found = readWorkspaceSessionRecord(after, after.tabsByWorktree, WORKTREE_ID, SSH_HOST)
    expect(found?.key).toBe(SESSION_KEY)
  })

  it('brings the rows back to the bare key when the contest clears', () => {
    const store = createContestedStore()
    catalog(store, [SSH_HOST, 'local'])
    const flipped = store.getState()
    const qualifiedRow = flipped.tabsByWorktree[SESSION_KEY]
    expect(qualifiedRow).toBeDefined()

    catalog(store, [SSH_HOST])

    const after = store.getState()
    expect(getContestedWorktreeIds(after.worktreesByRepo).size).toBe(0)
    expect(
      after.tabsByWorktree[WORKTREE_ID],
      'the contest cleared but the rows stayed qualified'
    ).toBe(qualifiedRow)
    expect(after.tabsByWorktree[SESSION_KEY]).toBeUndefined()
    expect(after.activeTabIdByWorktree[WORKTREE_ID]).toBe('tab-1')
    expect(after.pendingReconnectWorktreeIds).toEqual([WORKTREE_ID])
    const found = readWorkspaceSessionRecord(after, after.tabsByWorktree, WORKTREE_ID, SSH_HOST)
    expect(found?.key).toBe(WORKTREE_ID)
  })

  it('leaves an uncontested store alone', () => {
    const store = createTestStore()
    installContestRekey(store)
    catalog(store, [SSH_HOST])
    seedRows(store)
    const before = store.getState()

    // A catalog refresh that flags nothing must not rewrite the session records at all.
    catalog(store, [SSH_HOST])

    const after = store.getState()
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.activeTabIdByWorktree).toBe(before.activeTabIdByWorktree)
    expect(after.pendingReconnectWorktreeIds).toBe(before.pendingReconnectWorktreeIds)
  })

  it('does not guess a host for a row the catalog cannot attribute', () => {
    const store = createTestStore()
    installContestRekey(store)
    // The rows were restored before the host's catalog landed, so the pre-flip catalog cannot name
    // an owner — and the flip must not move the row onto a guessed host.
    store.setState({
      repos: [
        {
          id: REPO_ID,
          path: '/srv/vmd',
          displayName: 'Vmd',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: null
        }
      ]
    })
    seedRows(store)
    const before = store.getState()

    catalog(store, [SSH_HOST, 'local'])

    const after = store.getState()
    expect(getContestedWorktreeIds(after.worktreesByRepo)).toContain(WORKTREE_ID)
    expect(
      after.tabsByWorktree[WORKTREE_ID],
      'the flip guessed a host for a row the catalog could not attribute'
    ).toBe(before.tabsByWorktree[WORKTREE_ID])
  })
})
