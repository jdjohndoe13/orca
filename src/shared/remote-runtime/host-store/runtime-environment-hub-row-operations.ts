import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-records'
import { findCollidingEnvironmentName } from '../host-catalog/runtime-environment-name-collision'
import type { PersistedRuntimeEnvironment } from '../host-catalog/runtime-environments'
import {
  createHubEnvironmentRow,
  hubEnvironmentId,
  HUB_ROW_ID_PREFIX,
  type HubInstanceRow
} from '../hub/hub-instance-rows'
import { normalizeHubUrl } from '../hub/hub-link-records'

/**
 * Hub rows are derived from the hub's list, never authored: the list is the source of truth, so
 * an instance that leaves the list loses its row. Only rows this build made are touched — a row
 * with the same id that a user paired (or a newer build owns differently) is left alone.
 */

export type HubSyncResult = {
  upserted: number
  removed: number
  /** Instances whose row was skipped because a non-hub row already holds that id or name. */
  skipped: string[]
}

type PairingFields = { endpoint: string; deviceToken: string; publicKeyB64: string }

function preferredEndpointOf(environment: PersistedRuntimeEnvironment): PairingFields | null {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  return endpoint
    ? {
        endpoint: endpoint.endpoint,
        deviceToken: endpoint.deviceToken,
        publicKeyB64: endpoint.publicKeyB64
      }
    : null
}

function samePairing(a: PairingFields | null, b: PairingFields): boolean {
  return (
    a !== null &&
    a.endpoint === b.endpoint &&
    a.deviceToken === b.deviceToken &&
    a.publicKeyB64 === b.publicKeyB64
  )
}

/** Origin of a saved hub row's endpoint, or null when it is not a readable http(s)/ws(s) URL. */
function endpointOrigin(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin
  } catch {
    return null
  }
}

function hubOrigin(hubUrl: string): string {
  return new URL(hubUrl).origin
}

function isHubRow(environment: PersistedRuntimeEnvironment): boolean {
  return environment.source === 'hub'
}

/**
 * Apply one hub's instance list to the store. `instances` must be the list the hub just returned;
 * an empty list means the hub holds nothing for this key, which removes this hub's rows.
 */
export function syncHubEnvironments(
  userDataPath: string,
  args: {
    hubUrl: string
    accessKey: string
    instances: readonly HubInstanceRow[]
    now?: number
  }
): HubSyncResult {
  const normalized = normalizeHubUrl(args.hubUrl)
  if (!normalized.ok) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', normalized.message)
  }
  const hubUrl = normalized.value
  const now = args.now ?? Date.now()
  const store = readPersistedEnvironmentStore(userDataPath, { recoverBlankStore: true })
  const origin = hubOrigin(hubUrl)
  const listed = new Map<string, HubInstanceRow>()
  for (const instance of args.instances) {
    listed.set(hubEnvironmentId(instance.instanceId), instance)
  }

  const kept: PersistedRuntimeEnvironment[] = []
  const result: HubSyncResult = { upserted: 0, removed: 0, skipped: [] }
  let changed = false

  for (const environment of store.environments) {
    const listedInstance = listed.get(environment.id)
    if (isHubRow(environment) && !listedInstance && belongsToHub(environment, origin)) {
      // The hub no longer lists it: the row goes with it. Removal follows the list, not the user.
      changed = true
      result.removed += 1
      continue
    }
    if (listedInstance && !isHubRow(environment) && isDerivedId(environment.id)) {
      // A user (or a newer build) owns this id; the hub cannot claim it.
      result.skipped.push(listedInstance.instanceId)
      listed.delete(environment.id)
      kept.push(environment)
      continue
    }
    if (!listedInstance) {
      kept.push(environment)
      continue
    }
    listed.delete(environment.id)
    const next = createHubEnvironmentRow(hubUrl, listedInstance, args.accessKey, {
      now,
      createdAt: environment.createdAt
    })
    const refreshed = withPreservedState(environment, next, now)
    if (JSON.stringify(refreshed) === JSON.stringify(environment)) {
      kept.push(environment)
      continue
    }
    changed = true
    result.upserted += 1
    kept.push(refreshed)
  }

  for (const [id, instance] of listed) {
    const namesake = findCollidingEnvironmentName(kept, instance.name)
    if (namesake && namesake.id !== id) {
      // A different server already answers to that name; adding it would make both unresolvable.
      result.skipped.push(instance.instanceId)
      continue
    }
    kept.push(createHubEnvironmentRow(hubUrl, instance, args.accessKey, { now }))
    changed = true
    result.upserted += 1
  }

  if (!changed) {
    return result
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: kept.sort((a, b) => a.name.localeCompare(b.name))
  })
  return result
}

