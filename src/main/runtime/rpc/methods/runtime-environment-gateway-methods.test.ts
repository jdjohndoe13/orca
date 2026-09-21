import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../shared/app-environment'
import {
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  RuntimeEnvironmentDownstreamListParamsSchema,
  RuntimeEnvironmentGatewayCallParamsSchema
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { encodePairingOffer } from '../../../../shared/pairing'
import { upsertDownstreamEnvironment } from '../../../../shared/runtime-environment-downstream-rows'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import type { RpcContext } from '../core'
import {
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF as callMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_DOWNSTREAM_LIST_METHOD_DEF as listMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_METHODS
} from './runtime-environment-gateway-methods'

const { statusSnapshotsMock } = vi.hoisted(() => ({ statusSnapshotsMock: vi.fn() }))
vi.mock('../../../ipc/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusSnapshots: statusSnapshotsMock
}))

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two methods under test are reachable; each reads runtime.getRuntimeId/getOrchestrationEnvironmentTransport.
  return {
    clientKind,
    runtime: {
      getRuntimeId: () => 'runtime-gateway',
      getOrchestrationEnvironmentTransport: () => transport
    }
  } as unknown as RpcContext
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

  it('registers exactly the census and the forwarding call', () => {
    expect(RUNTIME_ENVIRONMENT_GATEWAY_METHODS.map((method) => method.name)).toEqual([
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
      RUNTIME_ENVIRONMENT_RELAY_METHOD
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

    it('refuses mobile-scope callers', async () => {
      statusSnapshotsMock.mockReturnValue([])
      await expect(
        listMethod.handler(
          RuntimeEnvironmentDownstreamListParamsSchema.parse({}),
          ctxFixture(null, 'mobile')
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
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
      ).rejects.toMatchObject({ code: 'forbidden' })
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

    it('refuses mobile-scope callers', async () => {
      const gateway = addEnvironmentFromPairingCode(userDataPath, {
        name: 'gateway box',
        pairingCode: pairingCode('ws://10.0.0.1:6768')
      })

      await expect(
        callMethod.handler(
          RuntimeEnvironmentGatewayCallParamsSchema.parse({
            gatewayEnvironmentId: gateway.id,
            method: 'repo.list'
          }),
          ctxFixture(null, 'mobile')
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
    })
  })
})
