import { describe, expect, it, vi } from 'vitest'
import { forwardedRuntimeCall, forwardOrLocal } from './mobile-remote-runtime-forwarded-call'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

function port(
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
): UnvalidatedRpcRequestPort {
  return { sendRequest }
}

describe('forwardedRuntimeCall', () => {
  it('sends the vehicle and unwraps the forwarded reply', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'call-1',
      ok: true,
      result: { response: { id: 'r', ok: true, result: { terminals: [] } } }
    }))
    const response = await forwardedRuntimeCall(port(sendRequest), 'env-1', 'terminal.list', {
      worktree: 'id:x'
    })
    expect(sendRequest).toHaveBeenCalledWith('runtimeEnvironment.call', {
      gatewayEnvironmentId: 'env-1',
      method: 'terminal.list',
      params: { worktree: 'id:x' }
    })
    expect(response).toEqual({ id: 'call-1', ok: true, result: { terminals: [] } })
  })

  it('degrades every refusal to remote_runtime_unavailable', async () => {
    const payloads: unknown[] = [
      { response: { id: 'r', ok: false, error: { code: 'nope', message: 'down' } } },
      { response: undefined },
      undefined
    ]
    for (const payload of payloads) {
      const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
        id: 'call-1',
        ok: true,
        result: payload
      }))
      const response = await forwardedRuntimeCall(port(sendRequest), 'env-1', 'terminal.send', {})
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
    const response = await forwardedRuntimeCall(
      port(sendRequest),
      'env-1',
      'terminal.clearBuffer',
      {}
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('remote_runtime_unavailable')
    }
  })
})

describe('forwardOrLocal', () => {
  it('runs the relay call for a mirrored row', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'c',
      ok: true,
      result: { response: { id: 'r', ok: true, result: { updated: true } } }
    }))
    const local = vi.fn()
    const response = await forwardOrLocal(
      port(sendRequest),
      { mode: 'relay', gatewayEnvironmentId: 'env-1' },
      'terminal.updateViewport',
      { terminal: 't' },
      local
    )
    expect(local).not.toHaveBeenCalled()
    expect(response.ok).toBe(true)
  })

  it('runs the local request for a local row', async () => {
    const sendRequest = vi.fn()
    const localResponse = { id: 'l', ok: true as const, result: { terminals: [] } }
    const local = vi.fn(async () => localResponse)
    const response = await forwardOrLocal(port(sendRequest), null, 'terminal.list', {}, local)
    expect(sendRequest).not.toHaveBeenCalled()
    expect(response).toBe(localResponse)
  })

  it('keeps the local path for a pending stamp', async () => {
    // The pending park belongs to the tab controller, not the per-call helper:
    // a mirrored row whose stamp has not resolved yet just keeps its old
    // local behaviour — the gateway refuses the unknown worktree, the caller's
    // skip policy keeps the old state, and the stamp landing re-runs the read.
    const sendRequest = vi.fn()
    const local = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'l',
      ok: false,
      error: { code: 'forbidden', message: 'nope' }
    }))
    const response = await forwardOrLocal(
      port(sendRequest),
      { mode: 'pending' },
      'terminal.list',
      {},
      local
    )
    expect(sendRequest).not.toHaveBeenCalled()
    expect(local).toHaveBeenCalledOnce()
    expect(response.ok).toBe(false)
  })
})
