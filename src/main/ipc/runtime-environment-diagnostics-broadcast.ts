import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'
import { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL } from '../../shared/runtime-environment-diagnostics'
import { getRuntimeWindowBroadcastSurface } from '../runtime/runtime-window-broadcast-surface'

export { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL }

export type RuntimeEnvironmentDiagnosticsEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}

export function publishRuntimeEnvironmentDiagnostics(
  event: RuntimeEnvironmentDiagnosticsEvent
): void {
  getRuntimeWindowBroadcastSurface().broadcast(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, event)
}