/** A row this build derived from this hub: our id prefix, and this hub's bridge as its endpoint. */
function belongsToHub(environment: PersistedRuntimeEnvironment, origin: string): boolean {
  if (!isDerivedId(environment.id)) {
    return false
  }
  return environment.endpoints.some((endpoint) => endpointOrigin(endpoint.endpoint) === origin)
}

function isDerivedId(environmentId: string): boolean {
  return environmentId.startsWith(HUB_ROW_ID_PREFIX)
}

/** Keep identity and history the hub does not own; only the pairing itself is refreshed. */
function withPreservedState(
  existing: PersistedRuntimeEnvironment,
  next: PersistedRuntimeEnvironment,
  now: number
): PersistedRuntimeEnvironment {
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const endpoint = next.endpoints[0]
  const unchanged =
    endpoint !== undefined &&
    samePairing(preferredEndpointOf(existing), endpoint) &&
    existing.name === next.name
  return {
    ...next,
    name: existing.name || next.name,
    createdAt: existing.createdAt,
    // A sync that changes nothing must write nothing: updatedAt is a signal other flows watch.
    updatedAt: unchanged ? existing.updatedAt : now,
    pairingRevision: unchanged
      ? (existing.pairingRevision ?? previousPairingRevision)
      : Math.max(now, previousPairingRevision + 1),
    lastUsedAt: existing.lastUsedAt,
    ...(existing.runtimeId ? { runtimeId: existing.runtimeId } : {}),
    ...(existing.pairedDeviceId ? { pairedDeviceId: existing.pairedDeviceId } : {})
  }
}

/**
 * Drop rows whose hub is no longer a link the user has. A link deleted on disk while Orca was
 * closed must not leave its instances behind; the surviving link set is the only authority.
 */
export function pruneHubEnvironmentsForLinks(
  userDataPath: string,
  hubUrls: readonly string[]
): { removed: number } {
  const origins = new Set<string>()
  for (const hubUrl of hubUrls) {
    const normalized = normalizeHubUrl(hubUrl)
    if (normalized.ok) {
      origins.add(hubOrigin(normalized.value))
    }
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const remaining = store.environments.filter(
    (environment) =>
      !isHubRow(environment) ||
      environment.endpoints.some((endpoint) => origins.has(endpointOrigin(endpoint.endpoint) ?? ''))
  )
  if (remaining.length === store.environments.length) {
    return { removed: 0 }
  }
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  return { removed: store.environments.length - remaining.length }
}

/** Drop every row derived from one hub link: used when the link itself is removed. */
export function removeHubEnvironmentsForHub(
  userDataPath: string,
  hubUrl: string
): { removed: number } {
  const normalized = normalizeHubUrl(hubUrl)
  if (!normalized.ok) {
    return { removed: 0 }
  }
  const origin = hubOrigin(normalized.value)
  const store = readPersistedEnvironmentStore(userDataPath)
  const remaining = store.environments.filter(
    (environment) => !isHubRow(environment) || !belongsToHub(environment, origin)
  )
  if (remaining.length === store.environments.length) {
    return { removed: 0 }
  }
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  return { removed: store.environments.length - remaining.length }
}
