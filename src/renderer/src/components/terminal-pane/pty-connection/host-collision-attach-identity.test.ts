import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRepo, makeWorktree } from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { runDeferredSessionReattachChoice } from './reattach/deferred-session-reattach-choice'

// Reproduction (STA-4343, black panel): the two rows of a contested id hold the SAME mirrored
// tab id, and the pane's attach reads resolved that id from the BARE worktree key — the active
// host's row is under `host|id`, so the read missed the live row and the attach went to the
// rival host's dead `remote:` pty (or the shared tab-id-keyed layout's stale leaf binding).
// These tests pin that the remounted pane attaches to the ACTIVE row's ptyId, and that the
// layout's leaf binding is reconciled against the row it vouches for.

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`
const LOCAL_HOST = 'local'
const SSH_HOST = 'ssh:paired-box'
const localKey = `${LOCAL_HOST}|${CONTESTED_ID}`
const sshKey = `${SSH_HOST}|${CONTESTED_ID}`

// The collision itself: one mirrored tab id, both hosts' own `remote:` pty (the live profile shape).
const TAB_ID = 'web-terminal-c1a8b7e4-7f90-4e52-9dcc-8cdaeec20495'
const LEAF_ID = 'leaf-1'
const LOCAL_PTY = 'remote:525d@@term_196e'
const SSH_PTY = 'remote:644f@@term_719f'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, startDeferredSessionReattach: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('../pty-transport/delivery/pty-dispatcher', () => ({
  getEagerPtyBufferHandle: () => null
}))
vi.mock('./spawn/hidden-agent-resume-deferral', () => ({
  startDeferredSessionReattachUnlessHiddenAgentResume: mocks.startDeferredSessionReattach
}))

/** One repo path published by two hosts — the contested gate the row key resolves through. */
function catalog(): Record<string, unknown> {
  return {
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: LOCAL_HOST, path: 'C:\\vmd' }),
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: SSH_HOST, path: 'C:\\vmd' }),
        makeWorktree(UNCONTESTED_ID, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })
      ]
    }
  }
}

function setStore(args: {
  activeWorktreeId: string
  activeHost: string
  rows: Record<string, { id: string; ptyId: string }[]>
}): void {
  mocks.state = {
    ...catalog(),
    tabsByWorktree: args.rows,
    ptyIdsByTabId: { [TAB_ID]: [] },
    sleepingAgentSessionsByPaneKey: {},
    runtimeStatusByEnvironmentId: new Map(),
    activeWorktreeId: args.activeWorktreeId,
    activeWorkspaceExecutionHostId: args.activeHost
  }
}

function contestedRows(): Record<string, { id: string; ptyId: string }[]> {
  return {
    [localKey]: [{ id: TAB_ID, ptyId: LOCAL_PTY }],
    [sshKey]: [{ id: TAB_ID, ptyId: SSH_PTY }]
  }
}

function buildSession(args: {
  tabId?: string
  worktreeId?: string
  // The pane's `savedLayout` leaf binding — the tab-id-keyed record the two rows share, so it
  // can still name the PREVIOUS host's leaf during the frame window after a host flip.
  layoutLeafPtyId: string
  restoredLeafId?: string
}): ConnectPanePtySession {
  const tabId = args.tabId ?? TAB_ID
  const paneKey = `${tabId}:${LEAF_ID}`
  let attachedPtyId: string | null = null
  const transport = {
    attach: vi.fn((opts: { existingPtyId: string }) => {
      attachedPtyId = opts.existingPtyId
    }),
    getPtyId: () => attachedPtyId
  }
  const session = {
    pane: { id: 1, leafId: LEAF_ID },
    cacheKey: paneKey,
    pendingSpawnKey: paneKey,
    tabGeneration: 0,
    transport,
    cols: 80,
    rows: 24,
    disposed: false,
    hadExistingPaneTransportAtConnect: false,
    mountFollowsTerminalPark: false,
    runtimeEnvironmentId: null,
    connectionId: null,
    allowInitialIdleCacheSeed: true,
    deps: {
      tabId,
      worktreeId: args.worktreeId ?? CONTESTED_ID,
      restoredLeafId: args.restoredLeafId ?? LEAF_ID,
      restoredPtyIdByLeafId: { [LEAF_ID]: args.layoutLeafPtyId },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    getSleepingRecordForPane: () => null,
    buildColdRestoreAgentResumeStartup: vi.fn(() => ({ command: 'resume' })),
    syncPanePtyLayoutBinding: vi.fn(),
    clearPaneMode2031State: vi.fn(),
    clearHiddenOutputRestoreState: vi.fn(),
    captureTransportOutputCallbacks: vi.fn(() => ({ callbacks: {}, generation: 0 })),
    bindActivePanePty: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    reportError: vi.fn(),
    startFreshSpawn: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    armDirectSshPaneRetryTimeout: vi.fn(),
    canAdoptCapturedDirectSshRetryPty: vi.fn(() => true)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bag covers every member runDeferredSessionReattachChoice reads.
  return session as unknown as ConnectPanePtySession
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('host-colliding attach identity (contested row)', () => {
  it('attaches the ACTIVE row when the layout leaf still names the rival host', () => {
    setStore({ activeWorktreeId: CONTESTED_ID, activeHost: SSH_HOST, rows: contestedRows() })
    // The shared layout record is the stale one: it names the local host's PTY while the
    // user is looking at the ssh host's card.
    const session = buildSession({ layoutLeafPtyId: LOCAL_PTY })
    runDeferredSessionReattachChoice(session)
    expect(session.transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: SSH_PTY })
    )
    expect(session.startFreshSpawn).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(null)
  })

  it('follows the host flip: the local row wins when the layout names the ssh host', () => {
    setStore({ activeWorktreeId: CONTESTED_ID, activeHost: LOCAL_HOST, rows: contestedRows() })
    const session = buildSession({ layoutLeafPtyId: SSH_PTY })
    runDeferredSessionReattachChoice(session)
    expect(session.transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: LOCAL_PTY })
    )
    expect(session.startFreshSpawn).not.toHaveBeenCalled()
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
  })

  it('attaches the row pty when the layout record is empty', () => {
    setStore({ activeWorktreeId: CONTESTED_ID, activeHost: SSH_HOST, rows: contestedRows() })
    // The leaf lookup misses, so the row's own host-scoped ptyId is the only candidate.
    const session = buildSession({ layoutLeafPtyId: 'no-such-leaf', restoredLeafId: 'other-leaf' })
    runDeferredSessionReattachChoice(session)
    expect(session.transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: SSH_PTY })
    )
  })
})

describe('host-colliding attach identity (uncontested control)', () => {
  it('keeps the bare-key reads byte-identical for a single-host workspace', () => {
    const bareId = 'tab-bare'
    const barePty = 'pty-bare'
    mocks.state = {
      ...catalog(),
      tabsByWorktree: { [UNCONTESTED_ID]: [{ id: bareId, ptyId: barePty }] },
      ptyIdsByTabId: { [bareId]: [] },
      sleepingAgentSessionsByPaneKey: {},
      runtimeStatusByEnvironmentId: new Map(),
      activeWorktreeId: UNCONTESTED_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    }
    const session = buildSession({
      tabId: bareId,
      worktreeId: UNCONTESTED_ID,
      layoutLeafPtyId: barePty
    })
    runDeferredSessionReattachChoice(session)
    // A local handle on an uncontested id takes the deferred-reattach path it always took —
    // the row key resolves to the bare id, so the read is the pre-contention read.
    expect(mocks.startDeferredSessionReattach).toHaveBeenCalledWith(session, barePty)
    expect(session.transport.attach).not.toHaveBeenCalled()
  })
})
