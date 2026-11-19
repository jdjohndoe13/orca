import { describe, expect, it, vi } from 'vitest'

import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import type { RpcSuccess } from '../rpc/rpc-wire-types'

function readyReply(id: string): RpcSuccess {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId: 'sub-1' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('MobileRelayRpcStreams failure parity', () => {
  it('does not emit a failure after the caller cancels a queued stream', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const connection = Promise.withResolvers<void>()
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => connection.promise
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    cancel()
    connection.reject(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame).not.toHaveBeenCalled()
  })

  it('does not send or emit after session clear settles a connection wait', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const connection = Promise.withResolvers<void>()
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => connection.promise
    })
    streams.subscribe('session.tabs.subscribe', { worktree: 'id:worktree-1' }, listener)
    streams.clear()
    connection.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame).not.toHaveBeenCalled()
  })
})

describe('MobileRelayRpcStreams gateway bridge', () => {
  const bridgeMethod = 'runtimeEnvironment.downstream.subscribe'
  const bridgeParams = {
    gatewayEnvironmentId: 'env-1',
    method: 'terminal.subscribe',
    params: { terminal: 'term-1', viewport: { cols: 45, rows: 20 } }
  }

  function bridge() {
    const events: unknown[] = []
    let id = 0
    const frames: { id: string; method: string; params?: unknown }[] = []
    const streams = new MobileRelayRpcStreams({
      nextId: () => `stream-${++id}`,
      sendFrame: (frame) => {
        frames.push(frame)
        return true
      },
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(bridgeMethod, bridgeParams, (event) => events.push(event))
    return { events, streams, cancel, frames }
  }

  function bridgeEvent(id: string, response: unknown): RpcSuccess {
    return {
      id,
      ok: true,
      streaming: true,
      result: { type: 'response', response },
      _meta: { runtimeId: 'runtime-1' }
    }
  }

  function bridgeEnd(id: string): RpcSuccess {
    return {
      id,
      ok: true,
      streaming: true,
      result: { type: 'end' },
      _meta: { runtimeId: 'runtime-1' }
    }
  }

  it('delivers the unwrapped subscribed event to the listener', async () => {
    const { events, streams } = bridge()
    await Promise.resolve()

    expect(
      streams.handleResponse(
        bridgeEvent('stream-1', {
          id: 'in-1',
          ok: true,
          result: { type: 'subscribed', streamId: 9 }
        })
      )
    ).toBe(true)
    expect(events).toEqual([{ type: 'subscribed', streamId: 9 }])
  })

  it('peels the envelope for every event shape and drops keepalives', async () => {
    const { events, streams } = bridge()
    await Promise.resolve()

    streams.handleResponse(
      bridgeEvent('stream-1', { id: 'in-1', ok: true, result: { type: 'metadata', cwd: '/x' } })
    )
    streams.handleResponse(bridgeEvent('stream-1', { id: 'in-2', ok: true, _keepalive: true }))
    streams.handleResponse(bridgeEnd('stream-1'))

    expect(events).toEqual([{ type: 'metadata', cwd: '/x' }, { type: 'end' }])
  })

  it('ends the stream with the upstream refusal message', async () => {
    const { events, streams } = bridge()
    await Promise.resolve()

    streams.handleResponse(
      bridgeEvent('stream-1', {
        id: 'in-1',
        ok: false,
        error: { code: 'forbidden', message: 'upstream refusal' }
      })
    )

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: 'upstream refusal' })
    ])
  })

  it('releases the bridge by the request id that opened it on cancel', async () => {
    const { cancel, frames, streams } = bridge()
    await Promise.resolve()

    cancel()

    expect(frames[1]).toMatchObject({
      method: 'runtimeEnvironment.downstream.unsubscribe',
      params: { requestId: 'stream-1' }
    })
    // The release is request-addressed, so a same-slot sibling never fences it.
    expect(streams.handleResponse(readyReply('stream-1'))).toBe(false)
  })

  it('evicts the live local stream when a bridge takes the socket', async () => {
    const events: unknown[] = []
    let id = 0
    const streams = new MobileRelayRpcStreams({
      nextId: () => `stream-${++id}`,
      sendFrame: () => true,
      waitForConnected: async () => {}
    })
    streams.subscribe(
      'terminal.subscribe',
      { terminal: 'term-local', client: { id: 'phone', type: 'mobile' } },
      (event) => events.push(event)
    )
    await Promise.resolve()
    streams.handleResponse({
      id: 'stream-1',
      ok: true,
      streaming: true,
      result: { type: 'subscribed', streamId: 3 },
      _meta: { runtimeId: 'runtime-1' }
    } satisfies RpcSuccess)

    streams.subscribe(bridgeMethod, bridgeParams, () => {})
    await Promise.resolve()

    expect(events).toEqual([{ type: 'subscribed', streamId: 3 }, { type: 'end' }])
  })
})
