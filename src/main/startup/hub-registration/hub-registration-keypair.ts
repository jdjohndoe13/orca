// This profile's E2EE public key, read asynchronously.
//
// The same file as `shared/remote-runtime/host-store/runtime-e2ee-keypair-file`
// — `orca-e2ee-keypair.json` in the profile's userData dir — and the same
// validation: the base64 body must decode to a 32-byte Ed25519 key, or the
// profile has no usable keypair. The instance id is derived from exactly these
// bytes, so a VM that read the wrong key would register an identity the hub
// cannot verify against anything it can later reach.
//
// The shared reader is synchronous, and it is correct there: it serves the
// host-store worker. This module runs on the serve startup path in the main
// process, where the ratchet charges every synchronous fs call, so it reads
// through `fs.promises` instead. The startup hook prefers the RPC server's own
// already-loaded key, so this file read is the fallback, not the common path.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  E2EE_KEYPAIR_FILENAME,
  MAX_E2EE_KEYPAIR_FILE_BYTES
} from '../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'

const ED25519_PUBLIC_KEY_BYTES = 32

/** The profile's runtime public key, or null when it has none or it is unreadable. */
export async function readProfileRuntimePublicKeyAsync(
  userDataPath: string
): Promise<Buffer | null> {
  try {
    const raw = await readFile(join(userDataPath, E2EE_KEYPAIR_FILENAME))
    if (raw.byteLength > MAX_E2EE_KEYPAIR_FILE_BYTES) {
      return null
    }
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof value !== 'object' || value === null || !('publicKeyB64' in value)) {
      return null
    }
    // The `in` guard narrows the property to unknown; the typeof check below
    // is the validation. Same shape as the shared keypair reader.
    const publicKeyB64 = value.publicKeyB64
    if (typeof publicKeyB64 !== 'string') {
      return null
    }
    const key = Buffer.from(publicKeyB64, 'base64')
    return key.length === ED25519_PUBLIC_KEY_BYTES ? key : null
  } catch {
    return null
  }
}
