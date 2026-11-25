import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({ callRuntimeEnvironmentMock: vi.fn() }))
vi.mock('./requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import {
  REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS,
  REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from '../../../shared/rpc-contract/runtime-environment-relay-params'
import {
  downstreamEnvironmentId,
  upsertDownstreamEnvironment
} from '../../../shared/runtime-environment-downstream-rows'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
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

  beforeEach(() => {
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

  it('dials the attach-operate methods through the relay instead of refusing them', async () => {
    for (const method of REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS) {
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
      expect(dial[2]).toBe(RUNTIME_ENVIRONMENT_RELAY_METHOD)
      expect(dial[3]).toEqual({
        gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
        method
      })
    }
  })

  it('forwards the pty-transport write tick, resize fallback, and pane retirement verbatim', async () => {
    // The remote PTY transport's acknowledged write (interrupt inference),
    // updateViewport pause fallback, and terminal close all ride terminal.send /
    // terminal.updateViewport / terminal.close; a refusal here strands the
    // interrupt and leaks the upstream PTY instead of surfacing a pane error.
    const cases: [string, Record<string, unknown>, unknown][] = [
      ['terminal.send', { terminal: 'tw-1', data: '\u0003', sequence: 1 }, { send: 'queued' }],
      [
        'terminal.updateViewport',
        { terminal: 'tw-1', rows: 30, cols: 120 },
        { terminal: { handle: 'tw-1' } }
      ],
      ['terminal.close', { terminal: { handle: 'tw-1' } }, { close: { handle: 'tw-1' } }]
    ]

    for (const [method, params, result] of cases) {
      const inner = {
        id: 'r1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-c1' }
      }
      callRuntimeEnvironmentMock.mockResolvedValueOnce({
        id: 'rpc-1',
        ok: true,
        result: { response: inner, _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID } },
        _meta: { runtimeId: 'runtime-gateway' }
      })

      const response = await callDownstreamEnvironment(
        userDataPath,
        resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
        { method, params }
      )

      expect(response).toEqual(inner)
      const dial = callRuntimeEnvironmentMock.mock.lastCall!
      expect(dial[2]).toBe(RUNTIME_ENVIRONMENT_RELAY_METHOD)
      expect(dial[3]).toEqual({
        gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
        method,
        params
      })
    }
  })

  it('forwards the milestone-2 landing calls verbatim: a commit and a worktree removal reach the hosted box', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['git.commit', { worktree: 'wta', message: 'fix: keep the relay fence honest' }],
      ['worktree.rm', { name: 'wta', hostId: 'local' }]
    ]

    for (const [method, params] of cases) {
      const inner = {
        id: 'r1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-c1' }
      }
      callRuntimeEnvironmentMock.mockResolvedValueOnce({
        id: 'rpc-1',
        ok: true,
        result: { response: inner, _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID } },
        _meta: { runtimeId: 'runtime-gateway' }
      })

      const response = await callDownstreamEnvironment(
        userDataPath,
        resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
        { method, params }
      )

      expect(response).toEqual(inner)
      const dial = callRuntimeEnvironmentMock.mock.lastCall!
      expect(dial[3]).toEqual({
        gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
        method,
        params
      })
    }
  })

  it('forwards the follow-up operate calls verbatim: reviewer removal and a workspace port kill', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['github.removePRReviewers', { repo: 'team/app', prNumber: 42, reviewers: ['ghost'] }],
      ['workspacePorts.kill', { pid: 1234, port: 3000 }]
    ]

    for (const [method, params] of cases) {
      const inner = {
        id: 'r1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-c1' }
      }
      callRuntimeEnvironmentMock.mockResolvedValueOnce({
        id: 'rpc-1',
        ok: true,
        result: { response: inner, _meta: { gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID } },
        _meta: { runtimeId: 'runtime-gateway' }
      })

      const response = await callDownstreamEnvironment(
        userDataPath,
        resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
        { method, params }
      )

      expect(response).toEqual(inner)
      const dial = callRuntimeEnvironmentMock.mock.lastCall!
      expect(dial[3]).toEqual({
        gatewayEnvironmentId: DOWNSTREAM_GATEWAY_ENV_ID,
        method,
        params
      })
    }
  })

  it('still refuses the binary stream methods on the call vehicle: they ride downstream.subscribe', async () => {
    for (const method of REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS) {
      const response = await callDownstreamEnvironment(
        userDataPath,
        resolveEnvironment(userDataPath, downstreamEnvironmentId(DOWNSTREAM_GATEWAY_ENV_ID)),
        { method }
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'forbidden',
          message: runtimeEnvironmentRelayPhase1AllowlistMessage(method)
        }
      })
    }
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('refuses to route a directly paired environment through the relay', async () => {
    await expect(
      callDownstreamEnvironment(userDataPath, resolveEnvironment(userDataPath, 'gateway box'), {
        method: 'repo.list'
      })
    ).rejects.toThrow('not_a_downstream_environment')
  })
})
