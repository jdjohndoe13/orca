import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import type { ConnectionState, RpcResponse } from './types'

type SentRequest = {
  id: string
  method: string
  params?: unknown
}

function createRegistry(initialState: ConnectionState = 'connected') {
  const sent: SentRequest[] = []
  let state = initialState
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    deviceToken: 'device-token',
    getState: () => state,
    sendEncrypted: (request) => {
      if (state !== 'connected') {
        return false
      }
      sent.push(request as SentRequest)
      return true
    }
  })
  return {
    registry,
    sent,
    setState(next: ConnectionState) {
      state = next
    }
  }
}

function streamingResponse(id: string, result: unknown): RpcResponse {
  return {
    id,
    ok: true,
    streaming: true,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}

function terminalOutput(streamId: number, chunk: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(chunk)
  })
}

describe('RpcClientStreamRegistry', () => {
  it('replays the latest terminal viewport without retaining stale stream routing', () => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    registry.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 45, rows: 20 } },
      (event) => events.push(event)
    )
    const first = sent[0]!
    registry.handleResponse(streamingResponse(first.id, { type: 'subscribed', streamId: 7 }))
    registry.handleBinary(terminalOutput(7, 'before'))

    registry.updateTerminalViewport('term-1', { cols: 60, rows: 24 })
    registry.markForReplay()
    registry.replayAfterAuthentication()
    registry.handleBinary(terminalOutput(7, 'stale'))

    expect(sent[1]).toMatchObject({
      id: first.id,
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 60, rows: 24 } }
    })
    expect(events).toEqual([
      { type: 'subscribed', streamId: 7 },
      { type: 'data', streamId: 7, chunk: 'before' }
    ])
  })

  it.each([
    ['a streamed end', (id: string) => streamingResponse(id, { type: 'end' })],
    [
      'a final end reply',
      (id: string): RpcResponse => ({
        id,
        ok: true,
        result: { type: 'end' },
        _meta: { runtimeId: 'runtime-1' }
      })
    ],
    [
      'an error reply',
      (id: string): RpcResponse => ({
        id,
        ok: false,
        error: { code: 'runtime_error', message: 'failed' },
        _meta: { runtimeId: 'runtime-1' }
      })
    ]
  ])('sends no terminal unsubscribe when the listener disposes on %s', (_label, ending) => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    let dispose = (): void => {}
    dispose = registry.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', client: { id: 'phone', type: 'mobile' } },
      (event) => {
        events.push(event)
        // The session hook disposes synchronously on end/error; a slot-named unsubscribe here
        // would retire a newer same-slot stream on the host.
        dispose()
      }
    )
    const request = sent[0]!

    registry.handleResponse(ending(request.id))
    dispose()

    expect(events).toHaveLength(1)
    expect(sent).toEqual([request])
    expect(registry.size()).toBe(0)
  })

  it('does not replay a terminal stream the host already ended', () => {
    const { registry, sent, setState } = createRegistry()
    registry.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', client: { id: 'phone' } },
      () => {}
    )
    const request = sent[0]!
    registry.handleResponse(streamingResponse(request.id, { type: 'subscribed', streamId: 7 }))
    registry.handleResponse(streamingResponse(request.id, { type: 'end' }))

    setState('connecting')
    registry.markForReplay()
    setState('connected')
    registry.replayAfterAuthentication()

    expect(sent).toEqual([request])
  })

  it('unsubscribes a session tabs stream by its own request id', () => {
    const { registry, sent } = createRegistry()
    const disposeOlder = registry.subscribe(
      'session.tabs.subscribe',
      { worktree: 'wt-1' },
      () => {}
    )
    registry.subscribe('session.tabs.subscribe', { worktree: 'wt-1' }, () => {})
    const [older, newer] = sent
    registry.handleResponse(streamingResponse(older!.id, { type: 'snapshot', tabs: [] }))

    disposeOlder()

    // Without the request id the host sweeps every stream for the worktree, including the newer one.
    expect(sent[2]).toMatchObject({
      method: 'session.tabs.unsubscribe',
      params: { worktree: 'wt-1', subscriptionId: older!.id }
    })
    expect(newer!.id).not.toBe(older!.id)
    expect(sent).toHaveLength(3)
  })

  it('holds a session tabs unsubscribe until the host registers the stream', () => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    const dispose = registry.subscribe('session.tabs.subscribe', { worktree: 'wt-1' }, (event) =>
      events.push(event)
    )
    const subscribe = sent[0]!

    dispose()
    // Older hosts register only as they emit the first snapshot, so an earlier unsubscribe finds nothing.
    expect(sent).toHaveLength(1)

    registry.handleResponse(streamingResponse(subscribe.id, { type: 'snapshot', tabs: [] }))

    expect(sent[1]).toMatchObject({
      method: 'session.tabs.unsubscribe',
      params: { worktree: 'wt-1', subscriptionId: subscribe.id }
    })
    // A host that registered on arrival ends the stream; that end must not unsubscribe again.
    registry.handleResponse(streamingResponse(subscribe.id, { type: 'end' }))
    expect(sent).toHaveLength(2)
    expect(events).toEqual([])
    expect(registry.size()).toBe(0)
  })

  it.each([
    ['browser.screencast', 'browser.screencast.unsubscribe', { page: 'page-1' }],
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe', null],
    ['notifications.subscribe', 'notifications.unsubscribe', null],
    ['accounts.subscribe', 'accounts.unsubscribe', null],
    ['session.tabs.subscribe', 'session.tabs.unsubscribe', { worktree: 'wt-1' }]
  ])(
    'releases canceled %s callbacks while preserving late host cleanup',
    (method, cleanup, params) => {
      const { registry, sent } = createRegistry()
      const events: unknown[] = []
      const listener = (event: unknown) => events.push(event)
      const onBinaryFrame = () => events.push('binary')
      for (let index = 0; index < 64; index++) {
        registry.subscribe(method, params, listener, { onBinaryFrame })()
      }

      // Check the actual retaining roots: canceled starts can return without any reply.
      const registryState: unknown = registry
      if (
        typeof registryState !== 'object' ||
        registryState === null ||
        !('streams' in registryState)
      ) {
        throw new Error('Stream registry has no inspectable retaining map')
      }
      const streams = registryState.streams
      if (!(streams instanceof Map)) {
        throw new Error('Stream registry has no inspectable retaining map')
      }
      expect(streams.size).toBe(64)
      for (const entry of streams.values()) {
        const stream: unknown = entry
        if (
          typeof stream !== 'object' ||
          stream === null ||
          !('cancelled' in stream) ||
          !('listener' in stream) ||
          !('onBinaryFrame' in stream)
        ) {
          throw new Error('Stream registry has no inspectable retained callbacks')
        }
        expect(stream.cancelled).toBe(true)
        expect(stream.listener).toBeUndefined()
        expect(stream.onBinaryFrame).toBeUndefined()
      }

      const requests = [...sent]
      for (const request of requests) {
        registry.handleResponse(
          streamingResponse(
            request.id,
            method === 'session.tabs.subscribe'
              ? { type: 'snapshot', tabs: [] }
              : { type: 'ready', subscriptionId: `host:${request.id}` }
          )
        )
      }

      expect(events).toEqual([])
      expect(registry.size()).toBe(0)
      expect(
        sent.filter((request) => request.method === cleanup).map((request) => request.params)
      ).toEqual(
        requests.map((request) =>
          method === 'session.tabs.subscribe'
            ? { worktree: 'wt-1', subscriptionId: request.id }
            : { subscriptionId: `host:${request.id}` }
        )
      )
    }
  )

  describe.each([
    ['browser.screencast', 'browser.screencast.unsubscribe', { page: 'page-1' }],
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe', null],
    ['notifications.subscribe', 'notifications.unsubscribe', null],
    ['accounts.subscribe', 'accounts.unsubscribe', null],
    ['session.tabs.subscribe', 'session.tabs.unsubscribe', { worktree: 'wt-1' }]
  ])('canceled %s delivery', (method, cleanup, params) => {
    it('ignores late scrollback and terminal registration while waiting for host cleanup', () => {
      const { registry, sent } = createRegistry()
      const events: unknown[] = []
      registry.subscribe(method, params, (event) => events.push(event))()
      const request = sent[0]!

      expect(
        registry.handleResponse({
          id: request.id,
          ok: true,
          result: { type: 'scrollback', serialized: 'late' }
        })
      ).toBe(true)
      registry.handleResponse(streamingResponse(request.id, { type: 'subscribed', streamId: 41 }))
      registry.handleBinary(terminalOutput(41, 'late'))
      expect(events).toEqual([])
      expect(registry.size()).toBe(1)
      expect(sent).toHaveLength(1)

      registry.handleResponse(
        streamingResponse(
          request.id,
          method === 'session.tabs.subscribe'
            ? { type: 'snapshot', tabs: [] }
            : { type: 'ready', subscriptionId: 'late-host-id' }
        )
      )
      expect(sent[1]).toMatchObject({
        method: cleanup,
        params:
          method === 'session.tabs.subscribe'
            ? { worktree: 'wt-1', subscriptionId: request.id }
            : { subscriptionId: 'late-host-id' }
      })
      expect(registry.size()).toBe(0)
      expect(events).toEqual([])
    })

    it('does not replay a canceled opener queued before connection', () => {
      const { registry, sent, setState } = createRegistry('connecting')
      const events: unknown[] = []
      const dispose = registry.subscribe(method, params, (event) => events.push(event))

      dispose()
      dispose()
      registry.markForReplay()
      setState('connected')
      registry.replayAfterAuthentication()

      expect(sent).toEqual([])
      expect(events).toEqual([])
      expect(registry.size()).toBe(0)
    })
  })

  it('holds a session tabs unsubscribe again after a reconnect replays the stream', () => {
    const { registry, sent } = createRegistry()
    const dispose = registry.subscribe('session.tabs.subscribe', { worktree: 'wt-1' }, () => {})
    const subscribe = sent[0]!
    registry.handleResponse(streamingResponse(subscribe.id, { type: 'snapshot', tabs: [] }))

    registry.markForReplay()
    registry.replayAfterAuthentication()
    dispose()

    expect(sent.map((request) => request.method)).toEqual([
      'session.tabs.subscribe',
      'session.tabs.subscribe'
    ])
    registry.handleResponse(streamingResponse(subscribe.id, { type: 'snapshot', tabs: [] }))
    expect(sent[2]).toMatchObject({
      method: 'session.tabs.unsubscribe',
      params: { worktree: 'wt-1', subscriptionId: subscribe.id }
    })
  })

  it('drops a held session tabs unsubscribe when the subscribe fails or reconnects first', () => {
    const { registry, sent } = createRegistry()
    const events: unknown[] = []
    const disposeFailed = registry.subscribe(
      'session.tabs.subscribe',
      { worktree: 'wt-1' },
      (event) => events.push(event)
    )
    const disposeReplayed = registry.subscribe(
      'session.tabs.subscribe',
      { worktree: 'wt-2' },
      () => {}
    )
    const failed = sent[0]!
    disposeFailed()
    disposeReplayed()

    registry.handleResponse({
      id: failed.id,
      ok: false,
      error: { code: 'worktree_not_found', message: 'Worktree not found' }
    })
    registry.markForReplay()
    registry.replayAfterAuthentication()

    expect(sent).toHaveLength(2)
    expect(events).toEqual([])
    expect(registry.size()).toBe(0)
  })

  it('ends one transcript stream on dispose and leaves a sibling on the same socket (U-03)', () => {
    const { registry, sent } = createRegistry()
    const disposeFirst = registry.subscribe('agentSession.subscribe', { sessionId: 's1' }, () => {})
    registry.subscribe('agentSession.subscribe', { sessionId: 's2' }, () => {})
    const [first] = sent

    disposeFirst()
    expect(sent.at(-1)).toMatchObject({
      method: 'agentSession.unsubscribe',
      params: { sessionId: 's1', subscriptionId: first!.id }
    })
    expect(sent.filter((request) => request.method === 'agentSession.unsubscribe')).toHaveLength(1)
  })

  it('names the terminal request it sent when unsubscribing, and keeps the slot for older hosts', () => {
    const { registry, sent } = createRegistry()
    const dispose = registry.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', client: { id: 'phone-1', type: 'mobile' } },
      () => {}
    )
    const subscribe = sent[0]!

    dispose()

    expect(sent[1]).toMatchObject({
      method: 'terminal.unsubscribe',
      params: {
        subscriptionId: 'term-1:phone-1',
        client: { id: 'phone-1' },
        requestId: subscribe.id
      }
    })
  })

  it('releases a replayed browser stream replaced by a new one before its ready', () => {
    const { registry, sent } = createRegistry()
    registry.subscribe('browser.screencast', { page: 'page-1' }, () => {})
    const replayedId = sent[0]!.id
    registry.handleResponse(
      streamingResponse(replayedId, { type: 'ready', subscriptionId: 'page-1-old-connection' })
    )

    registry.markForReplay()
    registry.replayAfterAuthentication()
    registry.subscribe('browser.screencast', { page: 'page-2' }, () => {})
    const replacementId = sent.at(-1)!.id
    registry.handleResponse(
      streamingResponse(replayedId, { type: 'ready', subscriptionId: 'page-1-new-connection' })
    )
    registry.handleResponse(
      streamingResponse(replacementId, { type: 'ready', subscriptionId: 'page-2' })
    )

    expect(
      sent
        .filter((request) => request.method === 'browser.screencast.unsubscribe')
        .map((request) => request.params)
    ).toEqual([{ subscriptionId: 'page-1-new-connection' }])
    expect(registry.size()).toBe(1)
  })

  describe.each([
    ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe', null],
    ['notifications.subscribe', 'notifications.unsubscribe', null],
    ['accounts.subscribe', 'accounts.unsubscribe', null],
    ['browser.screencast', 'browser.screencast.unsubscribe', { page: 'page-1' }]
  ])('%s ready id across a replay', (method, unsubscribeMethod, params) => {
    function unsubscribes(sent: SentRequest[]): unknown[] {
      return sent.filter((request) => request.method === unsubscribeMethod).map((r) => r.params)
    }

    function subscribeReady() {
      const harness = createRegistry()
      const dispose = harness.registry.subscribe(method, params, () => {})
      const requestId = harness.sent[0]!.id
      harness.registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'old-connection-id' })
      )
      return { ...harness, dispose, requestId }
    }

    it('releases the replayed registration when disposed before its new ready', () => {
      const { registry, sent, dispose, requestId } = subscribeReady()

      registry.markForReplay()
      registry.replayAfterAuthentication()
      dispose()
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'new-connection-id' })
      )

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'new-connection-id' }])
    })

    it('forgets the previous connection id when marked for replay', () => {
      const { registry, sent, dispose } = subscribeReady()

      registry.markForReplay()
      dispose()

      // A disposal while disconnected has nothing to name on the next connection.
      expect(unsubscribes(sent)).toEqual([])
      expect(registry.size()).toBe(0)
    })

    it('still releases a stream cancelled before its first ready', () => {
      const { registry, sent } = createRegistry()
      const dispose = registry.subscribe(method, params, () => {})
      const requestId = sent[0]!.id

      dispose()
      expect(unsubscribes(sent)).toEqual([])
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'first-id' })
      )

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'first-id' }])
      expect(registry.size()).toBe(0)
    })

    it('sends one unsubscribe however often the stream is disposed', () => {
      const { registry, sent, dispose, requestId } = subscribeReady()

      registry.markForReplay()
      registry.replayAfterAuthentication()
      dispose()
      dispose()
      registry.handleResponse(
        streamingResponse(requestId, { type: 'ready', subscriptionId: 'new-connection-id' })
      )
      dispose()

      expect(unsubscribes(sent)).toEqual([{ subscriptionId: 'new-connection-id' }])
      expect(registry.size()).toBe(0)
    })
  })

  describe('gateway bridge streams', () => {
    const bridgeMethod = 'runtimeEnvironment.downstream.subscribe'
    const bridgeParams = {
      gatewayEnvironmentId: 'env-1',
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 45, rows: 20 } }
    }

    function bridgeEvent(id: string, response: unknown): RpcResponse {
      return streamingResponse(id, { type: 'response', response })
    }

    it('routes binary through the unwrapped subscribed event', () => {
      const { registry, sent } = createRegistry()
      const events: unknown[] = []
      registry.subscribe(bridgeMethod, bridgeParams, (event) => events.push(event))
      const first = sent[0]!

      registry.handleResponse(
        bridgeEvent(first.id, { id: 'in-1', ok: true, result: { type: 'subscribed', streamId: 9 } })
      )
      registry.handleBinary(terminalOutput(9, 'remote'))

      expect(events).toEqual([
        { type: 'subscribed', streamId: 9 },
        { type: 'data', streamId: 9, chunk: 'remote' }
      ])
    })

    it('peels the bridge envelope for every event shape', () => {
      const { registry, sent } = createRegistry()
      const events: unknown[] = []
      registry.subscribe(bridgeMethod, bridgeParams, (event) => events.push(event))
      const first = sent[0]!

      registry.handleResponse(
        bridgeEvent(first.id, { id: 'in-1', ok: true, result: { type: 'metadata', cwd: '/x' } })
      )
      registry.handleResponse(bridgeEvent(first.id, { id: 'in-2', ok: true, _keepalive: true }))
      registry.handleResponse(streamingResponse(first.id, { type: 'end' }))

      expect(events).toEqual([{ type: 'metadata', cwd: '/x' }, { type: 'end' }])
      expect(registry.size()).toBe(0)
    })

    it('ends the stream with the upstream or bridge error message', () => {
      const { registry, sent } = createRegistry()
      const events: unknown[] = []
      registry.subscribe(bridgeMethod, bridgeParams, (event) => events.push(event))
      const first = sent[0]!

      registry.handleResponse(
        bridgeEvent(first.id, {
          id: 'in-1',
          ok: false,
          error: { code: 'forbidden', message: 'upstream refusal' }
        })
      )
      expect(events).toEqual([{ type: 'error', message: 'upstream refusal' }])

      const events2: unknown[] = []
      registry.subscribe(bridgeMethod, bridgeParams, (event) => events2.push(event))
      registry.handleResponse(
        streamingResponse(sent[1]!.id, { type: 'error', message: 'bridge died' })
      )
      expect(events2).toEqual([{ type: 'error', message: 'bridge died' }])
    })

    it('releases the bridge by the request id that opened it on dispose', () => {
      const { registry, sent } = createRegistry()
      const dispose = registry.subscribe(bridgeMethod, bridgeParams, () => {})
      const first = sent[0]!

      dispose()

      expect(sent[1]).toMatchObject({
        method: 'runtimeEnvironment.downstream.unsubscribe',
        params: { requestId: first.id }
      })
      expect(registry.size()).toBe(0)
    })

    it('refits the wrapped viewport for a post-reconnect resubscribe', () => {
      const { registry, sent } = createRegistry()
      registry.subscribe(bridgeMethod, bridgeParams, () => {})
      const first = sent[0]!

      registry.updateTerminalViewport('term-1', { cols: 60, rows: 24 })
      registry.markForReplay()
      registry.replayAfterAuthentication()

      expect(sent[1]).toMatchObject({
        id: first.id,
        method: bridgeMethod,
        params: {
          gatewayEnvironmentId: 'env-1',
          method: 'terminal.subscribe',
          params: { terminal: 'term-1', viewport: { cols: 60, rows: 24 } }
        }
      })
    })

    it('evicts the live local stream when a bridge takes the socket', () => {
      const { registry, sent } = createRegistry()
      const localEvents: unknown[] = []
      registry.subscribe('terminal.subscribe', { terminal: 'term-local' }, (event) =>
        localEvents.push(event)
      )
      const local = sent[0]!
      registry.handleResponse(streamingResponse(local.id, { type: 'subscribed', streamId: 3 }))

      registry.subscribe(bridgeMethod, bridgeParams, () => {})

      expect(localEvents).toEqual([{ type: 'subscribed', streamId: 3 }, { type: 'end' }])
    })

    it('evicts the bridge when a local stream takes the socket back', () => {
      const { registry, sent } = createRegistry()
      const bridgeEvents: unknown[] = []
      registry.subscribe(bridgeMethod, bridgeParams, (event) => bridgeEvents.push(event))
      const bridge = sent[0]!
      registry.handleResponse(
        bridgeEvent(bridge.id, {
          id: 'in-1',
          ok: true,
          result: { type: 'subscribed', streamId: 9 }
        })
      )

      registry.subscribe('terminal.subscribe', { terminal: 'term-local' }, () => {})

      expect(bridgeEvents).toEqual([{ type: 'subscribed', streamId: 9 }, { type: 'end' }])
    })
  })
})
