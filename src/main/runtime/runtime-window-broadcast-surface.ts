/**
 * The broadcast facility the runtime-environment connection code needs: publish a
 * JSON payload to every live desktop renderer. A headless Node host has no
 * renderer windows, so the default is inert rather than throwing — publishing to
 * nothing is not an error condition. The desktop installs `electronRuntimeWindowBroadcastSurface`
 * during preflight (see host-port-bootstrap-wiring.test.ts).
 */
export type RuntimeWindowBroadcastSurface = {
  broadcast(channel: string, payload: unknown): void
}

const inertWindowBroadcastSurface: RuntimeWindowBroadcastSurface = {
  broadcast: () => {}
}

let current: RuntimeWindowBroadcastSurface = inertWindowBroadcastSurface

export function setRuntimeWindowBroadcastSurface(
  surface: RuntimeWindowBroadcastSurface | null
): void {
  current = surface ?? inertWindowBroadcastSurface
}

export function getRuntimeWindowBroadcastSurface(): RuntimeWindowBroadcastSurface {
  return current
}
