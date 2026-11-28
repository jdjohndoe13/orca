// The sink's answer to a hub `Open`: verify the target, then dial loopback.
//
// The hub encodes the destination in the Open frame itself — `{ host:
// instanceId, port }` (design doc §8.1.2) — because the tunnel's sink never
// sees the client's bridge URL. The host label is therefore load-bearing, not
// cosmetic: it is the only thing telling this VM which instance the stream is
// for. So the sink refuses a foreign host and an unregistered port, and only
// then dials its own loopback.
//
// Both refusals are stream-level: the tunnel answers them with an `Error`
// frame and keeps the socket (and the registration) alive. A VM must never
// become a proxy into arbitrary networks, so the host is not just compared but
// replaced — the dial always names this host's own loopback, and the loopback
// helper pins `localhost` to this machine whatever the resolver says.
//
// The dial needs one deliberate exception. The destination policy refuses to
// dial Orca's own listeners, and the serve WS port this VM registers *is* one
// of them (the WS transport reserves it). That refusal exists so a paired
// browser cannot reach the host's control plane; it cannot sensibly apply to
// the host's own registration module, whose entire job is to reach its own
// serve port. Hence the policy is bypassed for this one dial — and only because
// the host is already forced to loopback and the port is already in the
// registered set, which is the same guarantee the policy would have checked.

import { connectNativeLoopbackTarget } from '../../browser/network/execution-routes/browser-network-execution-route'
import { BROWSER_TUNNEL_ALLOW_ALL_DESTINATIONS_ENV } from '../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'

/** Dials the host's own loopback; the caller has already fixed host and port. */
export type HubLoopbackDial = (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket

export const HUB_LOOPBACK_DIAL_ENV: Record<string, string | undefined> = {
  [BROWSER_TUNNEL_ALLOW_ALL_DESTINATIONS_ENV]: '1'
}

export function createHubLoopbackDial(): HubLoopbackDial {
  return (target) => connectNativeLoopbackTarget(target, HUB_LOOPBACK_DIAL_ENV)
}

/** Why the sink refused to open a stream. */
export type HubSinkRefusal = 'wrong_host' | 'port_not_registered'

export class HubSinkRefusalError extends Error {
  constructor(readonly refusal: HubSinkRefusal) {
    super(`hub_sink_${refusal}`)
  }
}

/**
 * The sink's `connect`. Refuses anything but this instance's registered ports,
 * then dials the port on this host's loopback.
 */
export function createHubSinkConnect(
  instanceId: string,
  ports: number[],
  dial: HubLoopbackDial = createHubLoopbackDial()
): (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket {
  const allowed = new Set(ports)
  return (target) => {
    if (target.host !== instanceId) {
      throw new HubSinkRefusalError('wrong_host')
    }
    if (!allowed.has(target.port)) {
      throw new HubSinkRefusalError('port_not_registered')
    }
    return dial({ host: '127.0.0.1', port: target.port })
  }
}
