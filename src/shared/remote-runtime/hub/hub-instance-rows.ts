import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { hubBridgeEndpoint } from './hub-link-records'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import { PAIRING_PUBLIC_KEY_MAX_CHARACTERS } from '../pairing/mobile-pairing-protocol-limits'

// The wire shape of `GET <hubUrl>/v1/list` (see the hub's server.ts). Records stay opaque at the
// envelope level so one instance this build cannot read is dropped instead of hiding the rest.

export const HUB_PROTOCOL_VERSION = 1

export const HubInstanceRowSchema = lazyZodSchema(() =>
  z.object({
    instanceId: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
    ports: z.array(z.number().int().min(1).max(65_535)).max(64).catch([]),
    capabilities: z.array(z.string().max(128)).max(64).catch([]),
    source: z.string().max(128).optional(),
    bridgePath: z.string().min(1).max(2048)
  })
)

export type HubInstanceRow = z.infer<typeof HubInstanceRowSchema>

const ListResponseSchema = lazyZodSchema(() =>
  z.object({
    hubId: z.string().min(1).max(200).optional(),
    protocolVersion: z.number().int().min(1).max(HUB_PROTOCOL_VERSION),
    instances: z.array(z.unknown())
  })
)

export type HubInstanceList = {
  hubId: string | null
  instances: HubInstanceRow[]
  /** Instances this build could not read; they must not be treated as removed. */
  unreadableCount: number
}

export type HubInstanceListParse =
  | { ok: true; value: HubInstanceList }
  | { ok: false; reason: 'status'; status: number }
  | { ok: false; reason: 'malformed' }

/**
 * Validate a list response. A non-2xx is reported by status so the caller can distinguish a bad
 * access key (401) from an unreachable hub; an unreadable body is `malformed`, never empty.
 */
export function parseHubInstanceList(status: number, body: unknown): HubInstanceListParse {
  if (status !== 200) {
    return { ok: false, reason: 'status', status }
  }
  const parsed = ListResponseSchema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' }
  }
  const instances: HubInstanceRow[] = []
  let unreadableCount = 0
  for (const raw of parsed.data.instances) {
    const row = HubInstanceRowSchema.safeParse(raw)
    if (row.success) {
      instances.push(row.data)
    } else {
      unreadableCount += 1
    }
  }
  return {
    ok: true,
    value: {
      hubId: parsed.data.hubId ?? null,
      instances,
      unreadableCount
    }
  }
}

/** Deterministic row id: the hub's `instanceId` is stable across re-IPs and re-registrations. */
export const HUB_ROW_ID_PREFIX = 'hub-'

export function hubEnvironmentId(instanceId: string): string {
  return `${HUB_ROW_ID_PREFIX}${instanceId}`
}

export function isHubEnvironmentId(environmentId: string | null | undefined): boolean {
  return typeof environmentId === 'string' && environmentId.startsWith(HUB_ROW_ID_PREFIX)
}

/**
 * One listed instance as a pairing offer: the bridge URL is the endpoint, the hub's access key
 * rides inside the E2EE handshake as the device token, and the listed key is a real pin — so no
 * `openAccess` flag, unlike the fork's connect-by-IP mode.
 */
export function hubInstancePairingOffer(
  hubUrl: string,
  instance: HubInstanceRow,
  accessKey: string
): {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  scope: 'runtime'
} {
  return {
    v: 2,
    endpoint: hubBridgeEndpoint(hubUrl, instance.bridgePath),
    deviceToken: accessKey,
    publicKeyB64: instance.publicKeyB64,
    scope: 'runtime'
  }
}

/** Build the derived row for one listed instance. Ids are derived, so re-syncs update in place. */
export function createHubEnvironmentRow(
  hubUrl: string,
  instance: HubInstanceRow,
  accessKey: string,
  args: { now: number; createdAt?: number; name?: string }
): KnownRuntimeEnvironment {
  return createEnvironmentFromPairingOffer({
    id: hubEnvironmentId(instance.instanceId),
    name: args.name?.trim() || instance.name,
    now: args.createdAt ?? args.now,
    offer: hubInstancePairingOffer(hubUrl, instance, accessKey),
    runtimeId: null,
    source: 'hub'
  })
}
