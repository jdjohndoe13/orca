/**
 * STA-4343 fix 2 (RED): the `web-session-tabs-sync` mirror writes host-pushed tab rows under
 * the BARE worktree id. For a contested id (one repo id on two execution hosts) the unified
 * store must only ever hold `host|id` spellings for session slices: the bare row routes via
 * `buildHostSessionRouting` to the pinned primary partition (the lowest runtime id = win-b),
 * where the stripped key collides last-wins in `assignWorktreeKeyed` — so win-b's partition
 * DB-pollutes with whichever host's frame wrote the bare key last.
 *
 * The fix (design: C:\temp\orca-diag\fix2-design.md): run the pipeline bare (the host's own
 * spelling — the direct-SSH twin), then re-spell the PATCH's record keys to `host|id` for the
 * contested id only, tombstoning the store's pre-existing bare row. The built tabs'
 * `worktreeId` FIELDS stay bare (the host's own id).
 *
 * Today the pipeline keys the patch bare — every assertion below fails for exactly that
 * reason, never on import. The negative control (an uncontested id) must keep the bare
 * spelling byte-identically and passes today and after the fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '../store/types'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { getContestedWorktreeIds } from '../store/slices/worktrees/listing/worktree-catalog-index'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots
} from './web-session-tabs-sync/snapshots/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  LEAF_ID,
  NOW,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

// Why: web-session-tabs-sync imports the app-level store singleton; this suite drives the
// pure pipeline, like its sibling suites.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

// The live two-host shape the store dump shows (fixture style copied from
// store/slices/worktrees/session/contested-click-both-rows-flip.test.ts).
const REPO_ID = '2f26b94b-7ab6-458c-a8e1-b711dcc03eb1'
const VMD_ID = `${REPO_ID}::C:/vmd`
const WIN_A: ExecutionHostId = 'runtime:9937524c-610f-45f2-8a66-68fa9deaac33'
const WIN_B: ExecutionHostId = 'runtime:989e103b-98c7-403b-946f-c117ebd72a9d'
const ENV_A = WIN_A.slice('runtime:'.length)
const ENV_B = WIN_B.slice('runtime:'.length)
const KEY_A = composeWorktreeHostIdentity(WIN_A, VMD_ID)
const KEY_B = composeWorktreeHostIdentity(WIN_B, VMD_ID)

/** The worktree-keyed records the mirror pipeline writes (the `withWorktreeEntry` call sites). */
const WORKTREE_KEYED_PATCH_FIELDS = [
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'browserTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'tabBarOrderByWorktree',
  'activeTabIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeGroupIdByWorktree',
  'activeTabTypeByWorktree'
] as const satisfies readonly (keyof WebSessionTabsSyncState)[]

function row(hostId: ExecutionHostId): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the contested gate reads; the pipeline never narrows the rest.
  return {
    id: VMD_ID,
    repoId: REPO_ID,
    path: 'C:/vmd',
    hostId,
    displayName: `row-${hostId.slice(-4)}`,
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
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  } as unknown as Worktree
}

function contestedCatalog(): AppState['worktreesByRepo'] {
  return { [REPO_ID]: [row(WIN_A), row(WIN_B)] }
}

function uncontestedCatalog(): AppState['worktreesByRepo'] {
  return { [REPO_ID]: [row(WIN_B)] }
}

/**
 * The pipeline state is typed as a Pick of AppState, but every production commit site passes
 * the FULL store state (it carries `worktreesByRepo` at runtime). The fix widens the type
 * with `Partial<Pick<AppState,'worktreesByRepo'>>`; until then the superset variable is what
 * the seam must read, and the current pipeline ignores it (which is the bug).
 */
function mirrorState(
  overrides: Partial<WebSessionTabsSyncState>,
  worktreesByRepo: AppState['worktreesByRepo']
): WebSessionTabsSyncState {
  const state: WebSessionTabsSyncState & Pick<AppState, 'worktreesByRepo'> = {
    ...makeState(overrides),
    worktreesByRepo
  }
  return state
}

function hostTab(hostLabel: 'a' | 'b'): TerminalTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture carries only the fields the mirror's equality reads.
  return {
    id: toWebTerminalSurfaceTabId(`host-tab-${hostLabel}`),
    ptyId: `remote:${hostLabel === 'b' ? ENV_B : ENV_A}@@terminal-${hostLabel}1`,
    worktreeId: VMD_ID,
    title: `OC | board: win-${hostLabel} task`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  } as unknown as TerminalTab
}

function winBSnapshot() {
  return makeSnapshot(
    [
      {
        type: 'terminal' as const,
        id: `host-tab-b::${LEAF_ID}`,
        title: 'OC | board: win-b task',
        parentTabId: 'host-tab-b',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready' as const,
        terminal: 'terminal-b1'
      }
    ],
    { worktree: VMD_ID }
  )
}

function bareKeyScan(patch: Partial<WebSessionTabsSyncState>): string[] {
  const offenders: string[] = []
  for (const field of WORKTREE_KEYED_PATCH_FIELDS) {
    const record = patch[field]
    if (record && Object.hasOwn(record, VMD_ID)) {
      offenders.push(field)
    }
  }
  return offenders
}

