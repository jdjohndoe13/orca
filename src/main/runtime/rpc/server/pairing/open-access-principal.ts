// Fork extension: the synthetic open-access principal and its live mode gate.
// Lives beside the registry so device-registry stays inside its max-lines budget.
import {
  OPEN_ACCESS_DEVICE_ID,
  OPEN_ACCESS_DEVICE_NAME
} from '../../../../../shared/remote-runtime/open-access/open-access'
import type { AuthenticatedPrincipalBinding, DeviceEntry } from './device-entry'
import { readOpenAccessModeFile } from './open-access-mode'

/**
 * Why: the open-access principal is rebuilt from the presented token on every check and never
 * enters the registry's device rows, so it cannot be persisted, listed, or revoked as a row —
 * toggling the mode file off is the only revoke, and it takes effect on the next request.
 */
export function openAccessDevice(token: string): DeviceEntry {
  return {
    deviceId: OPEN_ACCESS_DEVICE_ID,
    name: OPEN_ACCESS_DEVICE_NAME,
    token,
    scope: 'runtime',
    pairedAt: 0,
    lastSeenAt: 0,
    pairingReach: 'network',
    grants: []
  }
}

/** The mode file says on; read live per auth path so the toggle needs no restart. */
export function openAccessEnabledForPath(path: string | null): boolean {
  return path !== null && readOpenAccessModeFile(path).acceptAnyAccessKey
}

/**
 * Open-access LAN mode: any token presentation authenticates as the synthetic principal.
 * Nothing is persisted — the synthetic row never enters the registry rows, so the registry
 * file is untouched and the toggle itself is the only revocation.
 */
export function openAccessToken(path: string | null, token: string): DeviceEntry | null {
  return token && openAccessEnabledForPath(path) ? openAccessDevice(token) : null
}

/**
 * A socket whose presented token resolved to the synthetic open-access principal has no
 * row to swap its token on: exchanging is a no-op, not a failure — the client keeps its
 * token on any error anyway. The synthetic id is only ever minted by the open-access auth
 * path, so it cannot collide with a real row (those ids are UUIDs).
 */
export function openAccessNoop(path: string | null, deviceId: string): boolean {
  return deviceId === OPEN_ACCESS_DEVICE_ID && openAccessEnabledForPath(path)
}

/**
 * Recheck a live socket's synthetic principal: it authenticates only while the mode file
 * still says on, so toggling off revokes connected sockets immediately. The binding's token
 * is the credential the E2EE handshake proved; the synthetic row carries no
 * credentialRevision, so any binding revision matches.
 */
export function openAccessPrincipal(
  path: string | null,
  principal: AuthenticatedPrincipalBinding
): DeviceEntry | null {
  return openAccessEnabledForPath(path) && principal.deviceToken !== undefined
    ? openAccessDevice(principal.deviceToken)
    : null
}
