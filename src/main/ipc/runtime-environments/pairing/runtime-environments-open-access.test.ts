import '../../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as environmentStore from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { DEFAULT_ORCA_ACCESS_KEY } from '../../../../shared/remote-runtime/open-access/open-access'
import { PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/pairing/ticket-exchange-capability'

const { handleMock, getPathMock, sendRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestMock
}))
vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: vi.fn()
}))

vi.mock('../connections/runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('../runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: vi.fn(() => new Promise(() => {})),
    subscribeRemoteRuntimeSharedControlRequest: vi.fn(),
    getRemoteRuntimeSharedControlDiagnostics: vi.fn(() => null),
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    retryRemoteRuntimeSharedControlConnectionsNow: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: vi.fn()
  })
})

import { registerRuntimeEnvironmentHandlers } from '../runtime-environments'
import { channelHandlerLookup, pairingCode } from '../runtime-environments-ipc-test-harness'
import {
  applyDeviceTokenOverride,
  applyEndpointOverride,
  isPlaceholderHostKey
} from '../../../../shared/remote-runtime/open-access/open-access-link'
import { parseHostAccessLink } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'

const handler = channelHandlerLookup(handleMock)

function runtimeStatus(): Record<string, unknown> {
  return {
    runtimeId: 'runtime-open-access',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    protocolVersion: 999_999
  }
}

function statusResponse() {
  return {
    id: 'status',
    ok: true,
    result: runtimeStatus(),
    _meta: { runtimeId: 'runtime-open-access' }
  }
}

/** The connection the verification dialed, so the test can assert the built offer's shape. */
function dialedConnection(): {
  endpoint: string
  hostPublicKeyB64: string
  credential: { deviceToken: string }
  trustOnFirstUse?: boolean
} {
  expect(sendRemoteRuntimeRequestMock).toHaveBeenCalled()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request shape is asserted by the caller's expectations; the cast only restores the typed args tuple.
  return sendRemoteRuntimeRequestMock.mock.calls[0]![0] as never
}

