import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX,
  RuntimeEnvironmentGatewayCallParamsSchema,
  RuntimeEnvironmentGatewaySubscribeParamsSchema
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { downstreamEnvironmentId } from '../../../../shared/runtime-environment-downstream-rows'
import { addEnvironmentFromPairingCode } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/federation/environment-transport'
import type { RpcContext } from '../core'
import { rewriteRelayCallParams } from './runtime-environment-relay-param-rewrite'
import {
  RUNTIME_ENVIRONMENT_GATEWAY_CALL_METHOD_DEF as callMethod,
  RUNTIME_ENVIRONMENT_GATEWAY_SUBSCRIBE_METHOD_DEF as subscribeMethod
} from './runtime-environment-gateway-methods'

const { subscribeRuntimeEnvironmentMock } = vi.hoisted(() => ({
  subscribeRuntimeEnvironmentMock: vi.fn()
}))
vi.mock('../../../ipc/runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: subscribeRuntimeEnvironmentMock
}))

function ownCode(error: unknown): unknown {
  if (error instanceof Error) {
    // `code` is an own property (assigned, not a prototype getter), so the own
    // entries view reads it off without a type assertion.
    return Object.fromEntries(Object.entries(error))['code']
  }
  return undefined
}

function thrownBy(params: unknown): { code: unknown; message: string } {
  try {
    rewriteRelayCallParams('worktree.rm', params, 'relay-env-1')
    throw new Error('the rewriter let a smuggled host id through')
  } catch (error) {
    return { code: ownCode(error), message: error instanceof Error ? error.message : '' }
  }
}

const ensureParams = (executionHostId: string): Record<string, unknown> => ({
  location: {
    executionHostId,
    wslDistro: null,
    workspaceId: 'ws-1',
    workspaceKind: 'git-worktree' as const
  }
})

describe('rewriteRelayCallParams', () => {
  it('drops a self-row top-level hostId: the guest means this environment itself', () => {
    const params = { name: 'wta', hostId: toRuntimeExecutionHostId('relay-env-1') }
    expect(rewriteRelayCallParams('worktree.rm', params, 'relay-env-1')).toEqual({ name: 'wta' })
  })

  it('rewrites a self-row location.executionHostId to local', () => {
    const params = ensureParams(toRuntimeExecutionHostId('relay-env-1'))
    expect(rewriteRelayCallParams('agentSession.ensure', params, 'relay-env-1')).toEqual(
      ensureParams(LOCAL_EXECUTION_HOST_ID)
    )
  })

  it('keeps local and ssh host ids verbatim and never copies untouched params', () => {
    const withLocal = { name: 'wta', hostId: LOCAL_EXECUTION_HOST_ID }
    const withSsh = { name: 'wta', hostId: 'ssh:web-box' }
    expect(rewriteRelayCallParams('worktree.rm', withLocal, 'relay-env-1')).toBe(withLocal)
    expect(rewriteRelayCallParams('worktree.rm', withSsh, 'relay-env-1')).toBe(withSsh)
    const hostFree = { depth: 1 }
    expect(rewriteRelayCallParams('repo.list', hostFree, 'relay-env-1')).toBe(hostFree)
    expect(rewriteRelayCallParams('repo.list', undefined, 'relay-env-1')).toBeUndefined()
  })

  it.each([
    ['top-level hostId', { name: 'wta', hostId: 'runtime:neighboring-env' }],
    ['location.executionHostId', ensureParams('runtime:neighboring-env')],
    ['unparseable spelling', { name: 'wta', hostId: 'seven' }],
    ['unparseable location', ensureParams('seven')]
  ])('refuses a foreign or junk %s with the shared forbidden error', (_title, params) => {
    const thrown = thrownBy(params)
    expect(thrown.code).toBe('forbidden')
    expect(thrown.message.startsWith(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)).toBe(true)
  })

  it('walks shallowly: nested hosts that are not location.executionHostId stay untouched', () => {
    const params = {
      deeper: { hostId: toRuntimeExecutionHostId('neighboring-env') },
      location: { workspaceId: 'ws-1', workspaceKind: 'folder' as const }
    }
    expect(rewriteRelayCallParams('worktree.rm', params, 'relay-env-1')).toBe(params)
  })
})

