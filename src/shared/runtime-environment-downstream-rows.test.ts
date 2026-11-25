import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './remote-runtime/pairing/pairing'
import { getPreferredPairingOffer } from './remote-runtime/host-catalog/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from './remote-runtime/host-store/runtime-environment-store-operations'
import {
  downstreamEnvironmentId,
  pruneDownstreamEnvironmentRows,
  upsertDownstreamEnvironment
} from './runtime-environment-downstream-rows'

function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  pairedDeviceId?: string,
  keyByte = 1
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyByte)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('relay downstream environment rows', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function seededStore() {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode('ws://10.0.0.1:6768'),
      now: 1_000
    })
    return { userDataPath, gateway, offer: getPreferredPairingOffer(gateway) }
  }

  it('upserts a deterministic view row carrying the gateway marker and endpoint', () => {
    const { userDataPath, offer } = seededStore()

    const row = upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box',
      upstreamRuntimeId: 'runtime-web-1',
      offer,
      now: 2_000
    })

    expect(row.id).toBe(downstreamEnvironmentId('env-web-1'))
    expect(row.gatewayEnvironmentId).toBe('env-web-1')
    expect(row.runtimeId).toBe('runtime-web-1')
    expect(row.source).toBeUndefined()
    expect(row.endpoints.some((endpoint) => endpoint.endpoint === offer.endpoint)).toBe(true)
    expect(listEnvironments(userDataPath)).toHaveLength(2)
  })

  it('re-upserts update instead of duplicating and preserves learned identity and revisions', () => {
    const { userDataPath, offer } = seededStore()
    const id = downstreamEnvironmentId('env-web-1')

    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box',
      upstreamRuntimeId: 'runtime-web-1',
      offer,
      now: 2_000
    })
    markEnvironmentUsed(userDataPath, id, { runtimeId: 'runtime-web-actual', now: 3_000 })
    const learned = listEnvironments(userDataPath).find((entry) => entry.id === id)
    expect(learned).toMatchObject({ runtimeId: 'runtime-web-actual' })

    const reupserted = upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box',
      upstreamRuntimeId: null,
      offer,
      now: 4_000
    })
    expect(reupserted.runtimeId).toBe('runtime-web-actual')
    expect(reupserted.createdAt).toBe(learned!.createdAt)
    expect(listEnvironments(userDataPath)).toHaveLength(2)
  })

  it('keeps a runtimeId learned live from relay envelopes over the census copy', () => {
    const { userDataPath, offer } = seededStore()
    const id = downstreamEnvironmentId('env-web-1')

    const first = upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box (v1)',
      upstreamRuntimeId: 'runtime-web-seed',
      offer
    })
    expect(first.runtimeId).toBe('runtime-web-seed')
    markEnvironmentUsed(userDataPath, id, { runtimeId: 'runtime-web-live', now: 3_000 })

    const renamed = upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box',
      upstreamRuntimeId: 'runtime-web-stale-census',
      offer
    })
    expect(renamed.runtimeId).toBe('runtime-web-live')
    expect(renamed.name).toBe('gateway box → web box')
    expect(listEnvironments(userDataPath).find((entry) => entry.id === id)!.name).toBe(
      'gateway box → web box'
    )
  })

  it('prunes only this gateway route stale rows and reports how many went', () => {
    const { userDataPath, gateway, offer } = seededStore()
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-1',
      name: 'gateway box → web box',
      upstreamRuntimeId: null,
      offer
    })
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-db-1',
      name: 'gateway box → db box',
      upstreamRuntimeId: null,
      offer
    })
    const otherGateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'other gateway',
      pairingCode: pairingCode('ws://10.0.0.2:6768', undefined, 2),
      now: 5_000
    })
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: 'env-web-9',
      name: 'other gateway → ninth box',
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(otherGateway)
    })

    const pruned = pruneDownstreamEnvironmentRows(userDataPath, {
      gatewayEndpoint: offer.endpoint,
      keepGatewayEnvironmentIds: new Set(['env-web-1'])
    })

    expect(pruned).toBe(1)
    const remainingIds = listEnvironments(userDataPath).map((entry) => entry.id)
    expect(remainingIds).toContain(downstreamEnvironmentId('env-web-1'))
    expect(remainingIds).toContain(downstreamEnvironmentId('env-web-9'))
    expect(remainingIds).toContain(gateway.id)
    expect(remainingIds).not.toContain(downstreamEnvironmentId('env-db-1'))
  })
})
