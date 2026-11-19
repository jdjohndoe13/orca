import { describe, expect, it, vi } from 'vitest'
import {
  remoteRuntimeRelayAddress,
  resolveRelayTabsSource,
  requestRemoteSessionTabsList,
  fetchSessionTabsList
} from './mobile-remote-runtime-session-tabs'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

describe('remoteRuntimeRelayAddress', () => {
  it('reads the gateway environment id off a runtime host stamp', () => {
    expect(remoteRuntimeRelayAddress('runtime:env-1')).toBe('env-1')
  })

  it('decodes an encoded environment id', () => {
    expect(remoteRuntimeRelayAddress('runtime:env%201')).toBe('env 1')
  })

  it('answers null for every non-runtime host', () => {
    expect(remoteRuntimeRelayAddress('local')).toBeNull()
    expect(remoteRuntimeRelayAddress('ssh:host%40example.com')).toBeNull()
    expect(remoteRuntimeRelayAddress('runtime:')).toBeNull()
    expect(remoteRuntimeRelayAddress(null)).toBeNull()
    expect(remoteRuntimeRelayAddress(undefined)).toBeNull()
  })
})

describe('resolveRelayTabsSource', () => {
  it('parks the tab source until the stamp resolved', () => {
    expect(resolveRelayTabsSource('runtime:env-1', false)).toEqual({ mode: 'pending' })
    expect(resolveRelayTabsSource(null, false)).toEqual({ mode: 'pending' })
  })

  it('routes a runtime-backed row through the relay', () => {
    expect(resolveRelayTabsSource('runtime:env-1', true)).toEqual({
      mode: 'relay',
      gatewayEnvironmentId: 'env-1'
    })
  })

  it('keeps a local row on the local path', () => {
    expect(resolveRelayTabsSource('local', true)).toBeNull()
    expect(resolveRelayTabsSource(null, true)).toBeNull()
  })
})

describe('requestRemoteSessionTabsList', () => {
  it('sends the tab list through the gateway call and unwraps the forwarded reply', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'call-1',
      ok: true,
      result: {
        response: { id: 'list-1', ok: true, result: { snapshotVersion: 2, tabs: ['t1'] } },
        _meta: { gatewayEnvironmentId: 'env-1' }
      }
    }))
    const client: UnvalidatedRpcRequestPort = { sendRequest }
    const response = await requestRemoteSessionTabsList(client, 'env-1', 'id:repo::wt')
    expect(sendRequest).toHaveBeenCalledWith('runtimeEnvironment.call', {
      gatewayEnvironmentId: 'env-1',
      method: 'session.tabs.list',
      params: { worktree: 'id:repo::wt' }
    })
    expect(response).toEqual({
      id: 'call-1',
      ok: true,
      result: { snapshotVersion: 2, tabs: ['t1'] }
    })
  })

  it('reads a refusal as remote_runtime_unavailable, never as an empty snapshot', async () => {
    const payloads: unknown[] = [
      { response: { id: 'l', ok: false, error: { code: 'unavailable', message: 'down' } } },
      { response: undefined },
      undefined
    ]
    for (const payload of payloads) {
      const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
        id: 'call-1',
        ok: true,
        result: payload
      }))
      const response = await requestRemoteSessionTabsList({ sendRequest }, 'env-1', 'id:repo::wt')
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error.code).toBe('remote_runtime_unavailable')
      }
    }
  })

  it('maps a failed gateway call to the same degraded code', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'call-1',
      ok: false,
      error: { code: 'forbidden', message: 'nope' }
    }))
    const response = await requestRemoteSessionTabsList({ sendRequest }, 'env-1', 'id:repo::wt')
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('remote_runtime_unavailable')
    }
  })
})

describe('fetchSessionTabsList', () => {
  it('uses the relay envelope for a relay row', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'c',
      ok: true,
      result: { response: { id: 'l', ok: true, result: { tabs: [] } } }
    }))
    const client: UnvalidatedRpcRequestPort = { sendRequest }
    await fetchSessionTabsList(client, { mode: 'relay', gatewayEnvironmentId: 'env-1' }, 'id:x')
    expect(sendRequest).toHaveBeenCalledWith('runtimeEnvironment.call', expect.anything())
  })

  it('keeps the local method for a local row', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'l',
      ok: true,
      result: { tabs: [] }
    }))
    const client: UnvalidatedRpcRequestPort = { sendRequest }
    await fetchSessionTabsList(client, null, 'id:repo::wt')
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.list', { worktree: 'id:repo::wt' })
  })
})