describe('the contested mirror write spells the patch record keys with the host', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('the seed is genuinely contested', () => {
    expect(getContestedWorktreeIds(contestedCatalog())).toContain(VMD_ID)
    expect(getContestedWorktreeIds(uncontestedCatalog())).not.toContain(VMD_ID)
  })

  it('a win-b snapshot keys the patch under win-b|VMD, never the bare id', () => {
    const state = mirrorState({}, contestedCatalog())
    const patch = applyWebSessionTabsSnapshot(state, winBSnapshot(), ENV_B, NOW)

    expect(patch).not.toBe(state)
    expect(
      Object.hasOwn(patch.tabsByWorktree ?? {}, KEY_B),
      'the host row must be under the key'
    ).toBe(true)
    expect(bareKeyScan(patch), 'no worktree-keyed record may be keyed by the bare id').toEqual([])
    // The co-claimant's row is the catalog's business, not this apply's — it survives untouched.
    expect(patch.tabsByWorktree?.[KEY_A]).toBe(state.tabsByWorktree[KEY_A])
    // Constraint 3: the built tabs' worktreeId FIELD stays the host's bare id.
    expect(patch.tabsByWorktree?.[KEY_B]?.[0]?.worktreeId).toBe(VMD_ID)
  })

  it('reads the host’s live rows under the qualified key (the read sees the seeded row)', () => {
    // The read-direction half of the fix: the pipeline must see the host's live rows under
    // the qualified key (the bare-view fold). Without it the merge reads the bare key (empty),
    // so a tab the user opened on the publishing host reads as host-unknown and the merge
    // mints a fresh mirror instead of building on the live row — and the fresh row lands
    // under the bare key. The live row carries a distinguishing createdAt; the rebuild reuses
    // the existing tab's createdAt (terminal-build.ts:185) and adopts the host's title, so
    // the merged row must be BOTH the host's picture and the live row's identity. A read miss
    // mints `createdAt: now + index` under the bare key instead.
    const live = { ...hostTab('b'), createdAt: 1_600_000_000_000, title: 'client rename' }
    const state = mirrorState({ tabsByWorktree: { [KEY_B]: [live] } }, contestedCatalog())
    const patch = applyWebSessionTabsSnapshot(state, winBSnapshot(), ENV_B, NOW)

    expect(bareKeyScan(patch), 'the read miss must not mint a bare-keyed row').toEqual([])
    expect(patch.tabsByWorktree?.[KEY_B]?.[0]).toMatchObject({
      title: 'OC | board: win-b task',
      createdAt: live.createdAt
    })
  })

  it('tombstones the store’s pre-existing bare row for a contested id', () => {
    // The polluted boot shape (the user's DB): the partition's bare row — the co-claimant's
    // tab — survives the shallow merge and re-pollutes the primary partition on every split.
    // The first mirror frame must re-spell the host's rows to the qualified key and drop the
    // bare key from the record it writes.
    const state = mirrorState(
      {
        tabsByWorktree: {
          [KEY_A]: [hostTab('a')],
          [KEY_B]: [hostTab('b')],
          [VMD_ID]: [hostTab('a')]
        }
      },
      contestedCatalog()
    )
    const patch = applyWebSessionTabsSnapshot(state, winBSnapshot(), ENV_B, NOW)

    expect(bareKeyScan(patch), 'the bare row must not survive the merge').toEqual([])
    expect(Object.hasOwn(patch.tabsByWorktree ?? {}, KEY_B)).toBe(true)
    expect(patch.tabsByWorktree?.[KEY_A]).toBe(state.tabsByWorktree[KEY_A])
  })

  it('negative control: an uncontested id keeps the bare key byte-identically', () => {
    const snapshot = winBSnapshot()
    const withoutCatalog = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV_B, NOW)
    const withUncontestedCatalog = applyWebSessionTabsSnapshot(
      mirrorState({}, uncontestedCatalog()),
      snapshot,
      ENV_B,
      NOW
    )

    expect(withoutCatalog).not.toBe(withUncontestedCatalog)
    expect(withoutCatalog.tabsByWorktree?.[VMD_ID]).toBeTruthy()
    // The whole point of the contested-only gate: the catalog's presence changes nothing for
    // an id one host publishes.
    expect(withUncontestedCatalog).toEqual(withoutCatalog)
  })

  it('the batch path keys the merged patch under win-b|VMD and tombstones the bare row', () => {
    // The batch mutates its record copies in place on the state it owns, so the fold runs
    // once at the batch level and the merged patch is re-spelled at the end — the per-frame
    // wrapper is deliberately NOT the batch's seam.
    const state = mirrorState(
      {
        tabsByWorktree: {
          [KEY_A]: [hostTab('a')],
          [KEY_B]: [hostTab('b')],
          [VMD_ID]: [hostTab('a')]
        }
      },
      contestedCatalog()
    )
    const patch = applyWebSessionTabsSnapshots(state, [winBSnapshot()], ENV_B, NOW)

    expect(patch).not.toBe(state)
    expect(bareKeyScan(patch), 'the merged patch may not be keyed by the bare id').toEqual([])
    expect(Object.hasOwn(patch.tabsByWorktree ?? {}, KEY_B)).toBe(true)
    expect(patch.tabsByWorktree?.[KEY_A]).toBe(state.tabsByWorktree[KEY_A])
    expect(patch.tabsByWorktree?.[KEY_B]?.[0]?.worktreeId).toBe(VMD_ID)
  })

  it('the batch path on an uncontested id keeps the bare key byte-identically', () => {
    const snapshot = winBSnapshot()
    const withoutCatalog = applyWebSessionTabsSnapshots(makeState(), [snapshot], ENV_B, NOW)
    const withUncontestedCatalog = applyWebSessionTabsSnapshots(
      mirrorState({}, uncontestedCatalog()),
      [snapshot],
      ENV_B,
      NOW
    )

    expect(withoutCatalog.tabsByWorktree?.[VMD_ID]).toBeTruthy()
    expect(withUncontestedCatalog).toEqual(withoutCatalog)
  })
})
