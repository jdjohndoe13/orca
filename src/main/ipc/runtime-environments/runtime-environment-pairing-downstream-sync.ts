import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import {
  downstreamEnvironmentId,
  pruneDownstreamEnvironmentRows,
  upsertDownstreamEnvironment
} from '../../../shared/runtime-environment-downstream-rows'
import {
  REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD
} from '../../../shared/rpc-contract/runtime-environment-relay-params'
import {
  RuntimeEnvironmentDownstreamListResultSchema,
  type RuntimeEnvironmentDownstreamRow
} from '../../../shared/rpc-contract/runtime-environment-downstream-list-rows'
import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'
import { engagePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-engraft'

export type DownstreamEnvironmentSyncSummary = {
  created: number
  updated: number
  pruned: number
}

// Short on purpose: the sync rides along a pairing the user is waiting on.
const DOWNSTREAM_SYNC_TIMEOUT_MS = 15_000

/**
 * After a verified pairing to a relay-capable gateway, mirror its downstream
 * census into this host's store as durable view rows. The operation is
 * best-effort: a failure degrades to "this gateway lists nothing" and never
 * fails the pairing that started it, which is why every path here resolves to a
 * summary instead of throwing.
 */
export async function synchronizeDownstreamEnvironmentRows(args: {
  userDataPath: string
  gateway: KnownRuntimeEnvironment
  capabilities: readonly string[]
}): Promise<DownstreamEnvironmentSyncSummary> {
  // Why fire-and-forget before the census: the repo catalog mirror never blocks
  // or gates the census — a new phone-usable environment needs its store rows
  // even when the relay census is refused or unavailable.
  void engagePairedEnvironmentRepoCatalogMirror(args.userDataPath, args.gateway).catch((error) => {
    console.warn('[downstream-sync] repo catalog mirror rejected:', error)
  })
  const gatewayEndpoint = getPreferredPairingOffer(args.gateway).endpoint
  if (!args.capabilities.includes(REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY)) {
    // A gateway that cannot census its downstream (older version, relay
    // unavailable) leaves no view rows behind: stale rows would dead-end every
    // dial through it.
    const pruned = pruneDownstreamEnvironmentRows(args.userDataPath, {
      gatewayEndpoint,
      keepGatewayEnvironmentIds: new Set()
    })
    return { created: 0, updated: 0, pruned }
  }
  try {
    const response = await callRuntimeEnvironment(
      args.userDataPath,
      args.gateway.id,
      RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
      {},
      DOWNSTREAM_SYNC_TIMEOUT_MS
    )
    if (!response.ok) {
      if (response.error.code === 'method_not_found') {
        // The gateway advertised the capability but no longer serves the
        // census (version drift). Treat as listing nothing.
        warn('gateway no longer serves the downstream census', response.error.message)
        const pruned = pruneDownstreamEnvironmentRows(args.userDataPath, {
          gatewayEndpoint,
          keepGatewayEnvironmentIds: new Set()
        })
        return { created: 0, updated: 0, pruned }
      }
      // A transient gateway-side refusal: learned rows stay dialable next sync.
      warn(
        'gateway refused the downstream census',
        `${response.error.code}: ${response.error.message}`
      )
      return { created: 0, updated: 0, pruned: 0 }
    }
    const parsed = RuntimeEnvironmentDownstreamListResultSchema.safeParse(response.result)
    if (!parsed.success) {
      warn('gateway returned an unreadable downstream census', undefined)
      return { created: 0, updated: 0, pruned: 0 }
    }
    return applyDownstreamRows(
      args.userDataPath,
      args.gateway,
      gatewayEndpoint,
      parsed.data.environments
    )
  } catch (error) {
    // Connect failures and queue overload reject above: a lost gateway is not
    // evidence that its downstream view went stale, so nothing is pruned.
    warn('downstream census dial failed', error instanceof Error ? error.message : String(error))
    return { created: 0, updated: 0, pruned: 0 }
  }
}

function applyDownstreamRows(
  userDataPath: string,
  gateway: KnownRuntimeEnvironment,
  gatewayEndpoint: string,
  rows: readonly RuntimeEnvironmentDownstreamRow[]
): DownstreamEnvironmentSyncSummary {
  const listedIds = new Set(listEnvironments(userDataPath).map((entry) => entry.id))
  const freshGatewayEnvironmentIds = new Set<string>()
  let created = 0
  let updated = 0
  for (const row of rows) {
    if (row.gatewayEnvironmentId === null) {
      // The gateway's self row: this host already holds that machine as the
      // directly paired environment — never mint a second row for it.
      continue
    }
    freshGatewayEnvironmentIds.add(row.gatewayEnvironmentId)
    const name = `${gateway.name} → ${row.name}`
    const id = downstreamEnvironmentId(row.gatewayEnvironmentId)
    const exists = listedIds.has(id)
    // The upsert itself binds upstreamRuntimeId (a learned one outranks this
    // census copy).
    upsertDownstreamEnvironment(userDataPath, {
      gatewayEnvironmentId: row.gatewayEnvironmentId,
      name,
      upstreamRuntimeId: row.upstreamRuntimeId,
      offer: getPreferredPairingOffer(gateway)
    })
    if (exists) {
      updated++
    } else {
      created++
    }
  }
  const pruned = pruneDownstreamEnvironmentRows(userDataPath, {
    gatewayEndpoint,
    keepGatewayEnvironmentIds: freshGatewayEnvironmentIds
  })
  return { created, updated, pruned }
}

function warn(message: string, detail: string | undefined): void {
  console.warn(`[downstream-sync] ${message}${detail ? ` — ${detail}` : ''}`)
}
