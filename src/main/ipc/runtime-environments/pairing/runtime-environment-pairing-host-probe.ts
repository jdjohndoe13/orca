// Fork split: the network side of pairing verification — dialing a host for its runtime
// status (link mode and open-access mode) and turning socket errors into pairing failures.
// Kept out of the verification module so that file stays inside its max-lines budget.
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure
} from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import type { PairingOffer } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { buildOpenAccessPairing } from '../../../../shared/remote-runtime/open-access/open-access-link'
import type { OpenAccessVerifiedPairing } from './runtime-environment-pairing-verification-core'

/** IP-only mode: dial the address with the default key and pin whatever host key answers. */
export async function verifyOpenAccessPairingCode(
  address: string
): Promise<OpenAccessVerifiedPairing | RemotePairingFailure> {
  const offer = buildOpenAccessPairing(address)
  if (!offer) {
    return { ok: false, kind: 'access-link-invalid', message: 'The address is not connectable.' }
  }
  const response = await requestRuntimeStatus(offer)
  if (!response.ok) {
    return response.failure
  }
  const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
  if (!statusVerification.ok) {
    return statusVerification
  }
  return {
    ok: true,
    openAccess: true,
    offer,
    runtimeStatus: statusVerification.runtimeStatus
  }
}

export async function requestRuntimeStatus(
  offer: PairingOffer
): Promise<{ ok: true; result: unknown } | { ok: false; failure: RemotePairingFailure }> {
  try {
    const response = await sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(offer),
      'status.get',
      undefined,
      15_000,
      undefined,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      undefined,
      undefined
    )
    if (!response.ok) {
      return {
        ok: false,
        failure: { ok: false, kind: 'connection-interrupted', message: response.error.message }
      }
    }
    return { ok: true, result: response.result }
  } catch (error) {
    return {
      ok: false,
      failure: classifyPairingVerificationError(error, displayEndpointOf(offer))
    }
  }
}

function displayEndpointOf(offer: { endpoint: string }): string {
  try {
    return new URL(offer.endpoint).host
  } catch {
    return offer.endpoint
  }
}

export function classifyPairingVerificationError(
  error: unknown,
  endpoint: string
): RemotePairingFailure {
  if (error instanceof RemoteRuntimeClientError) {
    if (error.code === 'invalid_argument') {
      return invalidAccessLinkResult()
    }
    if (error.code === 'unauthorized' || error.pairingStage === 'access-grant') {
      return {
        ok: false,
        kind: 'access-link-invalid',
        message: 'This access link is no longer valid. Generate a new link on the other host.'
      }
    }
    if (error.pairingStage === 'host-identity') {
      return {
        ok: false,
        kind: 'host-identity-mismatch',
        message: `Orca reached ${endpoint}, but that host does not match this access link.`
      }
    }
    if (error.pairingStage === 'runtime') {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: `The connection to ${endpoint} was interrupted during verification.`
      }
    }
    if (error.pairingStage === 'connect') {
      return unreachableHostResult(endpoint)
    }
  }
  if (error instanceof Error) {
    return error.message.startsWith('Invalid public key')
      ? invalidAccessLinkResult()
      : { ok: false, kind: 'connection-interrupted', message: error.message }
  }
  return unreachableHostResult(endpoint)
}

function invalidAccessLinkResult(): RemotePairingFailure {
  return {
    ok: false,
    kind: 'access-link-invalid',
    message: 'This access link contains invalid connection details.'
  }
}

function unreachableHostResult(endpoint: string): RemotePairingFailure {
  return {
    ok: false,
    kind: 'host-unreachable',
    message: `Cannot reach Orca at ${endpoint}. Confirm the other host is running and reachable.`
  }
}