// Gateway wiring: the rewriter runs inside the vehicles, right where the dial happens.
describe('runtime-environment-relay-param-rewrite gateway wiring', () => {
  const tempDirs: string[] = []
  let userDataPath = ''

  beforeEach(() => {
    subscribeRuntimeEnvironmentMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-param-rewrite-'))
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

  function callCtxFixture(transport: OrchestrationEnvironmentTransport | null): RpcContext {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture satisfies the three fences and the transport getter the call handler reads.
    return {
      clientKind: 'runtime',
      runtime: {
        getRuntimeId: () => 'runtime-gateway',
        getOrchestrationEnvironmentTransport: () => transport
      }
    } as unknown as RpcContext
  }

  function guardCtxFixture(): RpcContext {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture satisfies the relay-scope fence; the smuggle guard throws before anything else is read.
    return { clientKind: 'runtime' } as unknown as RpcContext
  }

  function pairingCodeFixture(endpoint = 'ws://10.0.0.1:6768'): string {
    return encodePairingOffer({
      v: 2,
      endpoint,
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    })
  }

  function gatewayFrom(pairingCode: string): { id: string } {
    return addEnvironmentFromPairingCode(userDataPath, {
      name: 'gateway box',
      pairingCode
    })
  }

  const selfHostIdFrom = (gatewayEnvironmentId: string): string =>
    toRuntimeExecutionHostId(downstreamEnvironmentId(gatewayEnvironmentId))

  function dialCapturingTransport(): {
    transport: OrchestrationEnvironmentTransport
    captures: { selector: string; method: string; params: unknown }[]
  } {
    const captures: { selector: string; method: string; params: unknown }[] = []
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => {
        throw new Error('not used by this method')
      },
      call: async (selector, method, params) => {
        captures.push({ selector, method, params })
        return {
          id: 'req-1',
          ok: true,
          result: {},
          _meta: { runtimeId: 'runtime-upstream' }
        }
      }
    }
    return { transport, captures }
  }

  it('dials the rewriter output: self ids translated, remote answering verbatim', async () => {
    const gateway = gatewayFrom(pairingCodeFixture('ws://10.0.0.1:6768'))
    const { transport, captures } = dialCapturingTransport()

    await callMethod.handler(
      RuntimeEnvironmentGatewayCallParamsSchema.parse({
        gatewayEnvironmentId: gateway.id,
        method: 'worktree.rm',
        params: { name: 'wta', hostId: selfHostIdFrom(gateway.id) }
      }),
      callCtxFixture(transport)
    )
    await callMethod.handler(
      RuntimeEnvironmentGatewayCallParamsSchema.parse({
        gatewayEnvironmentId: gateway.id,
        method: 'agentSession.ensure',
        params: {
          location: {
            executionHostId: selfHostIdFrom(gateway.id),
            wslDistro: null,
            workspaceId: 'ws-1',
            workspaceKind: 'git-worktree'
          }
        }
      }),
      callCtxFixture(transport)
    )

    expect(captures[0]?.selector).toBe(gateway.id)
    expect(captures[0]?.params).toEqual({ name: 'wta' })
    expect(captures[1]?.params).toEqual({
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    })
  })

  it('refuses a host id naming a different environment with the shared wording, never dialing', async () => {
    const gateway = gatewayFrom(pairingCodeFixture('ws://10.0.0.1:6768'))
    const { transport, captures } = dialCapturingTransport()

    await expect(
      callMethod.handler(
        RuntimeEnvironmentGatewayCallParamsSchema.parse({
          gatewayEnvironmentId: gateway.id,
          method: 'worktree.rm',
          params: { name: 'wta', hostId: 'runtime:neighboring-env' }
        }),
        callCtxFixture(transport)
      )
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)
    })
    // `call` is a plain implementer function here; never dialed means zero captures.
    expect(captures).toEqual([])
  })

  it('refuses stream params carrying host ids: the bridge forwards verbatim or not at all', async () => {
    const gateway = gatewayFrom(pairingCodeFixture('ws://10.0.0.1:6768'))
    const emit = (result: unknown): void => {
      throw new Error(`the smuggle guard let a dial through: ${JSON.stringify(result)}`)
    }
    for (const executionHostId of [
      // A self-row spelling would be rewritten on the call vehicle; on the
      // stream vehicle any host id is smuggled.
      selfHostIdFrom(gateway.id),
      'runtime:neighboring-env'
    ]) {
      await expect(
        subscribeMethod.handler(
          RuntimeEnvironmentGatewaySubscribeParamsSchema.parse({
            gatewayEnvironmentId: gateway.id,
            method: 'terminal.multiplex',
            params: { location: { executionHostId } }
          }),
          guardCtxFixture(),
          emit
        )
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)
      })
      expect(subscribeRuntimeEnvironmentMock).not.toHaveBeenCalled()
    }
  })
})
