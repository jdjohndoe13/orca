import type { PairingOffer } from './remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  readEnvironmentStore,
  writeEnvironmentStore
} from './remote-runtime/host-store/runtime-environment-store-file'
import { downstreamEnvironmentId } from './runtime-environment-relay-row-ids'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from './remote-runtime/host-catalog/runtime-environments'

// Why re-exported: guests' main process reads relay row ids from this module's
// surfaces; the ids themselves live in the fs-free module so the renderer can
// import them too.
export { downstreamEnvironmentId }

export function upsertDownstreamEnvironment(
  userDataPath: string,
  args: {
    gatewayEnvironmentId: string
    name: string
    upstreamRuntimeId: string | null
    offer: PairingOffer
    now?: number
  }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const id = downstreamEnvironmentId(args.gatewayEnvironmentId)
  const now = args.now ?? Date.now()
  const existing = store.environments.find((entry) => entry.id === id)
  const environment = {
    ...createEnvironmentFromPairingOffer({
      id,
      name: args.name,
      now: existing?.createdAt ?? now,
      offer: args.offer,
      // A runtimeId learned live from relay envelopes outranks the census's
      // stored copy of it; the census only ever seeds a fresh row.
      runtimeId: existing?.runtimeId ?? args.upstreamRuntimeId ?? null,
      gatewayEnvironmentId: args.gatewayEnvironmentId
    }),
    ...(existing?.pairingRevision != null ? { pairingRevision: existing.pairingRevision } : {}),
    ...(existing?.lastUsedAt != null ? { lastUsedAt: existing.lastUsedAt } : {}),
    updatedAt: now
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: [...store.environments.filter((entry) => entry.id !== id), environment].sort(
      (a, b) => a.name.localeCompare(b.name)
    )
  })
  return environment
}

/** Prune this gateway route's stale view rows: rows using its endpoint that no
 *  longer appear in its fresh downstream list. Rows bound to another route (they
 *  carry a different pairing offer) are left alone. Returns how many rows went. */
export function pruneDownstreamEnvironmentRows(
  userDataPath: string,
  args: { gatewayEndpoint: string; keepGatewayEnvironmentIds: ReadonlySet<string> }
): number {
  const store = readEnvironmentStore(userDataPath)
  const next = store.environments.filter((entry) => {
    if (!entry.gatewayEnvironmentId) {
      return true
    }
    if (!entry.endpoints.some((endpoint) => endpoint.endpoint === args.gatewayEndpoint)) {
      return true
    }
    return args.keepGatewayEnvironmentIds.has(entry.gatewayEnvironmentId)
  })
  if (next.length === store.environments.length) {
    return 0
  }
  writeEnvironmentStore(userDataPath, { version: 1, environments: next })
  return store.environments.length - next.length
}
