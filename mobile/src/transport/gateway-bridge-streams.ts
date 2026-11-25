// Shared gateway-bridge stream handling for the two mobile registries.
// Extracted from the fork's additions so each registry stays inside its max-lines budget.
import {
  buildGatewayBridgeUnsubscribe,
  isGatewayBridgeStream,
  terminalVehicleKind,
  TerminalVehicleArbiter,
  unwrapGatewayBridgeEvent
} from './gateway-subscribe-envelope'

/** One arbiter per registry: claims the socket's single binary terminal vehicle. */
export type GatewayBridgeStreams = {
  /** Claim the vehicle for `id`; returns the ids whose streams must be evicted. */
  claim: (method: string, params: unknown, id: string) => string[]
  forget: (id: string) => void
  /** Peel the bridge envelope off a stream reply; non-bridge streams pass through. */
  unwrap: (
    method: string | undefined,
    result: unknown
  ) => ReturnType<typeof unwrapGatewayBridgeEvent>
  /** The release frame a bridge stream needs on cancel, or null for other streams. */
  release: (
    method: string | undefined,
    id: string
  ) => { method: string; params: Record<string, unknown> } | null
}

export function createGatewayBridgeStreams(): GatewayBridgeStreams {
  const vehicles = new TerminalVehicleArbiter()
  return {
    claim: (method, params, id) => {
      const vehicle = terminalVehicleKind(method, params)
      return vehicle ? vehicles.claim(vehicle, id) : []
    },
    forget: (id) => vehicles.forget(id),
    unwrap: (method, result) =>
      isGatewayBridgeStream(method) ? unwrapGatewayBridgeEvent(result) : { kind: 'event', result },
    release: (method, id) => buildGatewayBridgeUnsubscribe(method, id)
  }
}
