// Pure arg handling for the pairing verification IPC: override application and the open-access
// verified shape. Kept free of electron imports so the rules are unit-testable directly.
import type { PairingOffer } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { ParsedHostAccessLink } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'

export {
  applyEndpointOverride,
  applyDeviceTokenOverride
} from '../../../../shared/remote-runtime/open-access/open-access-link'

export type VerifiedPairing = {
  ok: true
  link: ParsedHostAccessLink
  runtimeStatus: RuntimeStatus
}

/** IP-only mode verified: the offer is built from the address, not parsed from a link. */
export type OpenAccessVerifiedPairing = {
  ok: true
  openAccess: true
  offer: PairingOffer
  runtimeStatus: RuntimeStatus
}

/** An open-access pairing has no link to burn: the saved code is the built offer itself. */
export function encodeOpenAccessPairingCode(
  verified: Pick<OpenAccessVerifiedPairing, 'offer'>
): string {
  return encodePairingOffer(verified.offer)
}
