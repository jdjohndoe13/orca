import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import {
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  RuntimeEnvironmentDownstreamListParamsSchema,
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewaySubscribeParamsSchema,
  RuntimeEnvironmentGatewayUnsubscribeParamsSchema
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/federation/environment-transport'
import type { RpcContext } from '../core'
import {
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF as callMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF as listMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF as subscribeMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_UNSUBSCRIBE_METHOD_DEF as unsubscribeMethod,
  MOBILE_RELAY_VEHICLE_METHODS
} from './runtime-environment-gateway-methods'

const { statusSnapshotsMock, subscribeRuntimeEnvironmentMock } = vi.hoisted(() => ({
  statusSnapshotsMock: vi.fn(),
  subscribeRuntimeEnvironmentMock: vi.fn()
}))
vi.mock(
  '../../../ipc/runtime-environments/connections/runtime-environment-request-connections',
  () => ({
    getRuntimeEnvironmentStatusSnapshots: statusSnapshotsMock
  })
)
vi.mock(
  '../../../ipc/runtime-environments/requests/runtime-environment-subscription-routing',
  () => ({
    subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
  })
)

function pairingCode(endpoint = 'ws://10.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function ctxFixture(
  transport: OrchestrationEnvironmentTransport | null,
  clientKind: 'mobile' | 'runtime' = 'runtime'
): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the three methods under test are reachable; each reads runtime.getRuntimeId/getOrchestrationEnvironmentTransport.
  return {
    clientKind,
    runtime: {
      getRuntimeId: () => 'runtime-gateway',
      getOrchestrationEnvironmentTransport: () => transport
    }
  } as unknown as RpcContext
}

const Conn_ID = 'conn-1'

type BridgeRegistration = {
  id: string
  connectionId?: string
  requestId?: string
  cleanup: () => void
}

function subscribeCtxFixture(options: {
  registrations: BridgeRegistration[]
  outboundBinary: Uint8Array<ArrayBufferLike>[]
  attachBinaryHandler: (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => void
}): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture only satisfies the fences and passthroughs the subscribe handler reads.
  return {
    clientKind: 'mobile',
    connectionId: Conn_ID,
    requestId: 'req-bridge',
    sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
      options.outboundBinary.push(bytes)
      return true
    },
    registerBinaryMessageHandler: (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => {
      options.attachBinaryHandler(handler)
      return () => {}
    },
    signal: new AbortController().signal,
    runtime: {
      getRuntimeId: () => 'runtime-gateway',
      getOrchestrationEnvironmentTransport: () => null,
      registerSubscriptionCleanup: (
        id: string,
        cleanup: () => void,
        connectionId?: string,
        requestId?: string
      ) => {
        options.registrations.push({ id, connectionId, requestId, cleanup })
      }
    }
  } as unknown as RpcContext
}

function fakeSubscription(): {
  requestId: string
  close: ReturnType<typeof vi.fn>
  sendBinary: ReturnType<typeof vi.fn>
} {
  return {
    requestId: 'outer-1',
    close: vi.fn(),
    sendBinary: vi.fn(() => true)
  }
}

function emitCollector(): { events: unknown[]; emit: (result: unknown) => void } {
  const events: unknown[] = []
  return { events, emit: (result) => events.push(result) }
}

