import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../../src/shared/terminal/stream/terminal-stream-protocol'
import type { ConnectionState } from '../connection/connection-state'
import type { RpcResponse } from './rpc-wire-types'

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
    getState: () => state,
    sendFrame: (request) => {
      if (state !== 'connected') {
        return false
      }
      sent.push(request)
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
    registry.handleResponse(streamingResponse(first.id, { type: 'subscribed', streamId: 8 }))
    registry.handleBinary(terminalOutput(8, 'after'))
    registry.handleBinary(terminalOutput(7, 'still-stale'))

    expect(sent[1]).toMatchObject({
      id: first.id,
      method: 'terminal.subscribe',
      params: { terminal: 'term-1', viewport: { cols: 60, rows: 24 } }
    })
    expect(events).toEqual([
      { type: 'subscribed', streamId: 7 },
      { type: 'data', streamId: 7, chunk: 'before' },
      { type: 'subscribed', streamId: 8 },
      { type: 'data', streamId: 8, chunk: 'after' }
    ])
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
      registry.handleResponse(streamingResponse(sent[1]!.id, { type: 'error', message: 'bridge died' }))
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
