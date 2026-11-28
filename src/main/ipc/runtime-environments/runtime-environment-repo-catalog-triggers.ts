/**
 * Boot and connect-time triggers for the paired-environment repo catalog mirror.
 *
 * The pairing sync only fires while a pairing is being verified, so an already
 * paired machine stores no mirror rows on a later app start or a manual
 * reconnect. These triggers reuse the engage module's own degrade behavior —
 * unreachable pairs fail with warns and write nothing.
 */

import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import {
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { engagePairedEnvironmentRepoCatalogMirror } from './runtime-environment-repo-catalog-engraft'
import { isRuntimeEnvironmentManuallyDisconnected } from './connectivity/runtime-environment-manual-disconnect'

/**
 * Piggybacking on an engage already in flight for the same environment id: boot
 * and a connect event can fire near each other, and concurrent mirror writes to
 * the same stamp would re-ensue the same rows twice.
 */
const engagementsInFlight = new Map<string, Promise<void>>()

function engageOnce(userDataPath: string, environment: KnownRuntimeEnvironment): Promise<void> {
  const inFlight = engagementsInFlight.get(environment.id)
  if (inFlight) {
    return inFlight
  }
  const engaged = engagePairedEnvironmentRepoCatalogMirror(userDataPath, environment)
    .then(() => undefined)
    .finally(() => {
      if (engagementsInFlight.get(environment.id) === engaged) {
        engagementsInFlight.delete(environment.id)
      }
    })
  engagementsInFlight.set(environment.id, engaged)
  return engaged
}

function isMirrorCandidate(environment: KnownRuntimeEnvironment): boolean {
  return (
    !isEphemeralVmRuntimeEnvironment(environment) &&
    !isRuntimeEnvironmentManuallyDisconnected(environment.id)
  )
}

/**
 * One pass over the environment store at handlers boot. Fire-and-forget and
 * never awaits: an unreachable pair degrades inside the engage like the pairing
 * path does.
 */
export function engageAllPairedEnvironmentRepoCatalogMirrors(userDataPath: string): void {
  for (const environment of listEnvironments(userDataPath)) {
    if (!isMirrorCandidate(environment)) {
      continue
    }
    void engageOnce(userDataPath, environment)
  }
}

/**
 * Connect-time trigger: engages the environment whose connection was just
 * re-established, piggybacking an in-flight engagement instead of re-dialing.
 */
export function engageOnEnvironmentConnected(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): void {
  if (!isMirrorCandidate(environment)) {
    return
  }
  void engageOnce(userDataPath, environment)
}
