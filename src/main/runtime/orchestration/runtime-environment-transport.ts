import type { OrchestrationEnvironmentTransport } from './environment-transport'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../../shared/runtime-environments'
import { callRuntimeEnvironment } from '../../ipc/runtime-environment-transport-routing'
import { fingerprintOrchestrationPeer } from './environment-transport'

/**
 * The transport every serving host wires: desktop main and orcad construct the
 * identical object from the identical startup helper, because the environment
 * method families (orchestration federation, Phase-1 relay gateway) resolve
 * saved environments through it — a host without a transport is a host without
 * a gateway, no matter what its method registry claims.
 *
 * Why the factory and not a copy-paste object: the two entrypoints' wiring must
 * not drift, and the dial path stays the one transport-routing route (queue,
 * pairing-revision guard, orchestration envelope, runtimeId binding) that both
 * hosts already share.
 */
export function createRuntimeEnvironmentTransport(
  userDataPath: string
): OrchestrationEnvironmentTransport {
  return {
    resolve: (selector) => {
      const environment = resolveEnvironment(userDataPath, selector)
      const pairing = getPreferredPairingOffer(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(pairing.publicKeyB64),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    call: (selector, method, params, timeoutMs, envelope, expectedPairingRevision) =>
      callRuntimeEnvironment(
        userDataPath,
        selector,
        method,
        params,
        timeoutMs,
        expectedPairingRevision,
        envelope
      )
  }
}
