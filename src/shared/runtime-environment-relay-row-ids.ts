// Relay view rows: the guest's durable mirror of a gateway's environment. One
// row per habitat, deterministic in the gateway store's own id for that host,
// so a re-sync updates in place instead of duplicating. Renderer-side wiring
// must skip these rows — they are mirrors, not hosts; this module stays fs-free
// so renderer bundles can carry it (runtime-environment-downstream-rows keeps
// the row IO and re-exports the id functions).

export const RELAY_ROW_ID_PREFIX = 'relay-'

export function downstreamEnvironmentId(gatewayEnvironmentId: string): string {
  return `${RELAY_ROW_ID_PREFIX}${gatewayEnvironmentId}`
}

/** True for a mirrored downstream row id — not a host, no direct wiring. */
export function isRelayDownstreamEnvironmentId(environmentId: string | null | undefined): boolean {
  return typeof environmentId === 'string' && environmentId.startsWith(RELAY_ROW_ID_PREFIX)
}
