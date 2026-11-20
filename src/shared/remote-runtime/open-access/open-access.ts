// Fork extension: "accept any access key" LAN mode.
// A host with this mode enabled authenticates ANY token presentation, so a cloned
// machine (same E2EE keypair) is reachable by IP without carrying a fresh link.
// Trust model: LAN-only. The pinned public key still anchors the E2EE channel; the
// token stops being a secret. Never enable this on an untrusted network.

/** Fixed bearer any client may present when the host accepts any access key. */
export const DEFAULT_ORCA_ACCESS_KEY = 'default_orca_access_key' as const

/** File in the host's userData dir recording the open-access mode; clones carry it. */
export const OPEN_ACCESS_MODE_FILENAME = 'orca-open-access.json' as const

/** Synthetic device id the open-access principal authenticates as. Never a real row. */
export const OPEN_ACCESS_DEVICE_ID = 'open-access' as const

/** Display name for the open-access principal in grant lists and logs. */
export const OPEN_ACCESS_DEVICE_NAME = 'Open access (any key)' as const

/**
 * Advertised runtime capability so clients can offer IP-only pairing without
 * guessing. Keep zod/crypto out: capability strings reach every bundle.
 */
export const OPEN_ACCESS_RUNTIME_CAPABILITY = 'open.access.v1' as const

export type OpenAccessModeFile = {
  /** Accept any token at E2EE auth and per-request token checks. */
  acceptAnyAccessKey: boolean
}

const OPEN_ACCESS_MODE_DEFAULT: OpenAccessModeFile = { acceptAnyAccessKey: false }

export function parseOpenAccessModeFile(raw: string): OpenAccessModeFile {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return OPEN_ACCESS_MODE_DEFAULT
    }
    const value = (parsed as Record<string, unknown>).acceptAnyAccessKey
    return typeof value === 'boolean' ? { acceptAnyAccessKey: value } : OPEN_ACCESS_MODE_DEFAULT
  } catch {
    return OPEN_ACCESS_MODE_DEFAULT
  }
}

export function encodeOpenAccessModeFile(mode: OpenAccessModeFile): string {
  return JSON.stringify(mode, null, 2)
}
