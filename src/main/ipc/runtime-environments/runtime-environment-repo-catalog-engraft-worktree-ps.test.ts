import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The runtime reaches window registry surfaces that a headless test never has.
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
vi.mock('electron', () => electronMocks)

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import type { Repo } from '../../../shared/repository/repo-types'
import { addEnvironmentFromPairingCode } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { engagePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-engraft'
import { configurePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-mirror'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'

// The store writes harden Windows ACLs outside the sandbox: pin the platform.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

const REPO_ID = 'repo-a'
const REPO_PATH = '/srv/prj/app'
const FEATURE_PATH = '/srv/prj/app.BranchFeature'
const FEATURE_ID = `${REPO_ID}::${FEATURE_PATH}`

function rpcOk(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

let store: Awaited<ReturnType<typeof createStore>>
let runtime: OrcaRuntimeService | null = null
const tempDirs: string[] = []
let userDataPath = ''

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  callRuntimeEnvironmentMock.mockReset()
  listWorktreesStrictMock.mockReset()
  listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-repo-catalog-mirror-ps-'))
  tempDirs.push(userDataPath)
  testState.dir = userDataPath
  store = createStore()
  configurePairedEnvironmentRepoCatalogMirror({
    getStore: () => store,
    getRuntime: () => runtime
  })
})

afterEach(async () => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  await closeTestStores()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  runtime = null
  callRuntimeEnvironmentMock.mockReset()
  listWorktreesStrictMock.mockReset()
})

describe('paired catalog mirror payloads reach worktree.ps (mobile shape)', () => {
  it('serves the engrafted rows when the paired machine has no local git scan', async () => {
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'source box',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://10.0.0.9:6768',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
      })
    })
    const mirrored: Repo = {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'app',
      badgeColor: '#112233',
      addedAt: 500,
      kind: 'git'
    }
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, selectorId: string, method: string, params: unknown) => {
        expect(selectorId).toBe(env.id)
        if (method === 'repo.list') {
          return rpcOk({ repos: [mirrored] })
        }
        expect(params).toEqual({ repo: REPO_ID })
        return rpcOk({
          repoId: REPO_ID,
          authoritative: true,
          source: 'git',
          worktrees: [
            { path: REPO_PATH, displayName: 'app', ownership: 'orca-managed' },
            { path: FEATURE_PATH, displayName: 'item-branch', ownership: 'orca-managed' }
          ]
        })
      }
    )

    const summary = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(summary.reposAdded).toBe(1)
    expect(mirroredRowsInStoreFor(env.id)).toHaveLength(1)

    runtime = new OrcaRuntimeService(store)

    const result = await runtime.getWorktreePs(10_000)

    const restored = result.worktrees.find((worktree) => worktree.worktreeId === FEATURE_ID)
    expect(restored?.hostId).toBe(toRuntimeExecutionHostId(env.id))
    // Why: no git answered on this machine, so a restored row proves it from the
    // mirror's metadata, not from a local branch read.
    expect(restored?.displayName).toBe('item-branch')
    const suppliedRepo = store.getRepo(REPO_ID)
    expect(suppliedRepo?.id).toBe(REPO_ID)
    expect(result.hostScope?.hostIds).toContain(toRuntimeExecutionHostId(env.id))
  })
})

function mirroredRowsInStoreFor(environmentId: string): Repo[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return store.getRepos().filter((row) => row.executionHostId === hostId)
}
