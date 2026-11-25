import {
  addOrUpdateEnvironmentFromPairingCode,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { parseHostAccessLink } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure,
  type VerifyAndAddRuntimeEnvironmentResult
} from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { exchangeRemotePairingTicket } from '../../../../shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import {
  getPreferredPairingOffer,
  isEphemeralVmRuntimeEnvironment,
  redactRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  remoteServerPairingFailureText,
  type RemoteServerPairingFailureCode
} from '../../../../shared/remote-runtime/pairing/remote-server-pairing-failure-copy'
import { synchronizeDownstreamEnvironmentRows } from '../runtime-environment-pairing-downstream-sync'
import {
  applyDeviceTokenOverride,
  applyEndpointOverride
} from '../../../../shared/remote-runtime/open-access/open-access-link'
import {
  encodeOpenAccessPairingCode,
  type OpenAccessVerifiedPairing,
  type VerifiedPairing
} from './runtime-environment-pairing-verification-core'
import {
  requestRuntimeStatus,
  verifyOpenAccessPairingCode
} from './runtime-environment-pairing-host-probe'

export type {
  OpenAccessVerifiedPairing,
  VerifiedPairing
} from './runtime-environment-pairing-verification-core'

/** Optional overrides the Add-server form sends alongside the access link. */
export type PairingOverrideArgs = {
  /** host:port or ws(s):// URL; replaces the link's endpoint, or names the host when there is no link. */
  endpointOverride?: string
  /** Replaces the link's deviceToken, e.g. the host's fixed default access key. */
  deviceTokenOverride?: string
}

export type VerifyAndAddRuntimeEnvironmentArgs = PairingOverrideArgs & {
  name: string
  pairingCode: string
  allowLoopback?: boolean
}

export type RepairRuntimeEnvironmentArgs = PairingOverrideArgs & {
  selector: string
  pairingCode: string
}

type VerifiedPairingResult = VerifiedPairing | OpenAccessVerifiedPairing

/** Proves a pairing link reaches a compatible host that accepts it, without saving anything. */
async function verifyPairingCode(
  pairingCode: string,
  allowLoopback: boolean | undefined,
  overrides: PairingOverrideArgs
): Promise<VerifiedPairingResult | RemotePairingFailure> {
  const trimmedCode = pairingCode.trim()
  const trimmedEndpoint = overrides.endpointOverride?.trim() ?? ''
  // Why first: an empty link with an address is the IP-only mode; the host is expected to run in
  // "accept any access key" mode, so the default key and a TOFU pin replace the link entirely.
  if (trimmedCode === '' && trimmedEndpoint !== '') {
    return verifyOpenAccessPairingCode(trimmedEndpoint)
  }
  const parsed = parseHostAccessLink(trimmedCode)
  if (!parsed.ok) {
    return { ok: false, kind: 'access-link-invalid', message: parsed.message }
  }
  const link = applyDeviceTokenOverride(parsed.value, overrides.deviceTokenOverride?.trim() ?? '')
  const withEndpoint = applyEndpointOverride(link, trimmedEndpoint)
  if (!withEndpoint.ok) {
    return { ok: false, kind: 'access-link-invalid', message: withEndpoint.message }
  }
  // Why the override's kind: the user named the address they actually reach, so a loopback link
  // overridden by a LAN address is not a link that points back to this device.
  if (withEndpoint.value.endpointKind === 'loopback' && !allowLoopback) {
    return {
      ok: false,
      kind: 'host-unreachable',
      message: 'This access link points back to this device.'
    }
  }
  const response = await requestRuntimeStatus(withEndpoint.value.pairing)
  if (!response.ok) {
    return response.failure
  }
  const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
  if (!statusVerification.ok) {
    return statusVerification
  }
  return {
    ok: true,
    link: withEndpoint.value,
    runtimeStatus: statusVerification.runtimeStatus
  }
}

