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

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import {
  readEnvironmentStore,
  writeEnvironmentStore
} from '../../../shared/remote-runtime/host-store/runtime-environment-store-file'
import { markRuntimeEnvironmentManuallyDisconnected } from './connectivity/runtime-environment-manual-disconnect'
import { configurePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-mirror'
import {
  engageAllPairedEnvironmentRepoCatalogMirrors,
  engageOnEnvironmentConnected
} from './runtime-environment-repo-catalog-triggers'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'

const CATALOG_ROW = {
  id: 'repo-a',
  path: '/srv/prj/app',
  displayName: 'app',
  badgeColor: '#112233',
  addedAt: 500,
  kind: 'git' as const
}

function rpcOk(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

function serveCatalog(): void {
  callRuntimeEnvironmentMock.mockImplementation(async (_userDataPath, _selectorId, method) => {
    if (method === 'repo.list') {
      return rpcOk({ repos: [CATALOG_ROW] })
    }
    return rpcOk({
      repoId: CATALOG_ROW.id,
      authoritative: true,
      source: 'metadata-fallback',
      worktrees: [{ path: CATALOG_ROW.path, displayName: 'app', ownership: 'orca-managed' }]
    })
  })
}

// The host key is derived from the endpoint so every fixture endpoint is a distinct server:
// the store refuses duplicate host keys, and these tests dial several paired hosts at once.
function pairingCode(endpoint = 'ws://10.0.0.9:6768'): string {
  const keyByte = Number(endpoint.match(/(\d+)\.(\d+)\.(\d+)\.(\d+):/)?.[4] ?? 1)
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyByte)).toString('base64')
  })
}

function dial(method: string): string[] {
  return callRuntimeEnvironmentMock.mock.calls
    .filter((call) => call[2] === method)
    .map((call) => String(call[1]))
}

let store: Awaited<ReturnType<typeof createStore>>
let userDataPath = ''
const tempDirs: string[] = []

beforeEach(() => {
  callRuntimeEnvironmentMock.mockReset()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-repo-catalog-triggers-'))
  tempDirs.push(userDataPath)
  testState.dir = userDataPath
  store = createStore()
  configurePairedEnvironmentRepoCatalogMirror({ getStore: () => store })
  serveCatalog()
})

afterEach(async () => {
  await closeTestStores()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  callRuntimeEnvironmentMock.mockReset()
})

describe('paired repo catalog mirror triggers', () => {
  it('boot engages directly paired rows only, skipping relay views and ephemeral rows', async () => {
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode()
    })
    const ephemeral = addEnvironmentFromPairingCode(userDataPath, {
      name: 'vm',
      pairingCode: pairingCode('ws://10.0.0.10:6768'),
      source: 'ephemeral-vm'
    })
    const relayed = addEnvironmentFromPairingCode(userDataPath, {
      name: 'relay view',
      pairingCode: pairingCode('ws://10.0.0.11:6768')
    })
    const stored = readEnvironmentStore(userDataPath)
    writeEnvironmentStore(userDataPath, {
      version: 1,
      environments: stored.environments.map((entry) =>
        entry.id === relayed.id ? { ...entry, gatewayEnvironmentId: 'gateway-1' } : entry
      )
    })

    engageAllPairedEnvironmentRepoCatalogMirrors(userDataPath)
    await vi.waitFor(() => {
      expect(dial('repo.list')).toEqual([paired.id])
    })

    expect(dial('repo.list')).not.toContain(ephemeral.id)
    expect(dial('repo.list')).not.toContain(relayed.id)
  })

  it('boot piggybacks an engage already in flight instead of re-dialing the pair', async () => {
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode()
    })
    let releaseRepoList: () => void = () => undefined
    callRuntimeEnvironmentMock.mockImplementation((_userDataPath, _selectorId, method) => {
      if (method === 'repo.list') {
        return new Promise((resolve) => {
          releaseRepoList = () => resolve(rpcOk({ repos: [CATALOG_ROW] }))
        })
      }
      return rpcOk({
        repoId: CATALOG_ROW.id,
        authoritative: true,
        source: 'metadata-fallback',
        worktrees: []
      })
    })

    engageAllPairedEnvironmentRepoCatalogMirrors(userDataPath)
    await vi.waitFor(() => {
      expect(dial('repo.list')).toEqual([paired.id])
    })
    engageAllPairedEnvironmentRepoCatalogMirrors(userDataPath)
    releaseRepoList()
    await vi.waitFor(() => {
      // The second boot pass must not add repo.list or detectedList dials.
      expect(dial('repo.list')).toHaveLength(1)
      expect(dial('worktree.detectedList')).toHaveLength(1)
    })
  })

  it('connect time engages only the environment whose connection was just re-established', async () => {
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode()
    })
    const other = addEnvironmentFromPairingCode(userDataPath, {
      name: 'other',
      pairingCode: pairingCode('ws://10.0.0.12:6768')
    })
    const disconnected = addEnvironmentFromPairingCode(userDataPath, {
      name: 'marked off',
      pairingCode: pairingCode('ws://10.0.0.13:6768')
    })
    markRuntimeEnvironmentManuallyDisconnected(disconnected.id)
    const relayed = addEnvironmentFromPairingCode(userDataPath, {
      name: 'relay view',
      pairingCode: pairingCode('ws://10.0.0.11:6768')
    })
    const stored = readEnvironmentStore(userDataPath)
    writeEnvironmentStore(userDataPath, {
      version: 1,
      environments: stored.environments.map((entry) =>
        entry.id === relayed.id ? { ...entry, gatewayEnvironmentId: 'gateway-1' } : entry
      )
    })

    engageOnEnvironmentConnected(userDataPath, resolveEnvironment(userDataPath, paired.id))
    await vi.waitFor(() => {
      expect(dial('repo.list')).toEqual([paired.id])
    })

    // The refused candidates are rejected synchronously by the mirror gate, so they
    // can never add a dial; wait on the accepted engage's own second dial instead of
    // a fixed settle.
    engageOnEnvironmentConnected(userDataPath, resolveEnvironment(userDataPath, disconnected.id))
    engageOnEnvironmentConnected(userDataPath, resolveEnvironment(userDataPath, relayed.id))
    await vi.waitFor(() => {
      expect(dial('worktree.detectedList')).toHaveLength(1)
    })
    expect(dial('repo.list')).toEqual([paired.id])
    expect(dial('repo.list')).not.toContain(other.id)
  })
})
