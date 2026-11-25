import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesStrictMock
  }
})

vi.mock('electron', () => electronMocks)
vi.mock('../catalog/repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())

import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { _resetWorktreeCatalogOwnerForTests } from '../../../workspaces/catalog/repo-worktree-catalog-owner'

import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../construction/test-context/runtime-store-partial-fixture'

const REPO_ID = 'repo-remote'
const REPO_PATH = '/home/user/projects/app'
const WORKTREE_PATH = '/home/user/projects/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const SCRATCH_ID = `${REPO_ID}::${REPO_PATH}/.claude/worktrees/scratch`
const RUNTIME_HOST_ID = 'runtime:env-1' as const

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return storeWorktreeMeta({
    displayName: 'feature',
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    ...overrides
  })
}

const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

// Seed real lineage rows so pruning assertions discriminate.
function makeLineage(): Record<string, WorktreeLineage> {
  return {
    [WORKTREE_ID]: {
      worktreeId: WORKTREE_ID,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: MAIN_WORKTREE_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' },
      createdAt: 1
    }
  }
}

type StoreOptions = {
  connectionId?: string
  executionHostId?: `runtime:${string}`
  metaById?: Record<string, WorktreeMeta>
  removeWorktreeLineage?: (target: HostWorktreeTarget) => void
  /** Extra `getRepos()` rows appended after the primary one, for same-id-on-two-hosts coverage. */
  coHostedRepos?: { id: string; path: string; connectionId?: string }[]
}

function makeStore(options: StoreOptions = {}) {
  const metaById = options.metaById ?? {
    [WORKTREE_ID]: makeMeta(),
    [MAIN_WORKTREE_ID]: makeMeta({ displayName: 'main', instanceId: 'parent-instance' })
  }
  const lineageById = makeLineage()
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      storeRepo({
        id: REPO_ID,
        path: REPO_PATH,
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1,
        ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
        ...(options.executionHostId === undefined
          ? {}
          : { executionHostId: options.executionHostId })
      }),
      ...(options.coHostedRepos ?? []).map((repo) =>
        storeRepo({ displayName: 'app', badgeColor: 'blue', addedAt: 1, ...repo })
      )
    ],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => lineageById,
    getAllWorkspaceLineage: () => ({
      [worktreeWorkspaceKey(WORKTREE_ID)]: {
        childWorkspaceKey: worktreeWorkspaceKey(WORKTREE_ID),
        childInstanceId: 'child-instance',
        parentWorkspaceKey: worktreeWorkspaceKey(MAIN_WORKTREE_ID),
        parentInstanceId: 'parent-instance',
        origin: 'cli' as const,
        capture: { source: 'env-workspace' as const, confidence: 'inferred' as const },
        createdAt: 1
      }
    }),
    removeWorktreeLineage: options.removeWorktreeLineage ?? vi.fn(),
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

function neverSettles() {
  return new Promise<never>(() => {})
}

async function advancePastRepoScanBudget<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6_000)
  return pending
}

