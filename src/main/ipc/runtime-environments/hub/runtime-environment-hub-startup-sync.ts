import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { isGatedOffWslHost } from '../../../wsl/host-lifecycle/wsl-host-gate'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from '../connections/runtime-environment-request-connections'
import { syncAllHubLinks } from './runtime-environment-hub-link-handlers'

// Hub rows exist only after the first list fetch, which is a network call. It therefore runs
// beside startup rather than in front of it: rows from the last good list are already usable and
// activated by the normal pass, and the rows this sync adds are activated here once they land.

export async function syncHubEnvironmentsAtStartup(
  getUserDataPath: () => string,
  rowsBeforeSync: ReadonlySet<string>
): Promise<void> {
  const userDataPath = getUserDataPath()
  try {
    await syncAllHubLinks(userDataPath)
  } catch (error) {
    // A hub that is unreachable at startup must not hold the rest of startup hostage.
    console.warn('[runtime-environments] hub link sync failed:', error)
    return
  }
  for (const environment of await listEnvironments(userDataPath)) {
    if (
      rowsBeforeSync.has(environment.id) ||
      environment.source !== 'hub' ||
      isRuntimeEnvironmentManuallyDisconnected(environment.id) ||
      isGatedOffWslHost(environment)
    ) {
      continue
    }
    const owner = await getRuntimeEnvironmentStatusOwner(userDataPath, environment.id)
    if (!isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      owner.activate()
    }
  }
}