export async function verifyAndAddRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const verified = await verifyPairingCode(args.pairingCode, args.allowLoopback, args)
  if (!verified.ok) {
    return verified
  }
  // Save a token only this computer holds; the link stops working once it is used. An open-access
  // pairing has no link to burn: the default key is the point, so the ticket exchange is skipped.
  const savedPairingCode =
    'openAccess' in verified
      ? encodeOpenAccessPairingCode(verified)
      : await exchangeRemotePairingTicket({
          pairingCode: args.pairingCode,
          offer: verified.link.pairing,
          hostCapabilities: verified.runtimeStatus.capabilities
        })
  const usesSshTunnel =
    'openAccess' in verified
      ? false
      : verified.link.endpointKind === 'loopback' && args.allowLoopback === true
  let outcome: Awaited<ReturnType<typeof addOrUpdateEnvironmentFromPairingCode>>
  try {
    outcome = await addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      ...args,
      pairingCode: savedPairingCode,
      // Only a verified key match permits updating an existing server identity.
      runtimeId: verified.runtimeStatus.runtimeId,
      ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
    })
  } catch (error) {
    return pairingSaveFailure(error, 'hostSaveFailed')
  }
  // Fire-and-forget: the downstream view rows ride along after the pairing
  // result, and a failed census must never gate the pairing itself (the sync
  // resolves to a summary on every path).
  void synchronizeDownstreamEnvironmentRows({
    userDataPath,
    gateway: outcome.environment,
    capabilities: verified.runtimeStatus.capabilities ?? []
  })
  return {
    ok: true,
    environment: redactRuntimeEnvironment(outcome.environment),
    runtimeStatus: verified.runtimeStatus,
    ...(outcome.updatedExisting ? { updatedExisting: true as const } : {})
  }
}

/** Replace pairing only after verifying the saved host key; invalid or foreign links leave it untouched. */
export async function verifyAndRepairRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: RepairRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const existing = await resolveEnvironment(userDataPath, args.selector)
  if (isEphemeralVmRuntimeEnvironment(existing)) {
    return pairingSaveFailure(null, 'repairCloudWorkspace')
  }
  const saved = getPreferredPairingOffer(existing)
  // SSH tunnel pairings legitimately use loopback links.
  const verified = await verifyPairingCode(
    args.pairingCode,
    existing.connectionDependency === 'ssh-tunnel',
    args
  )
  if (!verified.ok) {
    return verified
  }
  // An open-access pairing pins nothing permanent: any key from the reached host is accepted and
  // re-saved, which is how a cloned machine with the same keypair (or a genuinely new one) heals.
  if ('openAccess' in verified) {
    if (saved.openAccess !== true && saved.publicKeyB64 !== verified.offer.publicKeyB64) {
      return {
        ok: false,
        kind: 'different-server',
        message: 'This pairing link is for a different server.'
      }
    }
  } else if (verified.link.pairing.publicKeyB64 !== saved.publicKeyB64) {
    return {
      ok: false,
      kind: 'different-server',
      message: 'This pairing link is for a different server.'
    }
  }
  const pairingCode =
    'openAccess' in verified
      ? encodeOpenAccessPairingCode(verified)
      : await exchangeRemotePairingTicket({
          pairingCode: args.pairingCode,
          offer: verified.link.pairing,
          hostCapabilities: verified.runtimeStatus.capabilities
        })
  let environment: Awaited<ReturnType<typeof updateEnvironmentFromPairingCode>>
  try {
    environment = await updateEnvironmentFromPairingCode(userDataPath, existing.id, {
      pairingCode,
      // The verified same host may have restarted with a new runtimeId.
      runtimeId: verified.runtimeStatus.runtimeId
    })
  } catch (error) {
    return pairingSaveFailure(error, 'repairSaveFailed')
  }
  return {
    ok: true,
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus: verified.runtimeStatus
  }
}

/** A store refusal keeps its own message and code; anything else gets the generic save failure. */
function pairingSaveFailure(
  error: unknown,
  fallback: RemoteServerPairingFailureCode
): RemotePairingFailure {
  if (error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument') {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message: error.message,
      ...error.pairingFailure
    }
  }
  return {
    ok: false,
    kind: 'environment-save-failed',
    message: remoteServerPairingFailureText(fallback),
    errorCode: fallback
  }
}
