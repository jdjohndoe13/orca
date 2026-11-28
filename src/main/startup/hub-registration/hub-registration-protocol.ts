// The hub's control channel: the small JSON messages that ride the
// `/v1/register` socket alongside the tunnel's binary frames.
//
// This is a mirror of the built hub's schema (`orca-hub/src/hub/protocol.ts`),
// which is the source of truth for the wire contract. The schema is closed on
// both ends on purpose: a frame whose `type` is unknown is a protocol error,
// so a newer peer cannot smuggle a future frame past an older hub (or VM).
//
// Wire: text frames are UTF-8 JSON, one message per frame. Binary frames are
// the tunnel protocol and never collide with these (the `ws` library
// distinguishes the two), so one socket carries both roles.

export const HUB_PROTOCOL_VERSION = 1

/** Cadence the VM re-registers at when the hub's `welcome` omits one (§5.3.2). */
export const HUB_DEFAULT_REFRESH_MS = 30_000

export type HubRegisterMessage = {
  type: 'register'
  version: number
  /** Globally unique: sha256(pubkey) (design doc §5.3.3). */
  instanceId: string
  /** Human label for the client's list. */
  name: string
  /** The VM's E2EE public key (base64 of the raw Ed25519 key). */
  publicKeyB64: string
  /** HMAC(accessKey, instanceId) — the hub never sees the raw key (§4). */
  keyMatch: string
  /** Ports the VM's sink will dial on loopback. ports[0] is the bridge target. */
  ports: number[]
  /** Opaque capability tags the client may filter on (e.g. 'rpc'). */
  capabilities: string[]
  /** Hub ids this registration has transited (path-vector guard, §5.3.2). */
  path: string[]
  /** Depth counter, carried unused for now — a one-line depth cap if needed. */
  hops: number
  /** 'vm' = direct VM; 'hub' = a chained hub re-announcing a VM it fronts. */
  origin: 'vm' | 'hub'
}

/** The hub's reply to a `register`/`unregister`. */
export type HubAckMessage = {
  type: 'ack'
  version: number
  instanceId: string
  ok: boolean
  reason?: 'path_loop' | 'direct_wins' | 'bad_request' | 'not_found'
}

/** The hub's first reply after the socket's registration secret is accepted. */
export type HubWelcomeMessage = {
  type: 'welcome'
  version: number
  hubId: string
  /** How often the peer must re-send its full registry (ms). */
  refreshMs: number
}

/** The hub's rejection of a registration secret. */
export type HubRejectMessage = {
  type: 'reject'
  version: number
  reason: string
}

export type HubControlMessage =
  | { type: 'auth'; version: number; secret: string }
  | { type: 'unregister'; version: number; instanceId: string }
  | { type: 'ready'; version: number }
  | HubRegisterMessage
  | HubAckMessage
  | HubWelcomeMessage
  | HubRejectMessage

/** The frames the hub can send back to this peer. */
export type HubInboundMessage = HubAckMessage | HubWelcomeMessage | HubRejectMessage

/**
 * The `register` frame this VM announces with. A VM always announces exactly
 * one instance — its own — so the path vector is empty and the hop count is
 * zero (§5.3.2); only a chained hub fills those in.
 */
export function buildRegisterFrame(input: {
  instanceId: string
  name: string
  publicKeyB64: string
  keyMatch: string
  ports: number[]
  capabilities: string[]
}): HubRegisterMessage {
  return {
    type: 'register',
    version: HUB_PROTOCOL_VERSION,
    instanceId: input.instanceId,
    name: input.name,
    publicKeyB64: input.publicKeyB64,
    keyMatch: input.keyMatch,
    ports: input.ports,
    capabilities: input.capabilities,
    path: [],
    hops: 0,
    origin: 'vm'
  }
}

/** Reads one inbound control frame; null for anything the closed schema rejects. */
export function parseHubInboundMessage(raw: string): HubInboundMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the typeof guard above proves an object; JSON objects are string-keyed.
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'ack':
      return {
        type: 'ack',
        version: finiteNumber(record.version),
        instanceId: textOr(record.instanceId, ''),
        ok: record.ok === true,
        reason: enumOr(record.reason, ['path_loop', 'direct_wins', 'bad_request', 'not_found'])
      }
    case 'welcome':
      return {
        type: 'welcome',
        version: finiteNumber(record.version),
        hubId: textOr(record.hubId, ''),
        refreshMs: finiteNumber(record.refreshMs)
      }
    case 'reject':
      return {
        type: 'reject',
        version: finiteNumber(record.version),
        reason: textOr(record.reason, '')
      }
    default:
      return null
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  return allowed.find((arm) => arm === value)
}
