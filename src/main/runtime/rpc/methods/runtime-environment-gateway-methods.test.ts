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
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { upsertDownstreamEnvironment } from '../../../../shared/runtime-environment-downstream-rows'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { getPreferredPairingOffer } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/federation/environment-transport'
import type { RpcContext } from '../core'
import {
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF as callMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF as listMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF as subscribeMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_METHODS
} from './runtime-environment-gateway-methods'

const { statusSnapshotsMock, subscribeRuntimeEnvironmentMock } = vi.hoisted(() => ({
  statusSnapshotsMock: vi.fn(),
  subscribeRuntimeEnvironmentMock: vi.fn()
}))
vi.mock('../../../ipc/runtime-environments/connections/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: statusSnapshotsMock
}))
vi.mock('../../../ipc/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
}))

function pairingCode(endpoint = 'ws://10.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

// The five reads this extension adds so a relayed Projects tree can expand below its folder rows.
const PHASE1_TREE_READS = [
  'worktree.detectedList',
  'worktree.list',
  'worktree.lineageList',
  'folderWorkspace.list',
  'folderWorkspace.getPathStatus'
] as const

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

type FakeSubscription = {
  requestId: string
  close: ReturnType<typeof vi.fn>
  sendBinary: ReturnType<typeof vi.fn>
}

function subscribeCtxFixture(options: {
  mobile?: boolean
  aborted?: boolean
  bareSocket?: boolean
  registry: Map<string, () => void>
  outboundBinary: Uint8Array<ArrayBufferLike>[]
  attachBinaryHandler: (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => void
}): RpcContext {
  const signal = new AbortController()
  if (options.aborted) {
    signal.abort()
  }
  const hasBinaryChannel = !options.bareSocket
  // Why: mobile sockets stream binary PTY frames through the same E2EE channel,
  // so the fixture must not pair mobile sockets with a bare channel.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture only satisfies the fences and passthroughs the subscribe handler reads.
  return {
    clientKind: options.mobile ? 'mobile' : 'runtime',
    connectionId: Conn_ID,
    sendBinary: hasBinaryChannel
      ? (bytes: Uint8Array<ArrayBufferLike>) => {
          options.outboundBinary.push(bytes)
          return true
        }
      : undefined,
    registerBinaryMessageHandler: hasBinaryChannel
      ? (handler: (bytes: Uint8Array<ArrayBufferLike>) => void) => {
          options.attachBinaryHandler(handler)
          return () => {}
        }
      : undefined,
    signal: signal.signal,
    runtime: {
      getRuntimeId: () => 'runtime-gateway',
      getOrchestrationEnvironmentTransport: () => null,
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => {
        options.registry.set(id, cleanup)
      }
    }
  } as unknown as RpcContext
}

const Conn_ID = 'conn-1'

function fakeSubscription(): FakeSubscription {
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

type GatewayDialCapture = {
  method: string
  params: unknown
  callbacks: { onEvent: (payload: unknown) => void; onClose: () => void }
}

function snapshotFor(
  environmentId: string,
  overrides: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: Date.now(),
    // RuntimeStatus carries far more live fields than the census reads; only the
    // projection's presence and capability list matter here.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture only satisfies the census projection (status presence + capabilities), not every live RuntimeStatus field.
    status: {
      runtimeId: 'runtime-box',
      capabilities: []
    } as unknown as RuntimeHostStatusSnapshot['status'],
    verification: 'verified',
    transport: 'ready',
    ...overrides
  }
}

function idleTransport(): OrchestrationEnvironmentTransport {
  return {
    resolve: vi.fn(() => {
      throw new Error('must not resolve')
    }),
    call: vi.fn(async () => {
      throw new Error('must not dial')
    })
  }
}

describe('runtime environment gateway methods', () => {
  const tempDirs: string[] = []
  let userDataPath = ''

  beforeEach(() => {
    statusSnapshotsMock.mockReset()
    subscribeRuntimeEnvironmentMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-gateway-methods-'))
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

  it('registers the census, the forwarding call, the attached-stream bridge, and its release', () => {
    expect(RUNTIME_ENVIRONMENT_GATEWAY_METHODS.map((method) => method.name)).toEqual([
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD
    ])
  })

  describe('runtimeEnvironment.downstream.list', () => {
    it('lists the self row plus each directly paired host, deriving state from live probes', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const web = addEnvironmentFromPairingCode(userDataPath, {
        name: 'web box',
        pairingCode: pairingCode('ws://10.0.0.2:6768')
      })
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'db box',
        pairingCode: pairingCode('ws://10.0.0.3:6768'),
        source: 'ephemeral-vm'
      })
      statusSnapshotsMock.mockReturnValue([
        snapshotFor(gateway.id, { verification: 'unavailable', status: null }),
        snapshotFor(web.id)
      ])

      const result = await listMethod.handler(
        RuntimeEnvironmentDownstreamListParamsSchema.parse({}),
        ctxFixture(null)
      )

      expect(result.environments).toEqual([
        {
          gatewayEnvironmentId: null,
          name: 'local',
          upstreamRuntimeId: 'runtime-gateway',
          state: 'connected',
          capabilities: expect.any(Array)
        },
        {
          gatewayEnvironmentId: gateway.id,
          name: 'gateway box',
          upstreamRuntimeId: null,
          state: 'unreachable',
          capabilities: null
        },
        {
          gatewayEnvironmentId: web.id,
          name: 'web box',
          upstreamRuntimeId: null,
          state: 'connected',
          capabilities: []
        }
      ])
    })

    it('keeps relay-view rows off the census: guests dial only directly paired hosts', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      upsertDownstreamEnvironment(userDataPath, {
        gatewayEnvironmentId: 'env-somewhere-else',
        name: 'nested view row',
        upstreamRuntimeId: 'runtime-nested',
        offer: getPreferredPairingOffer(gateway)
      })
      statusSnapshotsMock.mockReturnValue([])

      const result = await listMethod.handler(
        RuntimeEnvironmentDownstreamListParamsSchema.parse({}),
        ctxFixture(null)
      )

      expect(result.environments.map((row) => [row.gatewayEnvironmentId, row.name])).toEqual([
        [null, 'local'],
        // The gateway pairing itself is a normal directly paired host.
        [gateway.id, 'gateway box']
      ])
    })

    it('answers a never-probed host with the unknown arm instead of guessing', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      statusSnapshotsMock.mockReturnValue([snapshotFor(gateway.id, { checkedAt: 0 })])

      const result = await listMethod.handler(
        RuntimeEnvironmentDownstreamListParamsSchema.parse({}),
        ctxFixture(null)
      )

      expect(result.environments[1]!.state).toBe('unknown')
    })
  })

  describe('runtimeEnvironment.call', () => {
    it('forwards the upstream envelope verbatim inside the relay result', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const inner: RuntimeRpcResponse<unknown> = {
        id: 'req-1',
        ok: true,
        result: { projects: ['alpha'] },
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
          method: 'repo.list',
          params: { depth: 1 }
        }),
        ctxFixture(transport)
      )

      expect(result).toEqual({
        response: inner,
        _meta: { gatewayEnvironmentId: gateway.id }
      })
      expect(transport.call).toHaveBeenCalledWith(gateway.id, 'repo.list', { depth: 1 })
    })

    it('forwards the pty-transport write tick, resize fallback, and pane retirement', async () => {
      // The unified call fence must pass terminal.send / terminal.updateViewport /
      // terminal.close so an acked write, viewport pause fallback, and guest pane
      // close reach the upstream PTY instead of dying as a refusal envelope.
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
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
        const inner: RuntimeRpcResponse<unknown> = {
          id: 'req-1',
          ok: true,
          result,
          _meta: { runtimeId: 'runtime-upstream' }
        }
        const transport: OrchestrationEnvironmentTransport = {
          resolve: () => {
            throw new Error('not used by this method')
          },
          call: vi.fn(async () => inner)
        }

        const forwarded = await callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: gateway.id,
            method,
            params
          }),
          ctxFixture(transport)
        )

        expect(forwarded).toEqual({
          response: inner,
          _meta: { gatewayEnvironmentId: gateway.id }
        })
        expect(transport.call).toHaveBeenCalledWith(gateway.id, method, params)
      }
    })

    it('forwards an upstream failure envelope as-is so the guest sees the real verdict', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const innerFailure: RuntimeRpcResponse<unknown> = {
        id: 'req-1',
        ok: false,
        error: { code: 'method_not_found', message: 'no such method upstream' },
        _meta: { runtimeId: null }
      }
      const transport: OrchestrationEnvironmentTransport = {
        resolve: () => {
          throw new Error('not used by this method')
        },
        call: vi.fn(async () => innerFailure)
      }

      const result = await callMethod.handler(
        RuntimeEnvironmentGatewayCallParamsSchema.parse({
          gatewayEnvironmentId: gateway.id,
          method: 'status.get'
        }),
        ctxFixture(transport)
      )

      expect(result.response).toEqual(innerFailure)
    })

    it('forwards the phase-1 tree reads instead of refusing them, so the Projects tree can expand', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })

      for (const method of PHASE1_TREE_READS) {
        const inner: RuntimeRpcResponse<unknown> = {
          id: 'req-1',
          ok: true,
          result: {},
          _meta: { runtimeId: 'runtime-upstream' }
        }
        const transport: OrchestrationEnvironmentTransport = {
          resolve: () => {
            throw new Error('not used by this method')
          },
          call: vi.fn(async () => inner)
        }

        const result = await callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: gateway.id,
            method
          }),
          ctxFixture(transport)
        )

        expect(result).toEqual({
          response: inner,
          _meta: { gatewayEnvironmentId: gateway.id }
        })
        expect(transport.call).toHaveBeenCalledWith(gateway.id, method, undefined)
      }
    })

    it('refuses methods outside the phase-1 allowlist without dialing, even unknown spellings', async () => {
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })

      await expect(
        callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: 'no-such-env',
            method: 'terminal.streamMakeCoffee'
          }),
          ctxFixture(idleTransport())
        )
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: runtimeEnvironmentRelayPhase1AllowlistMessage('terminal.streamMakeCoffee')
      })
    })

    it('refuses an unknown gatewayEnvironmentId as invalid argument', async () => {
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })

      await expect(
        callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: 'env-ghost',
            method: 'repo.list'
          }),
          ctxFixture(idleTransport())
        )
      ).rejects.toThrow('Unknown gateway environment: env-ghost')
    })

    it('refuses a relay-view row id: it cannot name an upstream host from here', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      upsertDownstreamEnvironment(userDataPath, {
        gatewayEnvironmentId: 'env-nested',
        name: 'nested',
        upstreamRuntimeId: null,
        offer: getPreferredPairingOffer(gateway)
      })

      await expect(
        callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: 'env-nested',
            method: 'repo.list'
          }),
          ctxFixture(idleTransport())
        )
      ).rejects.toThrow('Unknown gateway environment: env-nested')
    })

    it('answers a lost dial with a remote_runtime_unavailable envelope instead of throwing', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const transport: OrchestrationEnvironmentTransport = {
        resolve: () => {
          throw new Error('not used')
        },
        call: vi.fn(async () => {
          throw new Error('socket closed mid-handler')
        })
      }

      const result = await callMethod.handler(
        RuntimeEnvironmentGatewayCallParamsSchema.parse({
          gatewayEnvironmentId: gateway.id,
          method: 'repo.list'
        }),
        ctxFixture(transport)
      )

      expect(result.response).toEqual({
        id: 'repo.list',
        ok: false,
        error: {
          code: 'remote_runtime_unavailable',
          message: 'socket closed mid-handler'
        }
      })
    })

    it('answers a missing transport with the relay-unavailable envelope, not a throw', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })

      const result = await callMethod.handler(
        RuntimeEnvironmentGatewayCallParamsSchema.parse({
          gatewayEnvironmentId: gateway.id,
          method: 'repo.list'
        }),
        ctxFixture(null)
      )

      // One failure road at the gateway boundary: whatever this host's own
      // transport refused to answer with rides as the inner envelope.
      expect(result.response).toEqual({
        id: 'repo.list',
        ok: false,
        error: {
          code: 'remote_runtime_unavailable',
          message: 'runtime_unavailable'
        }
      })
    })
  })

  describe('runtimeEnvironment.downstream.subscribe', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const noBinary = (): void => {}

    function subscribeParams(gatewayEnvironmentId: string, method = 'terminal.multiplex') {
      return RuntimeEnvironmentGatewaySubscribeParamsSchema.parse({ gatewayEnvironmentId, method })
    }

    function dialReturns(subscription: FakeSubscription, dialArgs: GatewayDialCapture[]): void {
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
    }

    function pokeBinary(
      binaryUp: ((bytes: Uint8Array<ArrayBufferLike>) => void) | null,
      bytes: Uint8Array<ArrayBufferLike>
    ): void {
      if (!binaryUp) {
        throw new Error('the bridge never registered its raw binary handler')
      }
      binaryUp(bytes)
    }

    const REGISTRY_KEY = `runtime-environment.downstream.subscribe:${Conn_ID}`

    it('bridges terminal.multiplex: events and PTY bytes cross both directions verbatim', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const subscription = fakeSubscription()
      const dialArgs: GatewayDialCapture[] = []
      dialReturns(subscription, dialArgs)
      const registry = new Map<string, () => void>()
      const outboundBinary: Uint8Array<ArrayBufferLike>[] = []
      const emitted = emitCollector()
      let binaryUp: ((bytes: Uint8Array<ArrayBufferLike>) => void) | null = null
      const ctx = subscribeCtxFixture({
        registry,
        outboundBinary,
        attachBinaryHandler: (handler) => {
          binaryUp = handler
        }
      })

      const handler = subscribeMethod.handler(subscribeParams(gateway.id), ctx, emitted.emit)
      // The dial resolves on outer-socket auth, before any ready/response event.
      await flush()
      expect(dialArgs[0]?.method).toBe('terminal.multiplex')
      const ready = {
        type: 'response',
        response: {
          id: 'o1',
          ok: true,
          result: { type: 'ready' },
          _meta: { runtimeId: 'runtime-upstream' }
        }
      }
      dialArgs[0]?.callbacks.onEvent(ready)

      // Guest input bytes ride the raw binary channel into the upstream sendBinary.
      const guestBytes = new Uint8Array([
        0x74, 1, 9, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 97, 98, 99
      ])
      pokeBinary(binaryUp, guestBytes)
      expect(subscription.sendBinary).toHaveBeenCalledWith(guestBytes)

      // Upstream PTY output crosses to the guest socket byte-verbatim.
      const ptyBytes = new Uint8Array([0x74, 1, 8, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 104, 105])
      dialArgs[0]?.callbacks.onEvent({ type: 'binary', bytes: ptyBytes })
      expect(outboundBinary).toEqual([ptyBytes])

      expect(emitted.events).toEqual([ready])
      expect(registry.get(REGISTRY_KEY)).toBeTypeOf('function')
      dialArgs[0]?.callbacks.onEvent({ type: 'close' })
      await handler
      // The registry keeps the entry; socket teardown re-runs the latched cleanup.
      expect(registry.has(REGISTRY_KEY)).toBe(true)
      expect(subscription.close).toHaveBeenCalledOnce()
    })

    it('forwards the upstream close as an end event and closes the bridged subscription exactly once', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const subscription = fakeSubscription()
      const dialArgs: GatewayDialCapture[] = []
      dialReturns(subscription, dialArgs)
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary
      })

      const handler = subscribeMethod.handler(subscribeParams(gateway.id), ctx, emitted.emit)
      dialArgs[0]?.callbacks.onEvent({ type: 'close' })
      await handler
      expect(emitted.events).toEqual([{ type: 'end' }])
      expect(subscription.close).toHaveBeenCalledOnce()
      // The registry keeps the entry so socket teardown can re-run the idempotent cleanup.
    })

    it('refuses non-forwardable methods with the shared refusal wording and never dials', async () => {
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary
      })

      await expect(
        subscribeMethod.handler(subscribeParams('gateway box', 'browser.open'), ctx, emitted.emit)
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: runtimeEnvironmentRelayPhase1AllowlistMessage('browser.open')
      })
      expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
    })

    it('lets phase-1 reads ride the stream fence too; only the upstream substrate rejects them', async () => {
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const dialArgs: GatewayDialCapture[] = []
      dialReturns(fakeSubscription(), dialArgs)
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary
      })

      const handler = subscribeMethod.handler(
        subscribeParams('gateway box', 'repo.list'),
        ctx,
        emitted.emit
      )
      await flush()
      expect(dialArgs[0]?.method).toBe('repo.list')
      dialArgs[0]?.callbacks.onEvent({ type: 'close' })
      await handler
    })

    it('refuses sockets without the raw binary channel, matching terminal.multiplex', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary,
        bareSocket: true
      })

      await expect(
        subscribeMethod.handler(subscribeParams(gateway.id), ctx, emitted.emit)
      ).rejects.toThrow('binary_terminal_stream_required')
      expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
    })

    it('refuses a socket that died before the bridge dial', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary,
        aborted: true
      })

      await expect(
        subscribeMethod.handler(subscribeParams(gateway.id), ctx, emitted.emit)
      ).resolves.toBeUndefined()
      expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
    })

    it('socket teardown through the registry closes the bridged upstream subscription', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      const subscription = fakeSubscription()
      const dialArgs: GatewayDialCapture[] = []
      dialReturns(subscription, dialArgs)
      const emitted = emitCollector()
      const registry = new Map<string, () => void>()
      const ctx = subscribeCtxFixture({
        registry,
        outboundBinary: [],
        attachBinaryHandler: noBinary
      })

      const handler = subscribeMethod.handler(subscribeParams(gateway.id), ctx, emitted.emit)
      await flush()
      const cleanup = registry.get(REGISTRY_KEY)
      cleanup?.()
      await handler
      // Extra teardown sweeps (socket death, unsubscribe) re-run the latched cleanup harmlessly.
      cleanup?.()
      expect(subscription.close).toHaveBeenCalledOnce()
    })

    it('refuses a relay-view row id like the call vehicle does', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })
      upsertDownstreamEnvironment(userDataPath, {
        gatewayEnvironmentId: 'env-nested',
        name: 'nested',
        upstreamRuntimeId: null,
        offer: getPreferredPairingOffer(gateway)
      })
      const emitted = emitCollector()
      const ctx = subscribeCtxFixture({
        registry: new Map(),
        outboundBinary: [],
        attachBinaryHandler: noBinary
      })

      await expect(
        subscribeMethod.handler(subscribeParams('env-nested'), ctx, emitted.emit)
      ).rejects.toThrow('Unknown gateway environment: env-nested')
      expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
    })
  })
})
