import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import {
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewaySubscribeParamsSchema
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/federation/environment-transport'
import type { RpcContext } from '../core'
import { _resetTracerForTests, setActiveSink } from '../../../observability/tracer'
import {
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF as callMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF as subscribeMethod
} from './runtime-environment-gateway-methods'

const { subscribeRuntimeEnvironmentMock } = vi.hoisted(() => ({
  subscribeRuntimeEnvironmentMock: vi.fn()
}))
vi.mock(
  '../../../ipc/runtime-environments/requests/runtime-environment-subscription-routing',
  () => ({
    subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
  })
)

// Why: the relay path is the field-debug surface for "phone sees no tabs" — the
// spans must reach the trace file with the forwarded method and outcome on them.
let records: Record<string, unknown>[]

beforeEach(() => {
  records = []
  setActiveSink({
    push: (record) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sink receives only tracer records; the test reads name/attributes/events off them.
      records.push(record as Record<string, unknown>)
    },
    flush: () => {},
    close: () => {}
  })
  subscribeRuntimeEnvironmentMock.mockReset()
})

afterEach(() => {
  _resetTracerForTests()
})

function pairingCode(endpoint = 'ws://10.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function callCtx(transport: OrchestrationEnvironmentTransport): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the call handler only reads runtime.getOrchestrationEnvironmentTransport.
  return {
    clientKind: 'mobile',
    connectionId: 'conn-1',
    runtime: {
      getRuntimeId: () => 'runtime-gateway',
      getOrchestrationEnvironmentTransport: () => transport
    }
  } as unknown as RpcContext
}

describe('runtime environment gateway tracing', () => {
  const tempDirs: string[] = []
  let userDataPath = ''

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-gateway-tracing-'))
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

  function pairedEnvironmentId(): string {
    return addEnvironmentFromPairingCode(userDataPath, {
      name: 'upstream box',
      pairingCode: pairingCode()
    }).id
  }

  it('records the forwarded call outcome on the span', async () => {
    const gatewayEnvironmentId = pairedEnvironmentId()
    const innerFailure: RuntimeRpcResponse<unknown> = {
      id: 'req-1',
      ok: false,
      error: { code: 'forbidden', message: 'nope' },
      _meta: { runtimeId: null }
    }
    const transport: OrchestrationEnvironmentTransport = {
      resolve: vi.fn(),
      call: vi.fn(async () => innerFailure)
    }

    await callMethod.handler(
      RuntimeEnvironmentGatewayCallParamsSchema.parse({
        gatewayEnvironmentId,
        method: 'session.tabs.list',
        params: { worktree: 'id:repo::wt' }
      }),
      callCtx(transport)
    )

    const span = records.find((record) => record.name === 'runtime-environment.gateway.call')
    expect(span).toBeDefined()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracer serializes attributes as a free-form object; the test reads known keys.
    const attributes = (span?.attributes ?? {}) as Record<string, unknown>
    expect(attributes).toMatchObject({
      gatewayEnvironmentId,
      method: 'session.tabs.list',
      connectionId: 'conn-1',
      forwardedOk: false,
      forwardedErrorCode: 'forbidden'
    })
  })

  it('records the bridge lifecycle on the subscribe span', async () => {
    const gatewayEnvironmentId = pairedEnvironmentId()
    subscribeRuntimeEnvironmentMock.mockImplementation(
      async (
        _userDataPath: string,
        _id: string,
        _method: string,
        _params: unknown,
        _signal: unknown,
        callbacks: {
          onEvent: (payload: unknown) => void
          onClose: () => void
        }
      ) => {
        callbacks.onEvent({ type: 'response', response: { id: 's', ok: true, result: {} } })
        callbacks.onEvent({ type: 'close' })
        return {
          close: () => {},
          sendBinary: () => true
        }
      }
    )
    const registry = new Map<string, () => void>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscribe handler reads only the fixture's fences and passthroughs.
    const ctx = {
      clientKind: 'mobile',
      connectionId: 'conn-1',
      sendBinary: () => true,
      runtime: {
        getRuntimeId: () => 'runtime-gateway',
        getOrchestrationEnvironmentTransport: () => null,
        registerSubscriptionCleanup: (id: string, cleanup: () => void) => {
          registry.set(id, cleanup)
        }
      }
    } as unknown as RpcContext

    await subscribeMethod.handler(
      RuntimeEnvironmentGatewaySubscribeParamsSchema.parse({
        gatewayEnvironmentId,
        method: 'terminal.subscribe',
        params: { terminal: 't1' }
      }),
      ctx,
      () => {}
    )

    const span = records.find(
      (record) => record.name === 'runtime-environment.gateway.downstream-subscribe'
    )
    expect(span).toBeDefined()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracer serializes events as {name, timeUnixNano, attributes}; the test reads names.
    const events = (span?.events ?? []) as { name: string }[]
    expect(events.map((event) => event.name)).toContain('upstream-subscribed')
    expect(events.map((event) => event.name)).toContain('upstream-close')
    expect(events.map((event) => event.name)).toContain('cleanup')
  })
})
