import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { encodePairingOffer } from '../../shared/pairing'
import {
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from '../../shared/rpc-contract/runtime-environment-relay-params'
import {
  downstreamEnvironmentId,
  upsertDownstreamEnvironment
} from '../../shared/runtime-environment-downstream-rows'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { callDownstreamEnvironment } from './runtime-environment-relay-routing'

function pairingCode(endpoint = 'ws://10.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

const DOWNSTREAM_GATEWAY_ENV_ID = 'env-web-target'

// The five reads this extension adds so a relayed Projects tree can expand below its folder rows.
const PHASE1_TREE_READS = [
  'worktree.detectedList',
  'worktree.list',
  'worktree.lineageList',
  'folderWorkspace.list',
  'folderWorkspace.getPathStatus'
] as const

function downstreamRow(userDataPath: string): {
  id: string
  gatewayEnvironmentId?: string
  runtimeId: string | null
} {
  const row = listEnvironments(userDataPath).find(
    (entry) => entry.gatewayEnvironmentId === DOWNSTREAM_GATEWAY_ENV_ID
  )
  if (!row) {
    throw new Error('missing downstream row')
  }
  return row
}

describe('callDownstreamEnvironment', () => {
  const tempDirs: string[] = []
  let userDataPath = ''
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Store writes must not harden Windows ACLs inside unit tests.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    callRuntimeEnvironmentMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-routing-'))
    tempDirs.push(userDataPath)
    const gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode()
    })
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
      name: `${gateway.name} → web box`,
      upstreamRuntimeId: null,
      offer: getPreferredPairingOffer(gateway)
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    callRuntimeEnvironmentMock.mockReset()
  })

  it('dials the relay method — never a direct status.get to the route endpoint', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        response: { id: 'r1', ok: true, result: {}, _meta: { runtimeId: 'runtime-c1' } },
        _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID }
      },
      _meta: { runtimeId: 'runtime-gateway' }
    })

    await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'status.get' }
    )

    const dial = callRuntimeEnvironmentMock.mock.calls[0]!
    expect(dial[1]).toBe(downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID))
    expect(dial[2]).toBe(RUNTIME_ENVIRONMENT_RELAY_METHOD)
    expect(dial[3]).toEqual({
      gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
      method: 'status.get'
    })
  })

  it('hands the renderer the upstream envelope and binds the row to its runtimeId', async () => {
    callRuntimeEnvironmentMock.mockImplementation(async () => ({
      id: 'rpc-1',
      ok: true,
      result: {
        response: {
          id: 'r1',
          ok: true,
          result: { status: 'up' },
          _meta: { runtimeId: 'runtime-c1' }
        },
        _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID }
      },
      // The outer envelope names the gateway; the row must not stay bound to it.
      _meta: { runtimeId: 'runtime-gateway' }
    }))

    const response = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )

    expect(response).toEqual({
      id: 'r1',
      ok: true,
      result: { status: 'up' },
      _meta: { runtimeId: 'runtime-c1' }
    })
    expect(downstreamRow(userDataPath).runtimeId).toBe('runtime-c1')
  })

  it('refuses phase-1-excluded methods locally without dialing', async () => {
    const response = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'terminal.streamMakeCoffee' }
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        message: runtimeEnvironmentRelayPhase1AllowlistMessage('terminal.streamMakeCoffee')
      },
      _meta: { runtimeId: null }
    })
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('dials the phase-1 tree reads through the relay instead of refusing them locally', async () => {
    for (const method of PHASE1_TREE_READS) {
      const inner = {
        id: 'r1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-c1' }
      }
      callRuntimeEnvironmentMock.mockResolvedValue({
        id: 'rpc-1',
        ok: true,
        result: { response: inner, _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID } },
        _meta: { runtimeId: 'runtime-gateway' }
      })

      const response = await callDownstreamEnvironment(
        userDataPath,
        resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
        { method }
      )

      expect(response).toEqual(inner)
      const dial = callRuntimeEnvironmentMock.mock.lastCall!
      expect(dial[1]).toBe(downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID))
      expect(dial[2]).toBe(RUNTIME_ENVIRONMENT_RELAY_METHOD)
      expect(dial[3]).toEqual({
        gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
        method
      })
    }
  })

  it('surfaces gateway-side failures as-is (gateway stays the truthful identity)', async () => {
    const outerFailure = {
      id: 'rpc-1',
      ok: false,
      error: { code: 'method_not_found', message: 'this host predates the relay' },
      _meta: { runtimeId: 'runtime-gateway' }
    }
    callRuntimeEnvironmentMock.mockResolvedValue(outerFailure)

    const response = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )

    expect(response).toEqual(outerFailure)
    expect(downstreamRow(userDataPath).runtimeId).toBeNull()
  })

  it('resolves keepalive surprises as invalid_runtime_response', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        response: { _keepalive: true },
        _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID }
      },
      _meta: { runtimeId: 'runtime-gateway' }
    })

    const response = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_runtime_response' } })
  })

  it('resolves unreadable relay results as invalid_runtime_response', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { response: { _keepalive: false } },
      _meta: { runtimeId: 'runtime-gateway' }
    })

    const response = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_runtime_response' } })
  })

  it('resolves dial throws as failure envelopes, keeping a thrown code when there is one', async () => {
    callRuntimeEnvironmentMock.mockRejectedValue(
      Object.assign(new Error('request queue full'), { code: 'timeout' })
    )

    const timedOut = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } })

    callRuntimeEnvironmentMock.mockRejectedValue(new Error('socket gone'))
    const lost = await callDownstreamEnvironment(
      userDataPath,
      resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
      { method: 'repo.list' }
    )
    expect(lost).toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable', message: 'socket gone' }
    })
  })

  it('refuses to route a directly paired environment through the relay', async () => {
    await expect(
      callDownstreamEnvironment(userDataPath, resolveEnvironment(userDataPath, 'gateway box'), {
        method: 'repo.list'
      })
    ).rejects.toThrow('not_a_downstream_environment')
  })
})
