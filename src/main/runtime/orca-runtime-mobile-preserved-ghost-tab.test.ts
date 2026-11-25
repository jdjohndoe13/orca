import { withDurableRuntimeStore } from './construction/test-context/runtime-durable-store-fixture'
/**
 * Multi-host ghost tab: a host-retired terminal whose record persists (record +
 * layout + live PTY) but whose group membership is gone. The host's own UI is
 * group-driven so it hides the tab, but the record-inventory publication kept
 * re-adding it through the preserved-merge, and the controller's attach kept
 * the PTY connected — a self-sustaining duplicate tab on every paired client.
 *
 * Invariant under test: the persisted group is the host's membership authority;
 * a renderer-omitted terminal whose parent is absent from EVERY group's
 * tabOrder stops being preserved, and the release path clears the ownership
 * flags so the paired-restore stops re-rescuing the ghost.
 *
 * Controls pin the opposite failure mode (STA-4593): a tab still in a group,
 * a session with no group authority at all, and a tab in a non-first group of
 * a split worktree must all stay preserved.
 */
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/orca-profiles/constants'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-ghost-tab'
const WORKTREE_PATH = '/tmp/ghost-tab'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const TAB_GHOST = 'tab-ghost'
const TAB_LIVE = 'tab-live'
const TAB_GROUP_B = 'tab-group-b'
const LEAF_G = '11111111-1111-4111-8111-111111111111'
const LEAF_L = '22222222-2222-4222-8222-222222222222'
const LEAF_B = '33333333-3333-4333-8333-333333333333'
const PTY_G = 'pty-ghost'
const PTY_L = 'pty-live'
const PTY_B = 'pty-group-b'
const INC_G = '44444444-4444-4444-8444-444444444444'
const INC_L = '55555555-5555-4555-8555-555555555555'
const INC_B = '66666666-6666-4666-8666-666666666666'

type TabSpec = { tabId: string; leafId: string; ptyId: string; inc: string }
const TAB_SPECS: Record<string, TabSpec> = {
  [TAB_GHOST]: { tabId: TAB_GHOST, leafId: LEAF_G, ptyId: PTY_G, inc: INC_G },
  [TAB_LIVE]: { tabId: TAB_LIVE, leafId: LEAF_L, ptyId: PTY_L, inc: INC_L },
  [TAB_GROUP_B]: { tabId: TAB_GROUP_B, leafId: LEAF_B, ptyId: PTY_B, inc: INC_B }
}

function makeSession(
  tabIds: readonly string[],
  groups: WorkspaceSessionState['tabGroups']
): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: tabIds.map((tabId, index) => ({
        id: tabId,
        ptyId: TAB_SPECS[tabId]!.ptyId,
        worktreeId: WORKTREE_ID,
        title: tabId,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: index + 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabIds.map((tabId) => [
        tabId,
        {
          root: { type: 'leaf' as const, leafId: TAB_SPECS[tabId]!.leafId },
          activeLeafId: TAB_SPECS[tabId]!.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TAB_SPECS[tabId]!.leafId]: TAB_SPECS[tabId]!.ptyId }
        }
      ])
    ),
    terminalPtyIncarnationsByPaneKey: Object.fromEntries(
      tabIds.map((tabId) => [makePaneKey(tabId, TAB_SPECS[tabId]!.leafId), TAB_SPECS[tabId]!.inc])
    ),
    ...(groups ? { tabGroups: groups } : {})
  }
}

function group(id: string, tabOrder: string[]) {
  return {
    id,
    worktreeId: WORKTREE_ID,
    activeTabId: tabOrder[0] ?? null,
    tabOrder,
    recentTabIds: [...tabOrder]
  }
}

type RuntimeInternals = {
  ptysById: Map<string, { runtimeSessionOwned: boolean }>
  pairedRendererSessionOwnedPtyIds: Set<string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are protected runtime state; the assertion names only the two this suite seeds, and each is read back only after being seeded.
  return runtime as unknown as RuntimeInternals
}

