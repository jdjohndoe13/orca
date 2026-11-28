import { app } from 'electron'
import { notifyServeSupervisorReady } from '../../updater/serve-update-handoff'
import { clearServeAbortPark } from '../../../shared/remote-runtime/serve-supervisor/serve-abort-park'
import { findBundledWebClientRoot } from '../../../shared/web-client/bundled-web-client-root'
import { buildServePairingReadiness, servePublishMode } from '../../server/serve-pairing-readiness'
import { mainProcessState as state } from '../main-process-state'
import { installHubRegistration } from '../hub-registration/hub-registration-startup'
import type { ServeOptions } from './serve-options'

export function getBundledWebClientRoot(): string | undefined {
  return findBundledWebClientRoot(app.getAppPath())
}

export async function printServeReady(options: ServeOptions): Promise<void> {
  const runtime = state.core.runtime
  const runtimeRpc = state.core.runtimeRpc
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  // Validate project root before pairing publication can persist a pending device.
  const output = servePublishMode(options)
  await state.core.serveReadinessPublisher.publish(
    {
      runtimeId: runtime.getRuntimeId(),
      ...(await buildServePairingReadiness(options, runtimeRpc)),
      // WSL barrier fails open; pending warns clients PTY launch may still race repair.
      managedWslCliReconciliation: state.managedWslCliReconciliationStatus
    },
    output
  )
  notifyServeSupervisorReady(runtime.getRuntimeId())
  // A VM behind NAT registers with its fixed-IP hub only now that the WS port is bound.
  await installHubRegistration(runtimeRpc, (stop) => {
    app.once('will-quit', stop)
  })
  // Successful readiness disproves the previous serve-abort park.
  clearServeAbortPark(app.getPath('userData'))
}
