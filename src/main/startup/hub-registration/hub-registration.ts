// Hub registration: how a VM with no inbound ports becomes reachable.
//
// A VM's IP is random and nothing can dial in, so the VM dials *out* to a
// fixed-IP hub at startup and keeps the socket open:
//
//   1. read this profile's E2EE public key (the instance id derives from it);
//   2. dial the hub's `/v1/register`, send `auth` (the registration secret),
//      then `register` (id, key-match digest, ports) and `ready`;
//   3. run the tunnel *sink* on that socket — the hub is the tunnel client, so
//      an `Open` arrives here and this host dials its own loopback (§8.1.2);
//   4. re-register on the cadence the hub's `welcome` names (§5.3.2), and
//      reconnect with backoff if the socket drops.
//
// A `reject` is terminal: the socket closes and no retry follows, because a
// wrong secret or a claimed id this VM cannot prove will not fix itself, and
// hammering the hub with it is worse than sitting out until the next start.
//
// The hub-side contract lives in `orca-hub` (`src/hub/`); this module mirrors
// its closed control schema and its id/key-match derivation exactly.

import { WebSocket } from 'ws'
import type { WebSocket as WebSocketType } from 'ws'
import { instanceIdFromPublicKey, keyMatchFor } from './hub-registration-crypto'
import type { HubRegistrationConfig } from './hub-registration-config'
import {
  HUB_PROTOCOL_VERSION,
  buildRegisterFrame,
  parseHubInboundMessage,
  type HubControlMessage
} from './hub-registration-protocol'
import { createHubSinkConnect, type HubLoopbackDial } from './hub-registration-sink'
import { runHubTunnelSink, wsIsOpen } from './hub-registration-transport'

export const HUB_DEFAULT_RECONNECT_DELAY_MS = 500
export const HUB_MAX_RECONNECT_DELAY_MS = 30_000
export const HUB_MAX_RECONNECT_BACKOFF_SHIFT = 6
// The hub evicts an entry it has not heard about within its TTL, so a refresh
// faster than 1s is a misconfiguration rather than a faster keepalive.
export const HUB_MIN_REFRESH_MS = 1000

/** Exponential backoff with a ceiling; the first retry waits one step. */
export function hubReconnectDelayMs(attempt: number): number {
  return Math.min(
    HUB_MAX_RECONNECT_DELAY_MS,
    HUB_DEFAULT_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, HUB_MAX_RECONNECT_BACKOFF_SHIFT)
  )
}

/** The resolved config plus the key this host proves its instance id with. */
export type HubRegistrationTarget = HubRegistrationConfig & {
  /** The VM's E2EE public key, base64 of the raw Ed25519 key. */
  publicKeyB64: string
}

export type HubRegistrationHandle = { stop: () => void }

export type HubRegistrationOptions = {
  /** Injected for tests; production dials the serve port on loopback. */
  dial?: HubLoopbackDial
  log?: (message: string) => void
}

/**
 * Registers on one hub and keeps the registration alive. Returns a handle whose
 * `stop` closes the socket and stops the refresh timer.
 */
export function registerWithHub(
  target: HubRegistrationTarget,
  options: HubRegistrationOptions = {}
): HubRegistrationHandle {
  const log = options.log ?? (() => {})
  const instanceId = instanceIdFromPublicKey(target.publicKeyB64)
  const keyMatch = keyMatchFor(target.accessKey, instanceId)
  const connectSink = createHubSinkConnect(instanceId, target.ports, options.dial)
  const registerFrame = (): HubControlMessage =>
    buildRegisterFrame({
      instanceId,
      name: target.name,
      publicKeyB64: target.publicKeyB64,
      keyMatch,
      ports: target.ports,
      capabilities: target.capabilities
    })
  let stopped = false
  let socket: WebSocketType | null = null
  let sink: { close: () => void } | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  let attempt = 0

  const send = (message: HubControlMessage): void => {
    if (socket && wsIsOpen(socket)) {
      socket.send(JSON.stringify(message))
    }
  }

  const stopRefresh = (): void => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  // The cadence is the hub's (§5.3.2): an entry the VM stops refreshing is
  // evicted at the hub's TTL, so this interval is the feature, not a poll.
  const startRefresh = (refreshMs: number): void => {
    if (refreshTimer) {
      return
    }
    refreshTimer = setInterval(() => send(registerFrame()), Math.max(HUB_MIN_REFRESH_MS, refreshMs))
    refreshTimer.unref?.()
  }

  const connect = (): void => {
    if (stopped) {
      return
    }
    const ws = new WebSocket(target.url)
    socket = ws
    ws.on('open', () => {
      attempt = 0
      // Control frames (the hub's welcome/ack/reject) and tunnel frames share
      // this socket; the `ws` library keeps text and binary frames apart.
      sink = runHubTunnelSink(ws, connectSink, (text) => {
        const message = parseHubInboundMessage(text)
        if (message?.type === 'welcome') {
          startRefresh(message.refreshMs > 0 ? message.refreshMs : target.refreshMs)
          return
        }
        if (message?.type === 'reject') {
          log(`hub ${target.url} rejected: ${message.reason}`)
          stopped = true
          stopRefresh()
          ws.close(1008, 'rejected')
        }
      })
      send({ type: 'auth', version: HUB_PROTOCOL_VERSION, secret: target.registrationSecret })
      send(registerFrame())
      send({ type: 'ready', version: HUB_PROTOCOL_VERSION })
      log(`registered ${instanceId} -> ${target.url}`)
    })
    const onGone = (): void => {
      sink?.close()
      sink = null
      stopRefresh()
      if (stopped) {
        return
      }
      setTimeout(connect, hubReconnectDelayMs(attempt)).unref?.()
      attempt += 1
    }
    ws.on('close', onGone)
    ws.on('error', () => {
      if (wsIsOpen(ws)) {
        ws.close()
      }
    })
  }

  connect()
  return {
    stop: () => {
      stopped = true
      stopRefresh()
      if (socket && wsIsOpen(socket)) {
        socket.close()
      }
      sink?.close()
      sink = null
    }
  }
}