describe('worktree.ps on a degraded repo scan', () => {
  beforeEach(() => {
    // The catalog owner is process-wide; a previous case's failed scan must not answer this one.
    _resetWorktreeCatalogOwnerForTests()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([])
  })

  // withTimeout also falls back on rejection; absorb real scan failures before they can restore stale rows.
  it('treats a rejected scan as a real answer instead of restoring persisted worktrees', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
  })

  // Why: a `runtime:<env>` repo's files live on the paired host, so a local `git worktree list`
  // answers nothing — exactly the SSH-unreachable shape, owed the same persisted-rows recovery,
  // or the gateway-expansion rows the host already holds never reach worktree.ps (the mobile
  // sidebar source) at all.
  it('keeps persisted worktrees for a runtime-host repo whose local scan cannot describe it', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore supplies only the repo, meta and lineage reads the degraded-scan paths reach; the rest of the store surface is unreached.
      partialRuntimeStore(
        makeStore({
          executionHostId: RUNTIME_HOST_ID,
          metaById: {
            [WORKTREE_ID]: makeMeta({ hostId: RUNTIME_HOST_ID }),
            [MAIN_WORKTREE_ID]: makeMeta({
              displayName: 'main',
              instanceId: 'parent-instance',
              hostId: RUNTIME_HOST_ID
            })
          }
        })
      )
    )

    const result = await runtime.getWorktreePs(10_000)

    const restored = result.worktrees.find((worktree) => worktree.worktreeId === WORKTREE_ID)
    expect(restored?.hostId).toBe(RUNTIME_HOST_ID)
    // Why: no git answered, so a restored row must not claim a branch it cannot have verified.
    expect(restored?.branch).toBe('')
    expect(result.hostScope?.hostIds).toContain(RUNTIME_HOST_ID)
  })

  // Why: worktree.ps resolves through the same fleet scan worktree.list (the desktop sidebar
  // surface) resolves through, so the runtime-host recovery must reach both or the two listings
  // disagree about which rows the host owns.
  it('restores runtime-host rows through the desktop worktree.list path too', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore supplies only the repo, meta and lineage reads the degraded-scan paths reach; the rest of the store surface is unreached.
      partialRuntimeStore(
        makeStore({
          executionHostId: RUNTIME_HOST_ID,
          metaById: {
            [WORKTREE_ID]: makeMeta({ hostId: RUNTIME_HOST_ID }),
            [MAIN_WORKTREE_ID]: makeMeta({
              displayName: 'main',
              instanceId: 'parent-instance',
              hostId: RUNTIME_HOST_ID
            })
          }
        })
      )
    )

    const listed = await runtime.listManagedWorktrees(`id:${REPO_ID}`)

    const restored = listed.worktrees.find((worktree) => worktree.id === WORKTREE_ID)
    expect(restored?.hostId).toBe(RUNTIME_HOST_ID)
  })

  // Why: the catalog owner's route gate (buildRoutes skips non-local repos) means a
  // `runtime:<env>` repo never runs a local scan — the "healthy scan" state cannot occur.
  // Pinned so the recovery above cannot silently regress into a real scan whose empty
  // verdict would starve the listing of the host's certified rows.
  it('answers a runtime-host repo from stored rows without running a local scan', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'local-truth', isBare: false, isMainWorktree: true }
    ])
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore supplies only the repo, meta and lineage reads the degraded-scan paths reach; the rest of the store surface is unreached.
      partialRuntimeStore(
        makeStore({
          executionHostId: RUNTIME_HOST_ID,
          metaById: {
            [WORKTREE_ID]: makeMeta({ hostId: RUNTIME_HOST_ID }),
            [MAIN_WORKTREE_ID]: makeMeta({
              displayName: 'main',
              instanceId: 'parent-instance',
              hostId: RUNTIME_HOST_ID
            })
          }
        })
      )
    )

    const result = await runtime.getWorktreePs(10_000)

    expect(listWorktreesStrictMock).not.toHaveBeenCalled()
    expect(result.worktrees.map((worktree) => worktree.worktreeId).sort()).toEqual(
      [MAIN_WORKTREE_ID, WORKTREE_ID].sort()
    )
  })

  it('lists restored worktrees while a scan is stalled and still hides agent scratch', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(
          makeStore({
            metaById: {
              [WORKTREE_ID]: makeMeta(),
              [SCRATCH_ID]: makeMeta({ displayName: 'scratch' })
            }
          })
        )
      )

      const listed = await advancePastRepoScanBudget(runtime.listManagedWorktrees(`id:${REPO_ID}`))

      const ids = listed.worktrees.map((worktree) => worktree.id)
      expect(ids).toContain(WORKTREE_ID)
      expect(ids).not.toContain(SCRATCH_ID)
    } finally {
      vi.useRealTimers()
    }
  })
})