describe('open-access connect-by-IP verification', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-open-access-ipc-'))
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeRequestMock.mockResolvedValue(statusResponse())
    const store = {
      getSettings: () => ({ activeRuntimeEnvironmentId: null }),
      updateSettings: vi.fn(),
      removeWorkspaceSessionHost: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn(),
      setHostRepoCatalogSnapshot: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registrar only reads the fixture's settings and workspace-session methods.
    await registerRuntimeEnvironmentHandlers(store as never)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('dials the default token with TOFU and records the open-access flag when the link is empty', async () => {
    // Why the capability: the host would advertise the ticket exchange, so one call proves the
    // open-access path skipped it and kept the default token.
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { ...runtimeStatus(), capabilities: [PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY] },
      _meta: { runtimeId: 'runtime-open-access' }
    })
    const verifyAndAdd = handler<
      {
        name: string
        pairingCode: string
        endpointOverride?: string
        deviceTokenOverride?: string
      },
      { ok: boolean; environment?: { id: string } }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    const result = await verifyAndAdd(null, {
      name: 'desk',
      pairingCode: '',
      endpointOverride: '192.168.250.29:6768'
    })

    expect(result).toMatchObject({ ok: true })
    expect(dialedConnection()).toMatchObject({
      endpoint: 'ws://192.168.250.29:6768',
      credential: { deviceToken: DEFAULT_ORCA_ACCESS_KEY },
      trustOnFirstUse: true
    })
    // The default token is the point of open access, so no ticket exchange replaced it.
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(1)
    const saved = await environmentStore.resolveEnvironment(userDataPath, 'desk')
    expect(saved.endpoints[0]).toMatchObject({
      endpoint: 'ws://192.168.250.29:6768',
      deviceToken: DEFAULT_ORCA_ACCESS_KEY,
      openAccess: true
    })
    // The placeholder survives the round-trip and is recognized as such.
    expect(isPlaceholderHostKey(saved.endpoints[0]!.publicKeyB64)).toBe(true)
    const offer = await environmentStore.resolveEnvironmentPairingOffer(userDataPath, 'desk')
    expect(offer.openAccess).toBe(true)
  })

  it('rejects an empty link with no address', async () => {
    const verifyAndAdd = handler<
      { name: string; pairingCode: string },
      { ok: boolean; kind?: string }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')
    await expect(verifyAndAdd(null, { name: 'desk', pairingCode: '' })).resolves.toMatchObject({
      ok: false,
      kind: 'access-link-invalid'
    })
  })

  it('dials the override endpoint while keeping the link’s pinned key', async () => {
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; endpointOverride?: string },
      { ok: boolean }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')
    const link = pairingCode('ws://127.0.0.1:6768')

    await expect(
      verifyAndAdd(null, {
        name: 'desk',
        pairingCode: link,
        endpointOverride: '192.168.250.29:6768'
      })
    ).resolves.toMatchObject({ ok: true })

    // The override wins for the loopback check too: the link is loopback, the address is LAN.
    expect(dialedConnection()).toMatchObject({
      endpoint: 'ws://192.168.250.29:6768',
      credential: { deviceToken: 'device-token' }
    })
    expect(dialedConnection().trustOnFirstUse).toBeUndefined()
    const saved = await environmentStore.resolveEnvironment(userDataPath, 'desk')
    expect(saved.endpoints[0]).not.toHaveProperty('openAccess')
  })

  it('swaps the saved token for the access-key override', async () => {
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; deviceTokenOverride?: string },
      { ok: boolean }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    await expect(
      verifyAndAdd(null, {
        name: 'desk',
        pairingCode: pairingCode('ws://192.168.250.29:6768'),
        deviceTokenOverride: 'host-default-key'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(dialedConnection().credential.deviceToken).toBe('host-default-key')
  })

  it('repairs an open-access pairing with any key the reached host presents', async () => {
    // The saved pairing came from the IP-only mode.
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; endpointOverride?: string },
      { ok: boolean }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')
    await verifyAndAdd(null, {
      name: 'desk',
      pairingCode: '',
      endpointOverride: '192.168.250.29:6768'
    })
    const before = await environmentStore.resolveEnvironment(userDataPath, 'desk')
    sendRemoteRuntimeRequestMock.mockResolvedValue(statusResponse())

    const repair = handler<
      { selector: string; pairingCode: string; endpointOverride?: string },
      { ok: boolean; environment?: { id: string } }
    >('runtimeEnvironments:repairFromPairingCode')
    // A cloned machine keeps the same keypair; an address-only repair must not be refused as a
    // different server, and the TOFU flag must survive the re-save.
    const result = await repair(null, {
      selector: 'desk',
      pairingCode: '',
      endpointOverride: '192.168.250.30:6768'
    })

    expect(result).toMatchObject({ ok: true, environment: { id: before.id, name: 'desk' } })
    const after = await environmentStore.resolveEnvironment(userDataPath, 'desk')
    expect(after.endpoints[0]).toMatchObject({
      endpoint: 'ws://192.168.250.30:6768',
      deviceToken: DEFAULT_ORCA_ACCESS_KEY,
      openAccess: true
    })
  })
})

describe('pairing verification override helpers', () => {
  const parsed = parseHostAccessLink(
    pairingCode('ws://100.76.32.125:6768', { deviceToken: 'link-token' })
  )

  it('rebuilds the offer with the overridden endpoint and keeps the pinned key', () => {
    if (!parsed.ok) {
      throw new Error('fixture link must parse')
    }
    const overridden = applyEndpointOverride(parsed.value, '192.168.250.29:6768')
    expect(overridden.ok).toBe(true)
    if (!overridden.ok) {
      return
    }
    expect(overridden.value.pairing).toEqual({
      ...parsed.value.pairing,
      endpoint: 'ws://192.168.250.29:6768'
    })
  })

  it('keeps the link token when the access-key override is empty', () => {
    if (!parsed.ok) {
      throw new Error('fixture link must parse')
    }
    expect(applyDeviceTokenOverride(parsed.value, '')).toBe(parsed.value)
    expect(applyDeviceTokenOverride(parsed.value, 'other').pairing.deviceToken).toBe('other')
  })
})
