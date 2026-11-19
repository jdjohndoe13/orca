import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RemoteRuntimeSubscriptionOptions,
  RemoteRuntimeTransportSubscription,
  RemoteRuntimeTransportSubscriptionCallbacks
} from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'

const { subscribeRemoteRuntimeTransportMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeTransportMock:
    vi.fn<
      (
        connection: unknown,
        method: string,
        params: unknown,
        timeoutMs: number,
        callbacks: RemoteRuntimeTransportSubscriptionCallbacks<unknown>,
        options?: RemoteRuntimeSubscriptionOptions
      ) => Promise<RemoteRuntimeTransportSubscription>
    >()
}))
vi.mock('../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribeRemoteRuntimeTransportMock
}))

import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import {
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS,
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from '../../../shared/rpc-contract/runtime-environment-relay-params'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { addEnvironmentFromPairingCode } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { subscribeRelayDownstreamEnvironment } from './runtime-environment-relay-subscribe-routing'

function pairingCode(endpoint = 'ws://10.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function downstreamEnvironmentFixture(
  userDataPath: string,
  gatewayEnvironmentId = 'env-web-target'
): { environment: ReturnType<typeof addEnvironmentFromPairingCode> } {
  const gateway = addEnvironmentFromPairingCode(userDataPath, {
    name: 'gateway box',
    pairingCode: pairingCode()
  })
  return {
    environment: { ...gateway, gatewayEnvironmentId }
  }
}

describe('subscribeRelayDownstreamEnvironment', () => {
  const tempDirs: string[] = []
  let userDataPath = ''

  beforeEach(() => {
    subscribeRemoteRuntimeTransportMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-subscribe-'))
    tempDirs.push(userDataPath)
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses rows without a gateway address', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    await expect(
      subscribeRelayDownstreamEnvironment({
        userDataPath,
        environment: { ...environment, gatewayEnvironmentId: undefined },
        method: 'terminal.multiplex',
        params: {},
        timeoutMs: 15_000,
        callbacks: {
          onEvent: () => {},
          onClose: () => {}
        },
        markUsedOnce: () => {}
      })
    ).rejects.toThrow('not_a_downstream_environment')
    expect(subscribeRemoteRuntimeTransportMock).not.toHaveBeenCalled()
  })

  it('refuses off-allowlist methods without dialing', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    await expect(
      subscribeRelayDownstreamEnvironment({
        userDataPath,
        environment,
        method: 'browser.open',
        params: {},
        timeoutMs: 15_000,
        callbacks: {
          onEvent: () => {},
          onClose: () => {}
        },
        markUsedOnce: () => {}
      })
    ).rejects.toThrow(runtimeEnvironmentRelayPhase1AllowlistMessage('browser.open'))
    expect(subscribeRemoteRuntimeTransportMock).not.toHaveBeenCalled()
  })

  it('dials the attach-subscribe method with the row address and electron capabilities', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })

    await subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: { client: { id: 'client-1' } },
      timeoutMs: 15_000,
      callbacks: {
        onEvent: () => {},
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })

    const dial = subscribeRemoteRuntimeTransportMock.mock.calls[0]!
    expect(dial[1]).toBe(RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD)
    expect(dial[2]).toEqual({
      gatewayEnvironmentId: 'env-web-target',
      method: 'terminal.multiplex',
      params: { client: { id: 'client-1' } }
    })
    expect(dial[3]).toBe(15_000)
    expect(dial[5]?.clientCapabilities ?? []).toEqual(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
  })

  it('forwards the upstream envelope verbatim from the outer event payload and marks the row used', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const inner: RuntimeRpcResponse<unknown> = {
      id: 'inner-1',
      ok: true,
      result: { type: 'ready' },
      _meta: { runtimeId: 'runtime-c1' }
    }
    const events: unknown[] = []
    const markUsedOnce = vi.fn()
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    // The subscribe promise resolves on outer-auth before events; deliver them via callbacks.
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onResponse({
      id: 'outer-1',
      ok: true,
      result: { type: 'response', response: inner },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    await pending

    expect(events).toEqual([{ type: 'response', response: inner }])
    expect(markUsedOnce).toHaveBeenCalledWith('runtime-c1')
  })

  it('skips keepalive results without forwarding or marking used', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    const markUsedOnce = vi.fn()
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onResponse({
      id: 'outer-1',
      ok: true,
      result: { type: 'response', response: { _keepalive: true } },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    await pending

    expect(events).toEqual([])
    expect(markUsedOnce).not.toHaveBeenCalled()
  })

  it('surfaces an unreadable outer event as invalid_runtime_response', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onResponse({
      id: 'outer-1',
      ok: true,
      result: { type: 'sideways' },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    await pending

    expect(events).toEqual([
      {
        type: 'error',
        code: 'invalid_runtime_response',
        message: 'The connected server returned an unreadable relay response.'
      }
    ])
  })

  it('turns the outer end marker into one forwarded close plus outer-subscription teardown', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    let closedCount = 0
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(() => {
        closedCount += 1
      }),
      sendBinary: vi.fn(() => true)
    })
    await subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onResponse({
      id: 'outer-1',
      ok: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    // Late arrivals can sit behind the end marker in the same event tick; the close
    // latch only suppresses duplicated teardown, not already-in-motion events.
    callbacks.onResponse({
      id: 'outer-1',
      ok: true,
      result: {
        type: 'response',
        response: { id: 'i2', ok: true, result: {}, _meta: { runtimeId: 'runtime-c1' } }
      },
      _meta: { runtimeId: 'runtime-gateway' }
    })
    callbacks.onClose?.()

    expect(events.at(0)).toEqual({ type: 'close' })
    expect(events.at(-1)).toMatchObject({ type: 'response' })
    expect(closedCount).toBe(1)
  })

  it('carries forwarded binary bytes verbatim', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    const bytes = new Uint8Array([0x74, 1, 8, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 104, 105])
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onBinary?.(bytes)
    await pending

    expect(events).toEqual([{ type: 'binary', bytes }])
  })

  it('keeps method_not_found-shaped outer failures verbatim for the renderer to unwrap', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    const outerFailure: RuntimeRpcResponse<unknown> = {
      id: 'outer-1',
      ok: false,
      error: { code: 'method_not_found', message: 'this host predates the relay' },
      _meta: { runtimeId: 'runtime-gateway' }
    }
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onResponse(outerFailure)
    await pending

    expect(events).toEqual([{ type: 'response', response: outerFailure }])
  })

  it('hints tailscale advice on transport error events', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    const events: unknown[] = []
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })
    const pending = subscribeRelayDownstreamEnvironment({
      userDataPath,
      environment,
      method: 'terminal.multiplex',
      params: {},
      timeoutMs: 15_000,
      callbacks: {
        onEvent: (payload) => events.push(payload),
        onClose: () => {}
      },
      markUsedOnce: () => {}
    })
    const callbacks = subscribeRemoteRuntimeTransportMock.mock.calls[0]![4]
    callbacks.onError(
      Object.assign(new Error('could not connect to the remote orca runtime'), {
        code: 'remote_runtime_unavailable'
      })
    )
    await pending

    expect(events).toEqual([
      {
        type: 'error',
        code: 'remote_runtime_unavailable',
        message: expect.stringContaining('tailscale.com/download')
      }
    ])
  })

  it('hints tailscale advice on a failed outer dial', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    subscribeRemoteRuntimeTransportMock.mockRejectedValue(
      new Error('could not connect to the remote orca runtime')
    )
    await expect(
      subscribeRelayDownstreamEnvironment({
        userDataPath,
        environment,
        method: 'terminal.multiplex',
        params: {},
        timeoutMs: 15_000,
        callbacks: {
          onEvent: () => {},
          onClose: () => {}
        },
        markUsedOnce: () => {}
      })
    ).rejects.toThrow(/tailscale\.com\/download/)
  })

  it('dials every attach-stream method through the stream vehicle framing', async () => {
    const { environment } = downstreamEnvironmentFixture(userDataPath)
    subscribeRemoteRuntimeTransportMock.mockResolvedValue({
      requestId: 'outer-1',
      close: vi.fn(),
      sendBinary: vi.fn(() => true)
    })

    for (const method of REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS) {
      await subscribeRelayDownstreamEnvironment({
        userDataPath,
        environment,
        method,
        params: {},
        timeoutMs: 15_000,
        callbacks: {
          onEvent: () => {},
          onClose: () => {}
        },
        markUsedOnce: () => {}
      })
      expect(subscribeRemoteRuntimeTransportMock).toHaveBeenLastCalledWith(
        expect.any(Object),
        RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
        { gatewayEnvironmentId: 'env-web-target', method, params: {} },
        15_000,
        expect.any(Object),
        expect.anything()
      )
    }
  })
})
