import type { PairedE2EEAuthCredential } from '../e2ee/paired-e2ee-client-handshake'
import type { PairingOffer } from './mobile-relay-pairing-offer'

// Connections carry credentials that may evolve beyond tokens; PairingOffer describes pairing input instead.
export type PairedRuntimeConnection = {
  endpoint: string
  hostPublicKeyB64: string
  credential: PairedE2EEAuthCredential
  pairedDeviceId?: string
  /**
   * Open-access dial: the saved host key is a placeholder, so the E2EE v2 handshake pins the
   * first key the host presents. Only pairing offers that carry the placeholder set this.
   */
  trustOnFirstUse?: boolean
}

type OfferConnectionFields = Pick<
  PairingOffer,
  'endpoint' | 'deviceToken' | 'publicKeyB64' | 'pairedDeviceId'
> &
  Partial<Pick<PairingOffer, 'v' | 'scope' | 'openAccess'>>

export function pairedRuntimeConnectionFromOffer(
  offer: OfferConnectionFields
): PairedRuntimeConnection {
  return {
    endpoint: offer.endpoint,
    hostPublicKeyB64: offer.publicKeyB64,
    credential: { kind: 'token', deviceToken: offer.deviceToken },
    ...(offer.pairedDeviceId ? { pairedDeviceId: offer.pairedDeviceId } : {}),
    // Why the flag, not the key text: the placeholder is a marker, not a key; real offers never
    // decode to it, so a saved endpoint without the flag can never dial unverified.
    ...(offer.openAccess ? { trustOnFirstUse: true } : {})
  }
}

// The token request envelopes still carry on the wire.
export function pairedRuntimeConnectionToken(connection: PairedRuntimeConnection): string {
  return connection.credential.deviceToken
}
