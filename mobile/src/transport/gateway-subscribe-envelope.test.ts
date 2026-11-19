import { describe, expect, it } from 'vitest'
import {
  TerminalVehicleArbiter,
  buildGatewayBridgeUnsubscribe,
  gatewayBridgeInnerTerminal,
  isGatewayBridgeStream,
  terminalVehicleKind,
  unwrapGatewayBridgeEvent
} from './gateway-subscribe-envelope'

describe('isGatewayBridgeStream', () => {
  it('names only the bridge vehicle', () => {
    expect(isGatewayBridgeStream('runtimeEnvironment.downstream.subscribe')).toBe(true)
    expect(isGatewayBridgeStream('terminal.subscribe')).toBe(false)
    expect(isGatewayBridgeStream(undefined)).toBe(false)
  })
})

describe('buildGatewayBridgeUnsubscribe', () => {
  it('addresses the release by the request id that opened the bridge', () => {
    expect(
      buildGatewayBridgeUnsubscribe('runtimeEnvironment.downstream.subscribe', 'req-1')
    ).toEqual({
      method: 'runtimeEnvironment.downstream.unsubscribe',
      params: { requestId: 'req-1' }
    })
  })

  it('is null for every other stream', () => {
    expect(buildGatewayBridgeUnsubscribe('terminal.subscribe', 'req-1')).toBeNull()
  })
})

describe('gatewayBridgeInnerTerminal', () => {
  it('reads the terminal through the bridge wrapper', () => {
    expect(
      gatewayBridgeInnerTerminal({
        gatewayEnvironmentId: 'env-1',
        method: 'terminal.subscribe',
        params: { terminal: 't-1' }
      })
    ).toBe('t-1')
  })

  it('is null for a non-terminal bridge or a non-object payload', () => {
    expect(
      gatewayBridgeInnerTerminal({
        gatewayEnvironmentId: 'env-1',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:x' }
      })
    ).toBeNull()
    expect(gatewayBridgeInnerTerminal({ method: 'terminal.subscribe' })).toBeNull()
    expect(gatewayBridgeInnerTerminal(null)).toBeNull()
  })
})

describe('terminalVehicleKind', () => {
  it('classifies the local subscribe, the bridge subscribe, and everything else', () => {
    expect(terminalVehicleKind('terminal.subscribe', { terminal: 't-1' })).toBe('local')
    expect(
      terminalVehicleKind('runtimeEnvironment.downstream.subscribe', {
        gatewayEnvironmentId: 'env-1',
        method: 'terminal.subscribe',
        params: { terminal: 't-1' }
      })
    ).toBe('bridge')
    expect(
      terminalVehicleKind('runtimeEnvironment.downstream.subscribe', {
        gatewayEnvironmentId: 'env-1',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:x' }
      })
    ).toBeNull()
    expect(terminalVehicleKind('session.tabs.subscribe', {})).toBeNull()
  })
})

describe('TerminalVehicleArbiter', () => {
  it('lets local streams coexist and evicts nothing on the first claim', () => {
    const arbiter = new TerminalVehicleArbiter()
    expect(arbiter.claim('local', 'a')).toEqual([])
    expect(arbiter.claim('local', 'b')).toEqual([])
  })

  it('evicts every local stream when a bridge arrives', () => {
    const arbiter = new TerminalVehicleArbiter()
    arbiter.claim('local', 'a')
    arbiter.claim('local', 'b')
    expect(arbiter.claim('bridge', 'c')).toEqual(['a', 'b'])
  })

  it('evicts the whole bridge set when a local stream arrives', () => {
    const arbiter = new TerminalVehicleArbiter()
    arbiter.claim('bridge', 'c')
    expect(arbiter.claim('local', 'a')).toEqual(['c'])
  })

  it('evicts the sibling bridge when a second bridge replaces the first', () => {
    const arbiter = new TerminalVehicleArbiter()
    arbiter.claim('bridge', 'c')
    expect(arbiter.claim('bridge', 'd')).toEqual(['c'])
  })

  it('frees the slot when the last id is forgotten', () => {
    const arbiter = new TerminalVehicleArbiter()
    arbiter.claim('bridge', 'c')
    arbiter.forget('c')
    expect(arbiter.claim('local', 'a')).toEqual([])
  })
})

describe('unwrapGatewayBridgeEvent', () => {
  it('peels the response envelope to the inner result', () => {
    expect(
      unwrapGatewayBridgeEvent({
        type: 'response',
        response: { id: 'r1', ok: true, result: { type: 'subscribed', streamId: 7 } }
      })
    ).toEqual({ kind: 'event', result: { type: 'subscribed', streamId: 7 } })
  })

  it('maps the bridge end to the stream end', () => {
    expect(unwrapGatewayBridgeEvent({ type: 'end' })).toEqual({
      kind: 'event',
      result: { type: 'end' }
    })
  })

  it('maps the bridge error to a stream error', () => {
    expect(unwrapGatewayBridgeEvent({ type: 'error', message: 'host died' })).toEqual({
      kind: 'error',
      message: 'host died'
    })
  })

  it('maps an upstream refusal to a stream error', () => {
    expect(
      unwrapGatewayBridgeEvent({
        type: 'response',
        response: { id: 'r1', ok: false, error: { code: 'forbidden', message: 'nope' } }
      })
    ).toEqual({ kind: 'error', message: 'nope' })
  })

  it('drops keepalives', () => {
    expect(
      unwrapGatewayBridgeEvent({
        type: 'response',
        response: { id: 'r1', ok: true, _keepalive: true }
      })
    ).toEqual({ kind: 'keepalive' })
  })

  it('refuses an unreadable envelope', () => {
    expect(unwrapGatewayBridgeEvent('junk')).toEqual({
      kind: 'error',
      message: 'Unreadable gateway relay response.'
    })
    expect(unwrapGatewayBridgeEvent({ type: 'response' })).toEqual({
      kind: 'error',
      message: 'Unreadable gateway relay response.'
    })
  })
})
