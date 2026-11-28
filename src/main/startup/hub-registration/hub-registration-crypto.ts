// Hub registration crypto: the instance id and the key-match digest.
//
// These two functions are the whole trust story between a VM and a hub, and
// they must agree with the hub byte-for-byte or the hub refuses every
// registration this VM makes:
//
//   instanceId = base64url(sha256(raw public key))[:22]
//   keyMatch   = base64url(HMAC-SHA256(key='accessKey',
//                     msg='orca-hub-keymatch/v1' || instanceId))
//
// The hub recomputes the id from the public key it received (§5.3.3), so a
// VM can only claim an identity it can prove with the E2EE keypair already on
// disk. The access key never crosses the wire: the hub stores only the digest,
// so a hub compromise leaks nothing reusable (§4).
//
// The reference implementation lives in `orca-hub/src/hub/crypto.ts`; the
// conformance test asserts equality against a known vector.

import { createHash, createHmac } from 'node:crypto'

const KEY_MATCH_DOMAIN = 'orca-hub-keymatch/v1'
const INSTANCE_ID_BYTES = 22

/** Stable per-instance identity derived from the VM's E2EE public key. */
export function instanceIdFromPublicKey(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64')
  if (raw.length === 0) {
    throw new Error('public key is empty')
  }
  return createHash('sha256').update(raw).digest('base64url').slice(0, INSTANCE_ID_BYTES)
}

/** The digest a VM registers and the hub recomputes from a client's key. */
export function keyMatchFor(accessKey: string, instanceId: string): string {
  return createHmac('sha256', accessKey)
    .update(KEY_MATCH_DOMAIN)
    .update(instanceId)
    .digest('base64url')
}
