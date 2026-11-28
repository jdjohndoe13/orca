import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))
vi.mock('../../browser/routing/partitions/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: vi.fn()
}))
vi.mock('../../browser/routing/partitions/browser-route-partition-storage-retirement', () => ({
  retireBrowserRoutePartitionStorageForEnvironment: vi.fn(async () => undefined)
}))

import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repository/repo-types'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { addEnvironmentFromPairingCode } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { retireRemovedRuntimeEnvironment } from './catalog/runtime-environment-removal-cleanup'
import { engagePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-engraft'
import { retirePairedEnvironmentRepoCatalog } from './runtime-environment-repo-catalog-retire'
import { configurePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-mirror'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'

// The stores below write through the real one.
const CALL_TIMEOUT_MS = 15_000

function rpcOk(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

function repoRow(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-a',
    path: '/srv/prj/app',
    displayName: 'app',
    badgeColor: '#112233',
    addedAt: 500,
    kind: 'git',
    ...overrides
  }
}

function detectedList(worktrees: unknown[], authoritative = true): unknown {
  return { repoId: 'repo-a', authoritative, source: 'metadata-fallback', worktrees }
}

const runtimeInvalidate = vi.fn()
const runtimeNotify = vi.fn()
const runtimeStub = {
  invalidateWorktreeCatalog: runtimeInvalidate,
  notifyFolderWorkspaceChanged: runtimeNotify
}

let store: Store
let userDataPath = ''
const tempDirs: string[] = []

function catalogsByRepoId(
  rows: { id: string; worktrees: unknown[] }[]
): (params: unknown) => unknown {
  const byRepo = new Map(rows.map((row) => [row.id, row.worktrees] as const))
  return (params) => {
    const repo =
      typeof params === 'object' && params !== null && 'repo' in params ? String(params.repo) : ''
    return detectedList(byRepo.get(repo) ?? [])
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-repo-catalog-mirror-'))
  tempDirs.push(userDataPath)
  testState.dir = userDataPath
  store = createStore()
  configurePairedEnvironmentRepoCatalogMirror({
    getStore: () => store,
    getRuntime: () => runtimeStub
  })
})

afterEach(async () => {
  await closeTestStores()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  callRuntimeEnvironmentMock.mockReset()
  runtimeInvalidate.mockReset()
  runtimeNotify.mockReset()
})

async function pairedEnvironment(): Promise<KnownRuntimeEnvironment> {
  return addEnvironmentFromPairingCode(userDataPath, {
    name: 'source box',
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://10.0.0.9:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    })
  })
}

function mirroredRowsFor(environmentId: string): Repo[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return store.getRepos().filter((row) => row.executionHostId === hostId)
}

function metasForHost(environmentId: string): Record<string, unknown> {
  return store.getAllWorktreeMetaForHost?.(toRuntimeExecutionHostId(environmentId)) ?? {}
}

describe('engrafting a paired environment repo catalog', () => {
  it('mirrors repo rows and worktree metas under the environment runtime stamp', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, selectorId: string, method: string, params: unknown) => {
        expect(selectorId).toBe(env.id)
        expect(callRuntimeEnvironmentMock.mock.calls.at(-1)?.[4]).toBe(CALL_TIMEOUT_MS)
        if (method === 'repo.list') {
          expect(params).toEqual({})
          return rpcOk({
            repos: [
              repoRow(),
              repoRow({ id: 'repo-b', path: '/srv/prj/site', displayName: 'site' })
            ]
          })
        }
        return rpcOk(
          catalogsByRepoId([
            { id: 'repo-a', worktrees: [{ path: '/srv/prj/app', displayName: 'app' }] },
            { id: 'repo-b', worktrees: [{ path: '/srv/prj/site', displayName: 'site' }] }
          ])(params)
        )
      }
    )

    const summary = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)

    expect(summary).toEqual({
      reposAdded: 2,
      reposUpdated: 0,
      reposPruned: 0,
      worktreesMirrored: 2,
      worktreesPruned: 0
    })
    const hostId = toRuntimeExecutionHostId(env.id)
    const mirrored = mirroredRowsFor(env.id)
    expect(mirrored.map((row) => [row.id, row.path, row.displayName])).toEqual([
      ['repo-a', '/srv/prj/app', 'app'],
      ['repo-b', '/srv/prj/site', 'site']
    ])
    // A surviving source connectionId would misroute scans to this host's providers.
    for (const row of mirrored) {
      expect(row.connectionId).toBeNull()
    }
    expect(store.getWorktreeMetaForHost('repo-a::/srv/prj/app', hostId)?.displayName).toBe('app')
    expect(store.getWorktreeMetaForHost('repo-b::/srv/prj/site', hostId)?.displayName).toBe('site')
    // Store writes bypass the runtime caches: the catalog must be invalidated.
    expect(runtimeInvalidate.mock.calls.map((call) => call[0]).sort()).toEqual(['repo-a', 'repo-b'])
    expect(runtimeNotify).toHaveBeenCalledTimes(1)
  })

  it('re-syncs in place: source ids survive, renames update, nothing duplicates', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(async () => rpcOk({ repos: [repoRow()] }))
    const first = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(first.reposAdded).toBe(1)

    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string) => {
        if (method === 'repo.list') {
          return rpcOk({ repos: [repoRow({ displayName: 'app renamed' })] })
        }
        // Authoritative and empty: prior metas are pruned.
        return rpcOk(detectedList([], true))
      }
    )
    const second = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)

    expect(second.reposAdded).toBe(0)
    expect(second.reposUpdated).toBe(1)
    expect(second.reposPruned).toBe(0)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)
    expect(store.getRepo('repo-a')?.displayName).toBe('app renamed')
    expect(metasForHost(env.id)).toEqual({})
  })

  it('keeps source-id colliding re-pairings stable instead of rewriting the row', async () => {
    const env = await pairedEnvironment()
    store.addRepo({
      id: 'repo-a',
      path: '/ufs/app-old',
      displayName: 'app',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: toRuntimeExecutionHostId(env.id)
    })
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string) =>
        method === 'repo.list' ? rpcOk({ repos: [repoRow()] }) : rpcOk(detectedList([], true))
    )

    const summary = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)

    // same id on this host but a different path: leave the row rather than rewrite it.
    expect(summary.reposAdded).toBe(0)
    expect(summary.reposUpdated).toBe(0)
    expect(summary.reposPruned).toBe(0)
    expect(store.getRepo('repo-a')).toMatchObject({ path: '/ufs/app-old' })
  })

  it('prunes rows the fresh catalog dropped, keeping other hosts and co-host rows', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string) => {
        if (method === 'repo.list') {
          return rpcOk({ repos: [repoRow()] })
        }
        return rpcOk(detectedList([{ path: '/srv/prj/app', displayName: 'app' }], false))
      }
    )
    // Rows this mirror never owns: one local, one on an ssh host sharing the source id.
    store.addRepo({
      id: 'repo-a',
      path: '/local/app',
      displayName: 'app local',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    })
    store.addRepo({
      id: 'repo-coflags',
      path: '/srv/prj/coflags',
      displayName: 'coflags',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'ssh:target'
    })
    await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)

    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string) =>
        method === 'repo.list'
          ? rpcOk({ repos: [repoRow({ id: 'repo-c', path: '/srv/prj/app-2' })] })
          : rpcOk(detectedList([], true))
    )
    const summary = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)

    expect(summary.reposPruned).toBe(1)
    expect(mirroredRowsFor(env.id).map((row) => row.id)).toEqual(['repo-c'])
    expect(store.getRepo('repo-a')).toMatchObject({ executionHostId: 'local' })
    expect(store.getRepo('repo-coflags')).toMatchObject({ executionHostId: 'ssh:target' })
  })

  it('degrades on a lost or unreadable source: no writes, stored rows keep', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string) => {
        if (method === 'repo.list') {
          return rpcOk({ repos: [repoRow()] })
        }
        return rpcOk(detectedList([{ path: '/srv/prj/app', displayName: 'app' }]))
      }
    )
    await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)

    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-1',
      ok: false,
      error: { code: 'timeout', message: 'gateway unreachable' }
    })
    const refused = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(refused.reposPruned).toBe(0)
    expect(refused.reposAdded).toBe(0)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)

    callRuntimeEnvironmentMock.mockRejectedValue(new Error('connect refused'))
    const failed = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(failed.reposPruned).toBe(0)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)

    callRuntimeEnvironmentMock.mockResolvedValue(rpcOk({ repos: [{ id: 'repo-a' }] }))
    const unreadable = await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(unreadable.reposPruned).toBe(0)
    expect(unreadable.reposAdded).toBe(0)
    expect(mirroredRowsFor(env.id)).toHaveLength(1)
  })

  it('skips ephemeral machines, and dial slots are scoped to the list', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string, params: unknown) => {
        if (method === 'repo.list') {
          return rpcOk({ repos: [repoRow()] })
        }
        return rpcOk(catalogsByRepoId([{ id: 'repo-a', worktrees: [] }])(params))
      }
    )

    const ephemeralEnv = { ...env, id: `${env.id}-vm`, source: 'ephemeral-vm' as const }
    expect(
      (await engagePairedEnvironmentRepoCatalogMirror(userDataPath, ephemeralEnv)).reposAdded
    ).toBe(0)
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()

    await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    const calls = callRuntimeEnvironmentMock.mock.calls
    expect(calls[0]?.[2]).toBe('repo.list')
    expect(calls[1]?.[2]).toBe('worktree.detectedList')
    expect(calls[1]?.[3]).toEqual({ repo: 'repo-a' })
  })

  it('retires only the removed environment mirror under the removal cleanup path', async () => {
    const env = await pairedEnvironment()
    callRuntimeEnvironmentMock.mockImplementation(
      async (_userDataPath, _selectorId: string, method: string, params: unknown) => {
        if (method === 'repo.list') {
          return rpcOk({
            repos: [
              repoRow(),
              repoRow({ id: 'repo-b', path: '/srv/prj/site', displayName: 'site' })
            ]
          })
        }
        return rpcOk(
          catalogsByRepoId([
            { id: 'repo-a', worktrees: [{ path: '/srv/prj/app', displayName: 'app' }] },
            { id: 'repo-b', worktrees: [{ path: '/srv/prj/site', displayName: 'site' }] }
          ])(params)
        )
      }
    )
    await engagePairedEnvironmentRepoCatalogMirror(userDataPath, env)
    expect(mirroredRowsFor(env.id)).toHaveLength(2)
    expect(Object.keys(metasForHost(env.id))).toEqual([
      'repo-a::/srv/prj/app',
      'repo-b::/srv/prj/site'
    ])

    const summary = await retireRemovedRuntimeEnvironment(env.id, vi.fn(), store)

    expect(mirroredRowsFor(env.id)).toEqual([])
    expect(metasForHost(env.id)).toEqual({})
    expect(summary).toBeUndefined()
  })

  it('retires nothing when another host owns every row stamped for the gone pair', async () => {
    const env = await pairedEnvironment()
    store.addRepo({
      id: 'repo-a',
      path: '/srv/prj/app',
      displayName: 'app',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    })

    const summary = await retirePairedEnvironmentRepoCatalog(env.id)

    expect(summary.reposRemoved).toBe(0)
    expect(store.getRepo('repo-a')).toMatchObject({ executionHostId: 'local' })
    expect(runtimeInvalidate).not.toHaveBeenCalled()
  })
})
