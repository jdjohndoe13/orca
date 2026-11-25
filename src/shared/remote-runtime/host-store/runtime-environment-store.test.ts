import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { getPreferredPairingOffer } from '../host-catalog/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from './runtime-environment-store-operations'
import {
  RuntimeEnvironmentStoreError,
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
} from './runtime-environment-store-records'

function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  pairedDeviceId?: string,
  keyFill = 1
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyFill)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('runtime environment store', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('backs up a NUL-filled store when a server is saved over it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-nul-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))

    // Plain reads stay fail-closed: an empty answer would read as "every server was removed".
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    // A save that fails must leave the blank file, not an empty registry, behind.
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode()
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    const added = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    expect(listEnvironments(userDataPath)).toEqual([added])
    const backups = readdirSync(userDataPath).filter((name) =>
      name.startsWith('orca-environments.json.corrupt-')
    )
    // The rejected save above left no copy; only the save that replaced the file did.
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(userDataPath, backups[0]))).toEqual(Buffer.alloc(640))
  })

  it.each([
    ['a newer format', '{"version":2,"environments":[]}'],
    ['truncated JSON that may still hold servers', '{"version":1,"environments":[{"id":"a"']
  ])('does not overwrite %s when a server is saved', (_label, contents) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-invalid-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), contents)

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode: pairingCode() })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(readdirSync(userDataPath)).toEqual(['orca-environments.json'])
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(contents)
  })
})

describe('runtime environment store source vocabulary', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
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

  it('degrades a source arm this build does not know instead of rejecting the store', () => {
    const { userDataPath } = seededStore()
    writeFileSync(
      getEnvironmentStorePath(userDataPath),
      JSON.stringify({
        version: 1,
        environments: [
          {
            id: 'env-gateway',
            name: 'gateway box',
            createdAt: 1_000,
            updatedAt: 1_000,
            lastUsedAt: null,
            runtimeId: null,
            // A future build's arm: openEnum must degrade it, not reject the file.
            source: 'x-runtime-v2-runner',
            endpoints: [
              {
                id: 'ws-env-gateway',
                kind: 'websocket',
                label: 'WebSocket',
                endpoint: 'ws://10.0.0.1:6768',
                deviceToken: 'device-token',
                publicKeyB64: 'A'.repeat(43)
              }
            ],
            preferredEndpointId: 'ws-env-gateway'
          }
        ]
      })
    )

    const [loaded] = listEnvironments(userDataPath)
    expect(loaded!.name).toBe('gateway box')
    expect(loaded!.source).toBe('manual')
  })
})
