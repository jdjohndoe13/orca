import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcSuccess } from './types'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'

function rpcFailure(id: string): RpcFailure {
  return {
    id,
    ok: false,
    error: { code: 'unsupported', message: 'Unknown method' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('MobileRelayRpcStreams failure parity', () => {
  it('emits an RPC failure exactly once before removing the stream', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()

    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(true)
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'Unknown method',
      error: { code: 'unsupported', message: 'Unknown method' }
    })
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    cancel()
    expect(sendFrame).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'an error reply',
      (streams: MobileRelayRpcStreams) => streams.handleResponse(rpcFailure('stream-1'))
    ],
    ['a send failure', () => undefined]
  ])(
    'sends no terminal unsubscribe when the listener disposes on %s',
    async (label, failStream) => {
      const sendFrame = vi.fn(() => label !== 'a send failure')
      const streams = new MobileRelayRpcStreams({
        nextId: () => 'stream-1',
        sendFrame,
        waitForConnected: async () => {}
      })
      const events: unknown[] = []
      let dispose = (): void => {}
      dispose = streams.subscribe(
        'terminal.subscribe',
        { terminal: 'term', client: { id: 'phone', type: 'mobile' } },
        (event) => {
          events.push(event)
          dispose()
        }
      )
      await Promise.resolve()
      failStream(streams)
      dispose()

      expect(events).toEqual([expect.objectContaining({ type: 'error' })])
      expect(sendFrame).toHaveBeenCalledTimes(1)
    }
  )

  it('emits a connection-wait rejection exactly once without sending or cancelling', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => true)
    const waitError = new Error('relay session closed')
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: () => Promise.reject(waitError)
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'relay session closed',
      error: waitError
    })
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    cancel()
    expect(sendFrame).not.toHaveBeenCalled()
  })

  it('emits a send failure exactly once and fences cancellation and late frames', async () => {
    const listener = vi.fn()
    const sendFrame = vi.fn(() => false)
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame,
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'session.tabs.subscribe',
      { worktree: 'id:worktree-1' },
      listener
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: 'Connection interrupted',
      error: undefined
    })
    cancel()
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    expect(sendFrame).toHaveBeenCalledTimes(1)
  })

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

  it('removes a failed stream even when its listener throws', async () => {
    const listener = vi.fn(() => {
      throw new Error('listener failed')
    })
    const streams = new MobileRelayRpcStreams({
      nextId: () => 'stream-1',
      sendFrame: () => true,
      waitForConnected: async () => {}
    })
    streams.subscribe('session.tabs.subscribe', { worktree: 'id:worktree-1' }, listener)
    await Promise.resolve()

    expect(() => streams.handleResponse(rpcFailure('stream-1'))).toThrow('listener failed')
    expect(streams.handleResponse(rpcFailure('stream-1'))).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

function readyReply(id: string): RpcSuccess {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId: 'sub-1' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('MobileRelayRpcStreams cancel fencing', () => {
  function subscribed() {
    const listener = vi.fn()
    let id = 0
    const sendFrame = vi.fn((_frame: { id: string; method: string; params?: unknown }) => true)
    const streams = new MobileRelayRpcStreams({
      nextId: () => `stream-${++id}`,
      sendFrame,
      waitForConnected: async () => {}
    })
    const cancel = streams.subscribe(
      'notifications.subscribe',
      { includeDesktopSuppressed: true },
      listener
    )
    return { listener, streams, cancel, sendFrame }
  }

  it('delivers a ready reply to a live subscription', async () => {
    const { listener, streams } = subscribed()
    await Promise.resolve()

    expect(streams.handleResponse(readyReply('stream-1'))).toBe(true)
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'ready', subscriptionId: 'sub-1' })
  })

  it('releases, without delivering, a ready reply that lands after the caller cancelled', async () => {
    const { listener, streams, cancel, sendFrame } = subscribed()
    await Promise.resolve()

    cancel()

    expect(streams.handleResponse(readyReply('stream-1'))).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame.mock.calls.map(([frame]) => frame).slice(1)).toEqual([
      { id: 'stream-2', method: 'notifications.unsubscribe', params: { subscriptionId: 'sub-1' } }
    ])
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
