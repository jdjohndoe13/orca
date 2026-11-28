// Running orca's own tunnel protocol over the hub's `/v1/register` socket.
//
// The VM dials the hub, so the *hub* is the tunnel client and this side is the
// sink: an `Open` arrives here and this host dials its own loopback. That role
// reversal is the whole design (§3.2, §8.1) — a VM with no inbound ports still
// answers streams because it holds the outbound socket open.
//
// One tunnel frame per WebSocket message is the natural framing, the same
// model as `network.portForward`'s `registerBinaryMessageHandler`: no stream
// framing layer is needed on WSS. Text frames are the hub's control channel
// and binary frames are tunnel frames, so the two never collide; the dispatch
// lives here so one socket can carry both in either order.

import { WebSocket } from 'ws'
import type { WebSocket as WebSocketType } from 'ws'
import { BrowserNetworkTunnelSession } from '../../browser/network/tunnels/browser-network-tunnel-session'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'

type TunnelSocketDelegate = {
  handleBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  close: () => void
}

/** True only when the socket can still carry a frame. */
export function wsIsOpen(ws: WebSocketType): boolean {
  // `WebSocket.OPEN` is the constant to compare against; `readyState` alone is
  // a number whose meaning is easy to get wrong (the spike's first bug).
  return ws.readyState === WebSocket.OPEN
}

/** Wire WS frames to a tunnel delegate; text frames go to `onControl`. */
export function attachHubTunnelTransport(
  ws: WebSocketType,
  delegate: TunnelSocketDelegate,
  onControl?: (text: string) => void
): () => void {
  const onMessage = (data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      delegate.handleBinary(new Uint8Array(data))
    } else if (onControl) {
      onControl(data.toString('utf8'))
    }
  }
  ws.on('message', onMessage)
  const shutdown = (): void => {
    delegate.close()
  }
  ws.on('close', shutdown)
  ws.on('error', shutdown)
  return () => {
    ws.off('message', onMessage)
    ws.off('close', shutdown)
    ws.off('error', shutdown)
  }
}

/**
 * Run the tunnel-sink role on this socket: the hub opens streams toward us and
 * `connectTarget` answers them. Generation 1 is enough because the socket
 * *is* the tunnel — a new socket gets a fresh session, so ids never have to
 * survive a rollover.
 */
export function runHubTunnelSink(
  ws: WebSocketType,
  connectTarget: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket,
  onControl?: (text: string) => void
): { close: () => void } {
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: connectTarget,
    sendBinary: (bytes) => {
      if (!wsIsOpen(ws)) {
        return false
      }
      ws.send(bytes, { binary: true })
      return true
    }
  })
  const detach = attachHubTunnelTransport(ws, session, onControl)
  return {
    close: () => {
      detach()
      session.close()
    }
  }
}
