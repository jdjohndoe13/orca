// Fork extension: "accept any access key" LAN mode. The registry authenticates any token as
// the synthetic open-access principal while the mode file says on, and never persists it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { openAccessModePath, readOpenAccessMode, writeOpenAccessMode } from './open-access-mode'
import {
  OPEN_ACCESS_DEVICE_ID,
  OPEN_ACCESS_DEVICE_NAME,
  OPEN_ACCESS_MODE_FILENAME
} from '../../../../../shared/remote-runtime/open-access/open-access'
import { devicePrincipalOf } from './device-principal'
import { PairingTicketExchangeError } from './pairing-ticket-exchange'

let dir: string
let modePath: string
const ANY_TOKEN = 'f'.repeat(48)

function enableOpenAccess(): void {
  writeOpenAccessMode(dir, { acceptAnyAccessKey: true })
}

function registryWithMode(): DeviceRegistry {
  return new DeviceRegistry(dir, openAccessModePath(dir))
}

function readRegistryFile(): { deviceId: string }[] {
  try {
    return JSON.parse(readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf-8')) as {
      deviceId: string
    }[]
  } catch {
    return []
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-open-access-'))
  modePath = join(dir, OPEN_ACCESS_MODE_FILENAME)
})

afterEach(async () => {
  // Why the retry: the secure-file writer propagates the directory DACL asynchronously
  // (restrictWindowsDirectory), and the addon holds a handle to the temp dir while it
  // walks; rmSync hits EPERM until that finishes. The DACL itself grants the user full
  // control, so a short retry is all this Windows race needs.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10 || !isPermissionDenied(error)) {
        throw error
      }
      await delay(50)
    }
  }
})

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

describe('open-access mode', () => {
  it('accepts an arbitrary token when the mode file says on', () => {
    enableOpenAccess()
    const registry = registryWithMode()
    const device = registry.validateToken(ANY_TOKEN)
    expect(device).toMatchObject({
      deviceId: OPEN_ACCESS_DEVICE_ID,
      name: OPEN_ACCESS_DEVICE_NAME,
      token: ANY_TOKEN,
      scope: 'runtime'
    })
    // No offer expiry, no ticket, no credential kind: the synthetic row is a bare principal.
    expect(device?.offerExpiresAt).toBeUndefined()
    expect(device?.ticket).toBeUndefined()
    expect(device?.credentialKind).toBeUndefined()
  })

  it('refuses an arbitrary token when the mode is off or the file is missing', () => {
    expect(new DeviceRegistry(dir).validateToken(ANY_TOKEN)).toBeNull()
    writeOpenAccessMode(dir, { acceptAnyAccessKey: false })
    expect(registryWithMode().validateToken(ANY_TOKEN)).toBeNull()
    writeFileSync(modePath, 'not json at all')
    expect(registryWithMode().validateToken(ANY_TOKEN)).toBeNull()
  })

  it('keeps a registry token authenticating while the mode is on', () => {
    enableOpenAccess()
    const registry = registryWithMode()
    const link = registry.addDevice('Runtime', 'runtime')
    expect(registry.validateToken(link.token)?.deviceId).toBe(link.deviceId)
    // A real row still wins over the synthetic principal.
    expect(registry.validateToken(link.token)?.deviceId).not.toBe(OPEN_ACCESS_DEVICE_ID)
  })

  it('keeps the synthetic principal while enabled and revokes it the moment it is disabled', () => {
    enableOpenAccess()
    const registry = registryWithMode()
    const signedIn = registry.validateToken(ANY_TOKEN)
    const principal = devicePrincipalOf(signedIn!)
    expect(
      registry.resolveAuthenticatedPrincipal({
        deviceId: principal.deviceId,
        credentialRevision: principal.credentialRevision,
        deviceToken: ANY_TOKEN
      })
    ).toMatchObject({ deviceId: OPEN_ACCESS_DEVICE_ID, token: ANY_TOKEN })

    // Toggling off revokes live sockets without a restart: the next recheck fails.
    writeOpenAccessMode(dir, { acceptAnyAccessKey: false })
    expect(
      registry.resolveAuthenticatedPrincipal({
        deviceId: principal.deviceId,
        credentialRevision: principal.credentialRevision,
        deviceToken: ANY_TOKEN
      })
    ).toBeNull()
    // A binding without the proven token has nothing to re-materialize the principal from.
    expect(
      registry.resolveAuthenticatedPrincipal({
        deviceId: OPEN_ACCESS_DEVICE_ID,
        credentialRevision: 0
      })
    ).toBeNull()
  })

  it('exchanges nothing for the synthetic principal and never throws', () => {
    enableOpenAccess()
    const registry = registryWithMode()
    expect(() =>
      registry.exchangePairingTicket(OPEN_ACCESS_DEVICE_ID, ANY_TOKEN, 'a'.repeat(48))
    ).not.toThrow()
    // A real unknown id still reports the ordinary error with the mode on.
    let thrown: unknown = null
    try {
      registry.exchangePairingTicket('no-such-device', ANY_TOKEN, 'b'.repeat(48))
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof PairingTicketExchangeError ? thrown.code : thrown).toBe(
      'device_not_found'
    )
  })

  it('never persists the synthetic principal: the registry file is untouched by synthetic auth', () => {
    enableOpenAccess()
    const registry = registryWithMode()
    const link = registry.addDevice('Runtime', 'runtime')
    registry.updateLastSeen(link.deviceId)
    const fileBefore = readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf-8')

    const before = readRegistryFile()
    expect(registry.validateToken(ANY_TOKEN)?.deviceId).toBe(OPEN_ACCESS_DEVICE_ID)
    // Sighting bookkeeping for the synthetic id must not throw from the auth path either.
    expect(() => registry.updateLastSeenDeferred(OPEN_ACCESS_DEVICE_ID)).not.toThrow()
    expect(() => registry.updateLastSeen(OPEN_ACCESS_DEVICE_ID)).not.toThrow()
    registry.flushPendingLastSeen()

    expect(readRegistryFile()).toEqual(before)
    expect(readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf-8')).toBe(fileBefore)
    expect(registry.getDevice(OPEN_ACCESS_DEVICE_ID)).toBeNull()
    expect(readOpenAccessMode(dir)).toEqual({ acceptAnyAccessKey: true })
  })

  it('a registry without an open-access path never authenticates an arbitrary token', () => {
    // Existing one-arg call sites keep the old behavior even if the file says on.
    enableOpenAccess()
    expect(new DeviceRegistry(dir).validateToken(ANY_TOKEN)).toBeNull()
  })
})
