/**
 * A contested workspace's snapshot rows must land where the surface reads them (STA-4343).
 *
 * One repo registered on two execution hosts publishes the SAME worktree id for two workspaces, so
 * once the contested gate fires the surface reads the workspace's rows at `ssh:<target>|<id>`. The
 * host publishes bare ids, so before this fix the apply wrote the row under the bare id, the
 * workbench read the qualified key, missed, and painted black.
 *
 * The apply must also keep a tab the user opened on the reconnecting host — the live row lives
 * under the qualified key, and the merge is bare-id keyed end to end, so the fold has to bring it
 * back for the merge to see it. And the co-claimant's row (`local|<id>`) is a different workspace
 * and must not move.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { readWorkspaceSessionRecord } from '../store/workspace-session-key'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'ssh-target-1'
const HOST_ID = `ssh:${TARGET_ID}`
const PATH = '/srv/proj/bug-cats'
const WORKTREE_ID = `repoA::${PATH}`
const SESSION_KEY = `${HOST_ID}|${WORKTREE_ID}`
const LOCAL_KEY = `local|${WORKTREE_ID}`

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function token(snapshotRevision: number): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

function snapshot(revision: number, tabIds: readonly string[]): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: PATH,
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        [PATH]: tabIds.map((tabId, index) => ({
          id: tabId,
          worktreePath: PATH,
          ptyId: `pty-${tabId}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [PATH]: tabIds[0] ?? null },
      remoteSessionIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`])),
      lastVisitedAtByWorktreePath: { [PATH]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [PATH]: true }
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

/** The same repo row on two hosts — the contested gate's condition. */
function seedContestedCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({ id: WORKTREE_ID, repoId: 'repoA', path: PATH, hostId: 'local' }),
        makeWorktree({ id: WORKTREE_ID, repoId: 'repoA', path: PATH, hostId: HOST_ID })
      ]
    },
    repos: [
      {
        id: 'repoA',
        path: '/srv/proj',
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      }
    ],
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: HOST_ID,
    reconnectPersistedTerminals: async () => {},
    markRemoteWorkspaceHydrated: () => {},
    setRemoteWorkspaceSyncStatus: () => {}
  })
}

/** The live rows exactly as the (already-wired) write side keys them for a contested id. */
function seedLiveRows(store: TestStore): void {
  const live = store.getState()
  store.setState({
    tabsByWorktree: {
      ...live.tabsByWorktree,
      [SESSION_KEY]: [makeTab({ id: 'setup', worktreeId: WORKTREE_ID, title: 'setup' })],
      [LOCAL_KEY]: [makeTab({ id: 'local-tab', worktreeId: WORKTREE_ID, title: 'local' })]
    },
    activeTabIdByWorktree: {
      ...live.activeTabIdByWorktree,
      [SESSION_KEY]: 'setup',
      [LOCAL_KEY]: 'local-tab'
    },
    defaultTerminalTabsAppliedByWorktreeId: {
      ...live.defaultTerminalTabsAppliedByWorktreeId,
      [SESSION_KEY]: true
    }
  })
}

async function applySnapshot(
  store: TestStore,
  snap: RemoteWorkspaceObservedSnapshot
): Promise<void> {
  await applyDirectSshRemoteWorkspaceSnapshot({
    store,
    snapshot: snap,
    token: token(snap.revision),
    arrival: 1,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    waitForWorkspaceSessionReady: async () => true,
    finalizeHydratedTerminals: () => 0
  })
}

describe('direct-SSH snapshot apply for a contested workspace id', () => {
  it('lands the host row under the session key the reader resolves', async () => {
    const store = createTestStore()
    seedContestedCatalog(store)
    seedLiveRows(store)

    await applySnapshot(store, snapshot(1, ['agent']))

    const after = store.getState()
    const row = after.tabsByWorktree[SESSION_KEY] ?? []
    expect(
      row.map((tab) => tab.id),
      'the apply wrote the row where no reader looks'
    ).toEqual(expect.arrayContaining(['agent', 'setup']))
    // The bare bucket is displaced by the qualified key — a row left behind is one no reader
    // resolves and the persistence split would route by the catalog's current guess.
    expect(after.tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    // The read side (the workbench's own accessor) finds the row.
    const found = readWorkspaceSessionRecord(after, after.tabsByWorktree, WORKTREE_ID, HOST_ID)
    expect(found?.key, 'readWorkspaceSessionRecord missed the row the apply wrote').toBe(
      SESSION_KEY
    )
    expect(found?.entry.map((tab) => tab.id)).toEqual(expect.arrayContaining(['agent', 'setup']))
    // The tab entity keeps the bare id; only the record key carries the host.
    for (const tab of after.tabsByWorktree[SESSION_KEY] ?? []) {
      expect(tab.worktreeId).toBe(WORKTREE_ID)
    }
    // The per-worktree companions travel with the row.
    expect(after.activeTabIdByWorktree[SESSION_KEY]).toBe('agent')
    expect(after.activeTabIdByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(after.defaultTerminalTabsAppliedByWorktreeId[SESSION_KEY]).toBe(true)
    // The active workspace is an entity, not a session key — it stays bare.
    expect(after.activeWorktreeId).toBe(WORKTREE_ID)
  })

  it('never moves the co-claimant host row', async () => {
    const store = createTestStore()
    seedContestedCatalog(store)
    seedLiveRows(store)
    const localRow = store.getState().tabsByWorktree[LOCAL_KEY]

    await applySnapshot(store, snapshot(1, ['agent']))

    const after = store.getState()
    expect(after.tabsByWorktree[LOCAL_KEY]).toBe(localRow)
    expect(after.activeTabIdByWorktree[LOCAL_KEY]).toBe('local-tab')
    // The target's own active tab must not be painted into the other host's card.
    expect((after.tabsByWorktree[LOCAL_KEY] ?? []).map((tab) => tab.id)).toEqual(['local-tab'])
  })

  it('keeps applying uncontested snapshots byte-identically', async () => {
    const store = createTestStore()
    // One host, no collision: the key rule says the bare id is the session key, and every fold
    // this pass runs must be the identity.
    store.setState({
      worktreesByRepo: {
        repoA: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repoA',
            path: PATH,
            hostId: HOST_ID
          })
        ]
      },
      repos: [
        {
          id: 'repoA',
          path: '/srv/proj',
          displayName: 'Proj',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: TARGET_ID
        }
      ],
      activeWorktreeId: WORKTREE_ID,
      reconnectPersistedTerminals: async () => {},
      markRemoteWorkspaceHydrated: () => {},
      setRemoteWorkspaceSyncStatus: () => {}
    })

    await applySnapshot(store, snapshot(1, ['agent']))

    const after = store.getState()
    expect(after.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['agent'])
    expect(after.tabsByWorktree[SESSION_KEY]).toBeUndefined()
  })
})
