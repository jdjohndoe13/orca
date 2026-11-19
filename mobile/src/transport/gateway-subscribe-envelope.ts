// The gateway's `runtimeEnvironment.downstream.subscribe` re-emits every
// upstream event as `{type:'response', response}` / `{type:'end'}` /
// `{type:'error'}`. The phone's stream registries expect the inner event
// directly (the terminal `subscribed` event must reach the binary router's
// streamId registration), so both registries unwrap through this helper before
// their existing event handling runs.
import { isKeepaliveFrame } from '../../../src/shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD
} from '../../../src/shared/rpc-contract/runtime-environment-relay-params'

export const GATEWAY_BRIDGE_SUBSCRIBE_METHOD = RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD
export const GATEWAY_BRIDGE_UNSUBSCRIBE_METHOD =
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD

export function isGatewayBridgeStream(method: string | undefined): boolean {
  return method === GATEWAY_BRIDGE_SUBSCRIBE_METHOD
}

/** The release the phone sends for a bridge stream: the gateway's request id IS
 *  the phone's request id, so the stream's own id addresses it. */
export function buildGatewayBridgeUnsubscribe(
  method: string | undefined,
  requestId: string
): { method: string; params: Record<string, unknown> } | null {
  return isGatewayBridgeStream(method)
    ? { method: GATEWAY_BRIDGE_UNSUBSCRIBE_METHOD, params: { requestId } }
    : null
}

/** The terminal handle a stream carries, through the bridge's params wrapper. */
export function gatewayBridgeInnerTerminal(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the object check above; reading optional members off an unknown object is shape inspection, not a claim.
  const bridge = params as { method?: unknown; params?: unknown }
  if (
    bridge.method !== 'terminal.subscribe' ||
    !bridge.params ||
    typeof bridge.params !== 'object'
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the object check above; the member read is narrowed to string by the return.
  const terminal = (bridge.params as { terminal?: unknown }).terminal
  return typeof terminal === 'string' ? terminal : null
}

/** Which binary terminal vehicle a subscribe claims, or null for non-terminal streams. */
export function terminalVehicleKind(method: string, params: unknown): 'local' | 'bridge' | null {
  if (method === 'terminal.subscribe') {
    return 'local'
  }
  if (isGatewayBridgeStream(method) && gatewayBridgeInnerTerminal(params) !== null) {
    return 'bridge'
  }
  return null
}

/**
 * One binary terminal vehicle per socket: the phone's binary router keys by
 * raw streamId, and a local host's and a remote host's counters are independent
 * — both live streams active at once would paint one terminal's bytes into
 * another's xterm. Local streams coexist with each other (a host-issued id is
 * unique per socket); a bridge replaces the whole local set and vice versa.
 * The evicted ids get an `end` event, which the session layer already treats
 * as a host-ended stream: unsubscribe plus the focus-gated inventory recovery.
 */
export class TerminalVehicleArbiter {
  private kind: 'local' | 'bridge' | null = null
  private readonly ids = new Set<string>()

  /** Claims the slot for `id`; returns the ids whose streams must be evicted. */
  claim(kind: 'local' | 'bridge', id: string): string[] {
    const evicted =
      this.kind !== null && (this.kind !== kind || kind === 'bridge') ? [...this.ids] : []
    if (this.kind !== kind) {
      this.ids.clear()
      this.kind = kind
    }
    this.ids.add(id)
    return evicted
  }

  forget(id: string): void {
    this.ids.delete(id)
    if (this.ids.size === 0) {
      this.kind = null
    }
  }
}

export type GatewayBridgeUnwrap =
  | { kind: 'event'; result: unknown }
  | { kind: 'keepalive' }
  | { kind: 'error'; message: string }

/**
 * Peel one gateway subscribe event. The inner envelope is the upstream host's
 * full reply — its `result` is the verbatim event the session layer would see
 * on a local stream, and its `ok:false` is a refusal the stream must surface as
 * an error rather than an event shape the listener cannot read.
 */
export function unwrapGatewayBridgeEvent(result: unknown): GatewayBridgeUnwrap {
  if (!result || typeof result !== 'object') {
    return { kind: 'error', message: 'Unreadable gateway relay response.' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the object check above; every member is read as unknown and narrowed before use.
  const event = result as { type?: unknown; response?: unknown; message?: unknown }
  if (event.type === 'end') {
    return { kind: 'event', result: { type: 'end' } }
  }
  if (event.type === 'error') {
    return {
      kind: 'error',
      message: typeof event.message === 'string' ? event.message : 'Gateway relay failed.'
    }
  }
  if (event.type !== 'response' || !event.response || typeof event.response !== 'object') {
    return { kind: 'error', message: 'Unreadable gateway relay response.' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the object check above; every member is read as unknown and narrowed before use.
  const response = event.response as {
    ok?: unknown
    result?: unknown
    error?: { message?: unknown }
  }
  if (response.ok === false) {
    return {
      kind: 'error',
      message:
        typeof response.error?.message === 'string'
          ? response.error.message
          : 'Gateway relay refused the request.'
    }
  }
  if (isKeepaliveFrame(response)) {
    return { kind: 'keepalive' }
  }
  return { kind: 'event', result: response.result }
}
