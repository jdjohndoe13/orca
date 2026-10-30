import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

/**
 * The execution host the status data came from, derived from the SAME routing
 * inputs the fetch used (`getRuntimeGitStatus` routes on `settings` first, then
 * the SSH `connectionId`, else local). The identity write must name that host:
 * a contested id (one repo on several hosts, STA-4343) publishes one row per
 * host, and an unattributed patch repaints every claimant's row — the sidebar
 * "both rows show the clicked host's branch" defect.
 */
export function gitStatusRefreshExecutionHost(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId?: string
): ExecutionHostId {
  const runtimeEnvId = settings?.activeRuntimeEnvironmentId
  if (runtimeEnvId) {
    return toRuntimeExecutionHostId(runtimeEnvId)
  }
  const sshTarget = connectionId?.trim()
  return sshTarget ? toSshExecutionHostId(sshTarget) : LOCAL_EXECUTION_HOST_ID
}
