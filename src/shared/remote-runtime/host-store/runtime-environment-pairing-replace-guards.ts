import {
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource
} from '../host-catalog/runtime-environments'
import { alreadyPairedGuardCode } from '../pairing/remote-server-pairing-failure-copy'
import {
  remoteServerPairingStoreError,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-records'

/**
 * Hub rows are derived from the hub's instance list, so the list owns them: a user cannot remove
 * or re-pair one, or the next sync would silently undo it. Removal follows the hub's list.
 */
export function assertNotHubDerivedRow(
  environment: Pick<KnownRuntimeEnvironment, 'source' | 'name'>
): void {
  if (environment.source === 'hub') {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `"${environment.name}" is listed by a hub, so Orca keeps it from the hub's list. To stop tracking it, remove the instance on the hub or remove the hub itself.`
    )
  }
}

/** Refuses replacing or removing a pairing that SSH access or a managed deployment depends on. */
export function assertNoIndependentSshAccess(environment: KnownRuntimeEnvironment): void {
  if (environment.orcadDeployment) {
    throw remoteServerPairingStoreError('managedDeployment')
  }
  if (environment.pendingSshAccessOperation) {
    throw remoteServerPairingStoreError('sshAccessChangePending')
  }
  if (environment.sshAccess) {
    throw remoteServerPairingStoreError('sshAccessLinked')
  }
}

/** Refuses folding a new code into a saved server that another flow owns, naming that server. */
export function assertPairingReplaceableByAdd(
  environment: KnownRuntimeEnvironment,
  source: RuntimeEnvironmentSource | undefined,
  refreshable: boolean
): void {
  const named = { name: environment.name }
  // Why: a cloud workspace pairs its own server on resume; a hand-made pairing would be swept with it.
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    throw remoteServerPairingStoreError('alreadyPairedCloudWorkspace', named)
  }
  if (source === 'ephemeral-vm') {
    throw remoteServerPairingStoreError('alreadyPairedCloudIdentity', named)
  }
  if (environment.orcadDeployment?.kind === 'wsl') {
    throw remoteServerPairingStoreError('alreadyPairedWslHost', named)
  }
  try {
    assertNoIndependentSshAccess(environment)
  } catch (error) {
    const pairedCode =
      error instanceof RuntimeEnvironmentStoreError && error.pairingFailure
        ? alreadyPairedGuardCode(error.pairingFailure.errorCode)
        : null
    throw pairedCode ? remoteServerPairingStoreError(pairedCode, named) : error
  }
  // Why: only the app holding this server's connections can switch them to a new pairing.
  if (!refreshable) {
    throw remoteServerPairingStoreError('alreadyPairedAddAgain', named)
  }
}