function createHarness(options: {
  tabIds: readonly string[]
  groups: WorkspaceSessionState['tabGroups']
}) {
  let session = makeSession(options.tabIds, options.groups)
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'ghost-tab',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = withDurableRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries only the members the preserved-ghost-tab path reads; the rest of the store is unreached.
  const runtime = new OrcaRuntimeService(store as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries only the members close paths read; the rest of the notifier is unreached.
  runtime.setNotifier({ closeTerminal: vi.fn(), closeTerminalTab: vi.fn(async () => {}) } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries the members this suite exercises; every PTY stays live throughout.
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    stopAndWait: vi.fn(async () => true),
    listProcesses: vi.fn(async () =>
      Object.values(TAB_SPECS).map((spec) => ({
        id: spec.ptyId,
        incarnationId: spec.inc,
        cwd: WORKTREE_PATH,
        title: spec.tabId
      }))
    ),
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)

  const publishRendererSnapshot = (tabIds: readonly string[], snapshotVersion: number) => {
    runtime.syncWindowGraph(1, {
      tabs: tabIds.map((tabId) => ({
        tabId,
        worktreeId: WORKTREE_ID,
        title: tabId,
        activeLeafId: TAB_SPECS[tabId]!.leafId,
        layout: { type: 'leaf' as const, leafId: TAB_SPECS[tabId]!.leafId }
      })),
      leaves: tabIds.map((tabId, index) => ({
        tabId,
        worktreeId: WORKTREE_ID,
        leafId: TAB_SPECS[tabId]!.leafId,
        paneRuntimeId: index + 7,
        ptyId: TAB_SPECS[tabId]!.ptyId
      })),
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:ghost-tab',
          snapshotVersion,
          activeGroupId: 'group-1',
          activeTabId: tabIds.length ? `${tabIds[0]}::${TAB_SPECS[tabIds[0]!]!.leafId}` : null,
          activeTabType: tabIds.length ? ('terminal' as const) : null,
          tabs: tabIds.map((tabId, index) => ({
            type: 'terminal' as const,
            id: `${tabId}::${TAB_SPECS[tabId]!.leafId}`,
            parentTabId: tabId,
            leafId: TAB_SPECS[tabId]!.leafId,
            ptyId: TAB_SPECS[tabId]!.ptyId,
            title: tabId,
            isActive: index === 0
          }))
        }
      ]
    })
  }

  for (const tabId of options.tabIds) {
    const spec = TAB_SPECS[tabId]!
    runtime.registerPty(spec.ptyId, WORKTREE_ID, null, {
      tabId: spec.tabId,
      leafId: spec.leafId,
      incarnationId: spec.inc
    })
    // Byte-identical to a paired create: runtimeSessionOwned + paired-owned.
    const seeded = internals(runtime)
    seeded.ptysById.get(spec.ptyId)!.runtimeSessionOwned = true
    seeded.pairedRendererSessionOwnedPtyIds.add(spec.ptyId)
  }
  publishRendererSnapshot(options.tabIds, 1)

  return {
    runtime,
    publishRendererSnapshot,
    setGroups: (groups: WorkspaceSessionState['tabGroups']) => {
      session = makeSession(options.tabIds, groups)
    },
    isRuntimeSessionOwned: (ptyId: string) =>
      internals(runtime).ptysById.get(ptyId)?.runtimeSessionOwned === true
  }
}

async function listParentTabIds(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  return [
    ...new Set(
      listed.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id)).sort()
    )
  ]
}

describe('a host-retired ghost tab stops being preserved', () => {
  it('red: a record absent from every group tabOrder is not preserved on the next sync', async () => {
    const harness = createHarness({
      tabIds: [TAB_GHOST, TAB_LIVE],
      groups: { [WORKTREE_ID]: [group('group-1', [TAB_GHOST, TAB_LIVE])] }
    })
    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_GHOST, TAB_LIVE])

    // The host closes the tab: its group drops the id, the record + layout +
    // live PTY linger (the controller's own attach keeps the PTY connected).
    // The renderer's next publication omits the tab.
    harness.setGroups({ [WORKTREE_ID]: [group('group-1', [TAB_LIVE])] })
    harness.publishRendererSnapshot([TAB_LIVE], 2)

    expect(
      await listParentTabIds(harness.runtime),
      'the preserved-merge resurrected a ghost the host group retired'
    ).toEqual([TAB_LIVE])
    expect(harness.isRuntimeSessionOwned(PTY_G)).toBe(false)
  })

  it('red: the exact production shape — 2 records, 1 group with 1 tab — never re-adds', async () => {
    const harness = createHarness({
      tabIds: [TAB_GHOST, TAB_LIVE],
      groups: { [WORKTREE_ID]: [group('group-1', [TAB_LIVE])] }
    })
    // The stale publication still carries the ghost; the group never listed it.
    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_GHOST, TAB_LIVE])

    harness.publishRendererSnapshot([TAB_LIVE], 2)
    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_LIVE])

    // A withheld-unchanged sync (identical publication resend) must not re-add.
    harness.publishRendererSnapshot([TAB_LIVE], 3)
    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_LIVE])
  })

  it('control: a group-listed tab omitted by a stale publication stays preserved', async () => {
    const harness = createHarness({
      tabIds: [TAB_GHOST, TAB_LIVE],
      groups: { [WORKTREE_ID]: [group('group-1', [TAB_GHOST, TAB_LIVE])] }
    })
    // The renderer's publication is stale (omits TAB_GHOST) but the group still
    // lists it — the tab lives, the publication does not speak for membership.
    harness.publishRendererSnapshot([TAB_LIVE], 2)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_GHOST, TAB_LIVE])
    expect(harness.isRuntimeSessionOwned(PTY_G)).toBe(true)
  })

  it('control: a session with no group authority at all keeps preservation', async () => {
    const harness = createHarness({ tabIds: [TAB_GHOST, TAB_LIVE], groups: undefined })
    // Legacy/pre-group session: vacuous guard, the STA-4593 behavior.
    harness.publishRendererSnapshot([TAB_LIVE], 2)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_GHOST, TAB_LIVE])
    expect(harness.isRuntimeSessionOwned(PTY_G)).toBe(true)
  })

  it('control: a tab in a non-first group of a split worktree is preserved', async () => {
    const harness = createHarness({
      tabIds: [TAB_LIVE, TAB_GROUP_B],
      groups: {
        [WORKTREE_ID]: [group('group-1', [TAB_LIVE]), group('group-2', [TAB_GROUP_B])]
      }
    })
    // The stale publication omits the group-B tab; the guard must scan every group.
    harness.publishRendererSnapshot([TAB_LIVE], 2)

    expect(await listParentTabIds(harness.runtime)).toEqual([TAB_GROUP_B, TAB_LIVE])
    expect(harness.isRuntimeSessionOwned(PTY_B)).toBe(true)
  })
})
