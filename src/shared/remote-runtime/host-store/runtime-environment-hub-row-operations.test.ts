import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store-operations'
import { writeEnvironmentStore } from './runtime-environment-store-file'
import { createEnvironmentFromPairingOffer } from '../host-catalog/runtime-environments'
import {
  removeHubEnvironmentsForHub,
  syncHubEnvironments
} from './runtime-environment-hub-row-operations'
import { encodePairingOffer } from '../pairing/pairing'
import type { HubInstanceRow } from '../hub/hub-instance-rows'

const HUB_URL = 'wss://hub.example.com:6770'
const ACCESS_KEY = 'access-key'

function key(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64')
}

function instance(sequence: number, name = `Box ${sequence}`): HubInstanceRow {
  return {
    instanceId: `inst-${sequence}`,
    name,
    publicKeyB64: key(sequence),
    ports: [],
    capabilities: [],
    bridgePath: `/v1/bridge/inst-${sequence}`
  }
}

function pairingCode(sequence: number): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://10.0.0.5:6768',
    deviceToken: 'device-token',
    publicKeyB64: key(200 + sequence)
  })
}

describe('hub environment row sync', () => {
  const tempDirs: string[] = []
  const userData = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hub-rows-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('saves one row per listed instance', () => {
    const dir = userData()
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1), instance(2)],
      now: 1000
    })
    expect(result).toEqual({ upserted: 2, removed: 0, skipped: [] })
    const environments = listEnvironments(dir)
    expect(environments.map((entry) => entry.id)).toEqual(['hub-inst-1', 'hub-inst-2'])
    expect(environments[0]?.source).toBe('hub')
    expect(environments[0]?.endpoints[0]?.endpoint).toBe(
      'wss://hub.example.com:6770/v1/bridge/inst-1'
    )
    expect(environments[0]?.endpoints[0]?.deviceToken).toBe(ACCESS_KEY)
  })

  it('is idempotent: the same list writes nothing', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    const before = listEnvironments(dir)
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 2000
    })
    expect(result).toEqual({ upserted: 0, removed: 0, skipped: [] })
    expect(listEnvironments(dir)).toEqual(before)
  })

  it('removes a row the hub no longer lists and keeps the rest', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1), instance(2)],
      now: 1000
    })
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(2)],
      now: 2000
    })
    expect(result).toEqual({ upserted: 0, removed: 1, skipped: [] })
    expect(listEnvironments(dir).map((entry) => entry.id)).toEqual(['hub-inst-2'])
  })

  it('refreshes the pairing when the hub rotates the access key', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    const before = listEnvironments(dir)[0]!
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: 'rotated-key',
      instances: [instance(1)],
      now: 2000
    })
    const after = listEnvironments(dir)[0]!
    expect(after.endpoints[0]?.deviceToken).toBe('rotated-key')
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt).toBe(2000)
    expect((after.pairingRevision ?? 0) > (before.pairingRevision ?? 0)).toBe(true)
  })

  it('refuses to overwrite a non-hub row that already holds the derived id', () => {
    const dir = userData()
    // A pairing saved by a user (or a newer build) can own the id this build would derive.
    writeEnvironmentStore(dir, {
      version: 1,
      environments: [
        createEnvironmentFromPairingOffer({
          id: 'hub-inst-1',
          name: 'Mine',
          now: 800,
          offer: {
            v: 2,
            endpoint: 'ws://10.0.0.9:6768',
            deviceToken: 'mine',
            publicKeyB64: key(210)
          }
        })
      ]
    })
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    expect(result).toEqual({ upserted: 0, removed: 0, skipped: ['inst-1'] })
    const [only] = listEnvironments(dir)
    expect(only?.source).toBeUndefined()
    expect(only?.endpoints[0]?.endpoint).toBe('ws://10.0.0.9:6768')
  })

  it('skips an instance whose name a different server already answers to', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1, 'First')],
      now: 1000
    })
    addEnvironmentFromPairingCode(dir, { name: 'Second', pairingCode: pairingCode(2), now: 1100 })
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1, 'First'), instance(2, 'Second')],
      now: 2000
    })
    expect(result.skipped).toEqual(['inst-2'])
    expect(listEnvironments(dir).map((entry) => entry.name)).toEqual(['First', 'Second'])
  })

  it('leaves a hub it did not create alone', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: 'wss://other.example.com',
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    const result = syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [],
      now: 2000
    })
    expect(result).toEqual({ upserted: 0, removed: 0, skipped: [] })
    expect(listEnvironments(dir)).toHaveLength(1)
  })

  it('removes its rows when the link is removed', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1), instance(2)],
      now: 1000
    })
    expect(removeHubEnvironmentsForHub(dir, HUB_URL)).toEqual({ removed: 2 })
    expect(listEnvironments(dir)).toEqual([])
  })

  it('refuses a user removing a derived row', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    expect(() => removeEnvironment(dir, 'hub-inst-1')).toThrow(/listed by a hub/)
    expect(listEnvironments(dir)).toHaveLength(1)
  })

  it('refuses a user re-pairing a derived row', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: HUB_URL,
      accessKey: ACCESS_KEY,
      instances: [instance(1)],
      now: 1000
    })
    expect(() =>
      updateEnvironmentFromPairingCode(dir, 'hub-inst-1', {
        pairingCode: pairingCode(3),
        now: 2000
      })
    ).toThrow(/listed by a hub/)
    expect(listEnvironments(dir)[0]?.endpoints[0]?.deviceToken).toBe(ACCESS_KEY)
  })
})