function snapshotFor(environmentId: string): RuntimeHostStatusSnapshot {
  return {
    environmentId,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: Date.now(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture only satisfies the census projection (status presence + capabilities), not every live RuntimeStatus field.
    status: {
      runtimeId: 'runtime-box',
      capabilities: []
    } as unknown as RuntimeHostStatusSnapshot['status'],
    verification: 'verified',
    transport: 'ready'
  }
}

// The mobile-scope half of the gateway fence: the phone's WS dispatcher already
// denies non-allowlisted methods, so these pin the gateway's own second fence —
// the three vehicles serve mobile exactly like a runtime caller, and everything
// else stays refused.
describe('runtime environment gateway mobile scope', () => {
  const tempDirs: string[] = []
  let userDataPath = ''

  beforeEach(() => {
    statusSnapshotsMock.mockReset()
    subscribeRuntimeEnvironmentMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-gateway-mobile-'))
    tempDirs.push(userDataPath)
    setAppEnvironment({
      getPath: () => userDataPath,
      getAppPath: () => userDataPath,
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('admits exactly the four relay vehicles for mobile scopes', () => {
    expect([...MOBILE_RELAY_VEHICLE_METHODS]).toEqual([
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD
    ])
  })

  it('serves mobile-scope callers the same census', async () => {
    const gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode('ws://10.0.0.1:6768')
    })
    statusSnapshotsMock.mockReturnValue([snapshotFor(gateway.id)])

    const result = await listMethod.handler(
      RuntimeEnvironmentDownstreamListParamsSchema.parse({}),
      ctxFixture(null, 'mobile')
    )

    expect(result.environments.map((row) => row.gatewayEnvironmentId)).toEqual([null, gateway.id])
  })

  it('forwards a mobile-scope forwardable call like a runtime caller', async () => {
    const gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode('ws://10.0.0.1:6768')
    })
    const inner: RuntimeRpcResponse<unknown> = {
      id: 'req-1',
      ok: true,
      result: {
        repos: [{ id: 'repo-a', executionHostId: 'runtime:env-web' }]
      },
      _meta: { runtimeId: 'runtime-upstream' }
    }
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => {
        throw new Error('not used by this method')
      },
      call: vi.fn(async () => inner)
    }

    const result = await callMethod!.handler(
      RuntimeEnvironmentGatewayCallParamsSchema.parse({
        gatewayEnvironmentId: gateway.id,
        method: 'repo.list'
      }),
      ctxFixture(transport, 'mobile')
    )

    expect(result).toEqual({
      response: inner,
      _meta: { gatewayEnvironmentId: gateway.id }
    })
    expect(transport.call).toHaveBeenCalledWith(gateway.id, 'repo.list', undefined)
  })

  it('bridges for a mobile socket, skips the raw handler, and releases by request', async () => {
    const gateway = addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode: pairingCode('ws://10.0.0.1:6768')
    })
    const subscription = fakeSubscription()
    const dialArgs: {
      method: string
      params: unknown
      callbacks: { onEvent: (payload: unknown) => void; onClose: () => void }
    }[] = []
    subscribeRuntimeEnvironmentMock.mockImplementation(
      (
        _userDataPath: string,
        _environmentId: string,
        method: string,
        params: unknown,
        _timeoutMs: number | undefined,
        callbacks: { onEvent: (payload: unknown) => void; onClose: () => void },
        _isCurrent?: () => boolean
      ) => {
        dialArgs.push({ method, params, callbacks })
        return Promise.resolve(subscription)
      }
    )
    const registrations: BridgeRegistration[] = []
    const outboundBinary: Uint8Array<ArrayBufferLike>[] = []
    const emitted = emitCollector()
    const rawHandlerCalls: ((bytes: Uint8Array<ArrayBufferLike>) => void)[] = []
    const ctx = subscribeCtxFixture({
      registrations,
      outboundBinary,
      attachBinaryHandler: (handler) => {
        rawHandlerCalls.push(handler)
      }
    })

    const handler = subscribeMethod.handler(
      RuntimeEnvironmentGatewaySubscribeParamsSchema.parse({
        gatewayEnvironmentId: gateway.id,
        method: 'terminal.subscribe'
      }),
      ctx,
      emitted.emit
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialArgs[0]?.method).toBe('terminal.subscribe')
    // The phone's local terminal streams own its binary router in per-stream
    // mode; the bridge must not register a raw handler that would conflict.
    expect(rawHandlerCalls).toHaveLength(0)
    // PTY output still crosses: the bridge forwards it through sendBinary.
    dialArgs[0]?.callbacks.onEvent({ type: 'binary', bytes: new Uint8Array([0x74, 1, 8]) })
    expect(outboundBinary).toEqual([new Uint8Array([0x74, 1, 8])])
    // The bridge is request-addressed so the shared phone socket can release it.
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.requestId).toBe('req-bridge')
    expect(registrations[0]?.connectionId).toBe(Conn_ID)
    const release = await unsubscribeMethod!.handler(
      RuntimeEnvironmentGatewayUnsubscribeParamsSchema.parse({ requestId: 'req-bridge' }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release handler only reads releaseSubscriptionByRequest.
      {
        clientKind: 'mobile',
        connectionId: Conn_ID,
        runtime: {
          releaseSubscriptionByRequest: (connectionId: string | undefined, requestId: string) => {
            for (const reg of registrations) {
              if (reg.connectionId === connectionId && reg.requestId === requestId) {
                reg.cleanup()
              }
            }
          }
        }
      } as unknown as RpcContext
    )
    expect(release).toEqual({ released: true })
    await handler
    expect(subscription.close).toHaveBeenCalledOnce()
  })
})
