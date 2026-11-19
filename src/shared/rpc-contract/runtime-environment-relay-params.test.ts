import { describe, expect, it } from 'vitest'
import { RPC_PARAMS_BY_METHOD } from './rpc-params-catalog.generated'
import {
  REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS,
  REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS,
  REMOTE_RUNTIME_RELAY_PHASE1_METHODS,
  REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX,
  isRelayForwardableRuntimeMethod,
  isRelayForwardableRuntimeStreamMethod,
  relayForbiddenError,
  runtimeEnvironmentRelayPhase1AllowlistMessage
} from './runtime-environment-relay-params'

// The catalog map is Record<RpcMethodName, ...>; this set view tests plain
// string membership against it without touching its typed shape.
const knownCatalogMethods = new Set<string>(Object.keys(RPC_PARAMS_BY_METHOD))

const relayMethodLists = [
  ['phase-1', REMOTE_RUNTIME_RELAY_PHASE1_METHODS],
  ['attach operate', REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS],
  ['attach stream', REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS]
] as const

describe('runtime environment relay method lists', () => {
  it('names only methods the dispatcher schema map registers, verbatim', () => {
    const unknown = relayMethodLists.flatMap(([label, methods]) =>
      methods
        .filter((method) => !knownCatalogMethods.has(method))
        .map((method) => `${label}: ${method}`)
    )
    expect(unknown).toEqual([])
  })

  it('keeps every list duplicate-free and the three lists disjoint', () => {
    for (const [, methods] of relayMethodLists) {
      expect(new Set(methods).size).toBe(methods.length)
    }
    const across = relayMethodLists.flatMap(([, methods]) => [...methods])
    expect(new Set(across).size).toBe(across.length)
  })

  // Update the number when deliberately extending the operate surface; a
  // surprise here is a list edit nobody meant to make.
  it('pins the milestone-2 operate surface size', () => {
    expect(REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS.length).toBe(176)
  })

  it('refuses methods absent from every relay list even when registered', () => {
    expect(isRelayForwardableRuntimeMethod('settings.update')).toBe(false)
    expect(isRelayForwardableRuntimeStreamMethod('settings.update')).toBe(false)
    expect(isRelayForwardableRuntimeStreamMethod('agentSession.list')).toBe(false)
  })
})

describe('relay refusal wording', () => {
  it('anchors the classifier prefix and regenerates the tails from the lists', () => {
    const message = runtimeEnvironmentRelayPhase1AllowlistMessage('repo.bad')
    expect(message.startsWith(`${REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX} repo.bad.`)).toBe(true)
    expect(message).toContain(
      `Allowed (Phase 1): ${REMOTE_RUNTIME_RELAY_PHASE1_METHODS.join(', ')}.`
    )
    expect(message).toContain(
      `Allowed (Phase 1 + attach operate, over runtimeEnvironment.call): ${REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS.join(
        ', '
      )}.`
    )
    expect(message).toContain(
      `Allowed (Phase 1 + attach stream, over runtimeEnvironment.downstream.subscribe): ${REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS.join(
        ', '
      )}.`
    )
  })

  it('throws shared-wording forbidden errors for host-id refusals', () => {
    const error = relayForbiddenError('repo.bad')
    expect(error.message.startsWith(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)).toBe(true)
    expect(ownErrorCode(error)).toBe('forbidden')
  })
})

function ownErrorCode(error: Error): unknown {
  return Object.fromEntries(Object.entries(error))['code']
}
