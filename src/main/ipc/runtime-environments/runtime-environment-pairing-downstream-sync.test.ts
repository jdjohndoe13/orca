import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { upsertDownstreamEnvironment } from '../../../shared/runtime-environment-downstream-rows'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { synchronizeDownstreamEnvironmentRows } from './runtime-environment-pairing-downstream-sync'

function pairingCode(endpoint = 'ws://10.0.0.1:6768', keyByte = 1): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyByte)).toString('base64')
  })
}

type DownstreamRow = {
  gatewayEnvironmentId: string | null
  name: string
  upstreamRuntimeId: string | null
  state: 'connected' | 'unreachable' | 'unknown'
  capabilities: string[] | null
}

const RELAY_CAPABILITY = 'remote-runtime.relay.v1'

function censusResult(rows: DownstreamRow[]) {
  return {
    id: 'rpc-census',
    ok: true,
    result: { environments: rows },
    _meta: { runtimeId: 'runtime-gateway' }
  }
}

describe('synchronizeDownstreamEnvironmentRows', () => {
  const tempDirs: string[] = []
  let userDataPath = ''
  let gateway: KnownRuntimeEnvironment | undefined

  beforeEach(() => {
    callRuntimeEnvironmentMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-downstream-sync-'))
    tempDirs.push(userDataPath)
    gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode()
    })
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    callRuntimeEnvironmentMock.mockReset()
  })

  function rowNames(): string[] {
    return listEnvironments(userDataPath)
      .filter((entry) => entry.gatewayEnvironmentId)
      .map((entry) => entry.name)
  }

  it('mirrors the census into durable view rows and names them after the route', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(
      censusResult([
        {
          gatewayEnvironmentId: null,
          name: 'local',
          upstreamRuntimeId: 'runtime-gateway',
          state: 'connected',
          capabilities: []
        },
        {
          gatewayEnvironmentId: 'env-web',
          name: 'web box',
          upstreamRuntimeId: 'runtime-web',
          state: 'connected',
          capabilities: []
        },
        {
          gatewayEnvironmentId: 'env-db',
          name: 'db box',
          upstreamRuntimeId: null,
          state: 'unknown',
          capabilities: null
        }
      ])
    )

    const summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })

    expect(callRuntimeEnvironmentMock.mock.calls[0]!.slice(0, 5)).toEqual([
      userDataPath,
      gateway!.id,
      'runtimeEnvironment.downstream.list',
      {},
      15_000
    ])
    expect(summary).toEqual({ created: 2, updated: 0, pruned: 0 })
    expect(rowNames()).toEqual(['gateway box → db box', 'gateway box → web box'])
    const web = listEnvironments(userDataPath).find(
      (entry) => entry.gatewayEnvironmentId === 'env-web'
    )
    expect(web).toMatchObject({ runtimeId: 'runtime-web' })
  })

  it('prunes census rows this gateway no longer lists, keeping rows of other routes', async () => {
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-stale',
      name: 'gateway box → stale box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway!)
    })
    const otherGateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'other gateway',
      pairingCode: pairingCode('ws://10.0.0.2:6768', 2)
    })
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-other',
      name: 'other gateway → ninth box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(otherGateway)
    })
    callRuntimeEnvironmentMock.mockResolvedValue(
      censusResult([
        {
          gatewayEnvironmentId: 'env-web',
          name: 'web box',
          upstreamRuntimeId: 'runtime-web',
          state: 'connected',
          capabilities: []
        }
      ])
    )

    const summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })

    expect(summary).toEqual({ created: 1, updated: 0, pruned: 1 })
    expect(rowNames()).toEqual(['gateway box → web box', 'other gateway → ninth box'])
  })

  it('prunes this route when the gateway cannot census (capability absent)', async () => {
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-old',
      name: 'gateway box → old box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway!)
    })

    const summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: []
    })

    expect(summary).toEqual({ created: 0, updated: 0, pruned: 1 })
    expect(rowNames()).toEqual([])
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('prunes this route when the census became method_not_found despite the capability', async () => {
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-old',
      name: 'gateway box → old box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway!)
    })
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-census',
      ok: false,
      error: { code: 'method_not_found', message: 'unknown method' },
      _meta: { runtimeId: 'runtime-gateway' }
    })

    const summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })

    expect(summary).toEqual({ created: 0, updated: 0, pruned: 1 })
    expect(rowNames()).toEqual([])
  })

  it('keeps learned rows over transient gateway refusals and dial failures', async () => {
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-old',
      name: 'gateway box → old box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway!)
    })

    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-census',
      ok: false,
      error: { code: 'forbidden', message: 'relay scope refused' },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    let summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })
    expect(summary).toEqual({ created: 0, updated: 0, pruned: 0 })
    expect(rowNames()).toEqual(['gateway box → old box'])

    callRuntimeEnvironmentMock.mockRejectedValue(new Error('gateway unreachable'))
    summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })
    expect(summary).toEqual({ created: 0, updated: 0, pruned: 0 })
    expect(rowNames()).toEqual(['gateway box → old box'])
  })

  it('keeps learned rows when the census result is unreadable', async () => {
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-old',
      name: 'gateway box → old box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway!)
    })
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-census',
      ok: true,
      result: { environments: [{ gatewayEnvironmentId: 42 }] },
      _meta: { runtimeId: 'runtime-gateway' }
    })

    const summary = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })

    expect(summary).toEqual({ created: 0, updated: 0, pruned: 0 })
    expect(rowNames()).toEqual(['gateway box → old box'])
  })

  it('re-syncs idempotently: rows update in place instead of duplicating', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(
      censusResult([
        {
          gatewayEnvironmentId: 'env-web',
          name: 'web box',
          upstreamRuntimeId: 'runtime-web',
          state: 'connected',
          capabilities: []
        }
      ])
    )

    const first = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })
    expect(first).toEqual({ created: 1, updated: 0, pruned: 0 })

    const second = await synchronizeDownstreamEnvironmentRows({
      userDataPath,
      gateway: gateway!,
      capabilities: [RELAY_CAPABILITY]
    })
    expect(second).toEqual({ created: 0, updated: 1, pruned: 0 })
    expect(rowNames()).toEqual(['gateway box → web box'])
  })
})
