import { parseHostAccessLink } from '../pairing/remote-pairing-address'
import { normalizeOpenAccessEndpoint } from '../open-access/open-access-link'
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'

/** Choose host, host:port, then numbered suffixes so servers sharing a machine/address still get unique blank-name defaults. */
export function defaultServerNameForAccessLink(
  accessLink: string,
  existing: readonly { name: string }[] = []
): string {
  const parsed = parseHostAccessLink(accessLink)
  if (!parsed.ok) {
    return ''
  }
  return defaultServerNameForEndpoint(parsed.value.displayEndpoint, existing)
}

/** Same candidate rules for an open-address (connect-by-IP) entry, so blank names match the link flow. */
export function defaultServerNameForOpenAccessAddress(
  address: string,
  existing: readonly { name: string }[] = []
): string {
  const normalized = normalizeOpenAccessEndpoint(address)
  return normalized.ok ? defaultServerNameForEndpoint(normalized.value.displayEndpoint, existing) : ''
}

function defaultServerNameForEndpoint(
  endpoint: string,
  existing: readonly { name: string }[]
): string {
  let host = endpoint
  try {
    host = new URL(`ws://${endpoint}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    // Not URL-shaped; the endpoint itself is the best name.
  }
  for (const candidate of host === endpoint ? [host] : [host, endpoint]) {
    if (!findCollidingEnvironmentName(existing, candidate)) {
      return candidate
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${host} (${suffix})`
    if (!findCollidingEnvironmentName(existing, candidate)) {
      return candidate
    }
  }
}
