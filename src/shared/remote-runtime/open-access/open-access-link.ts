// Client-side "connect by IP": the Add-server form can dial an open-access host (one that accepts
// any access key) with just an address, no link. The offer built here is a normal pairing offer
// except that its host key is a placeholder: the real key is pinned on first use (TOFU), which
// pairedRuntimeConnectionFromOffer enables from the openAccess flag.
import { DEFAULT_ORCA_ACCESS_KEY } from './open-access'
import { PAIRING_OFFER_VERSION, type PairingOffer } from '../pairing/mobile-relay-pairing-offer'
import {
  classifyRemotePairingHostname,
  type ParsedHostAccessLink,
  type RemotePairingEndpointKind
} from '../pairing/remote-pairing-address'
import { isPairingWildcardHostname } from '../../network/pairing-url'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../pairing/mobile-pairing-protocol-limits'

// Why literal: the host's own DEFAULT_WS_PORT lives behind the main-process boundary; the client
// must not import it, and a bare address without a port has to dial somewhere standard.
const OPEN_ACCESS_DEFAULT_PORT = 6768

/**
 * Placeholder host key for an open-access pairing. Not a key: 4 characters, so it can never
 * collide with a real 32-byte Curve25519 key, and the endpoint schema only requires min(1).
 */
export const OPEN_ACCESS_HOST_KEY_PLACEHOLDER = 'TOFU'

export function isPlaceholderHostKey(publicKeyB64: string): boolean {
  // Why the same spelling as host-key matching: pairing links accept unpadded and URL-safe base64.
  return (
    publicKeyB64.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') ===
    OPEN_ACCESS_HOST_KEY_PLACEHOLDER
  )
}

export type OpenAccessEndpoint = {
  endpoint: string
  displayEndpoint: string
  endpointKind: RemotePairingEndpointKind
}

export type NormalizeOpenAccessEndpointResult =
  | { ok: true; value: OpenAccessEndpoint }
  | { ok: false; message: string }

/**
 * Accept "host", "host:port" (or "[ipv6]:port") and ws(s):// URLs, and normalize to a connectable
 * websocket URL. Rejects empty, whitespace, wildcards (0.0.0.0/::), paths, and http(s):// URLs —
 * an open-access dial names a runtime endpoint, not a web page.
 */
export function normalizeOpenAccessEndpoint(input: string): NormalizeOpenAccessEndpointResult {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > PAIRING_ENDPOINT_MAX_CHARACTERS) {
    return {
      ok: false,
      message: 'Enter an address like 192.168.250.29:6768 or ws://192.168.250.29:6768.'
    }
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, message: 'The address contains spaces.' }
  }
  if (trimmed.includes('://')) {
    return normalizeOpenAccessUrl(trimmed)
  }
  return normalizeOpenAccessBareAddress(trimmed)
}

function normalizeOpenAccessUrl(value: string): NormalizeOpenAccessEndpointResult {
  // Why reject http(s): the spec for this form is ws(s) or bare host:port; silently upgrading a
  // typed http:// URL would dial a scheme the runtime server never speaks.
  if (/^https?:\/\//i.test(value)) {
    return { ok: false, message: 'Use a ws:// or wss:// address, not http(s).' }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, message: 'The address is not a valid URL.' }
  }
  const invalid =
    (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
    !url.hostname ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port === '0' ||
    isPairingWildcardHostname(url.hostname)
  if (invalid) {
    return { ok: false, message: 'The address must be a bare ws:// or wss:// endpoint.' }
  }
  return openAccessEndpointFromUrl(url)
}

function normalizeOpenAccessBareAddress(value: string): NormalizeOpenAccessEndpointResult {
  // Bracketed IPv6 is the only unambiguous way to write an IPv6 with a port; a bare value with
  // "::" is an IPv6 without one. Anything else is host or host:port on the last colon.
  const bracketed = value.match(/^(\[[^\]]+\])(?::(\d+))?$/)
  let host: string
  let port: string
  if (bracketed) {
    host = bracketed[1]!
    port = bracketed[2] ?? ''
  } else if (value.includes('::')) {
    host = `[${value}]`
    port = ''
  } else if (/^[^:]+:\d+$/.test(value)) {
    const split = value.lastIndexOf(':')
    host = value.slice(0, split)
    port = value.slice(split + 1)
  } else if (!value.includes(':')) {
    host = value
    port = ''
  } else {
    return { ok: false, message: 'The address is not a valid host or host:port.' }
  }
  if (port !== '' && (/^0\d|^0$/.test(port) || !/^\d+$/.test(port) || Number(port) > 65_535)) {
    return { ok: false, message: 'The port must be between 1 and 65535.' }
  }
  const effectivePort = port === '' ? String(OPEN_ACCESS_DEFAULT_PORT) : port
  let url: URL
  try {
    url = new URL(`ws://${host}:${effectivePort}`)
  } catch {
    return { ok: false, message: 'The address is not a valid host or host:port.' }
  }
  if (isPairingWildcardHostname(url.hostname)) {
    return { ok: false, message: 'That address is not connectable.' }
  }
  return openAccessEndpointFromUrl(url)
}

function openAccessEndpointFromUrl(url: URL): { ok: true; value: OpenAccessEndpoint } {
  const endpoint = url.toString().replace(/\/$/, '')
  return {
    ok: true,
    value: {
      endpoint,
      displayEndpoint: url.host,
      endpointKind: classifyRemotePairingHostname(url.hostname)
    }
  }
}

/** An open-access offer: default token, placeholder key, TOFU flag, runtime scope. */
export function buildOpenAccessPairing(address: string): PairingOffer | null {
  const normalized = normalizeOpenAccessEndpoint(address)
  if (!normalized.ok) {
    return null
  }
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: normalized.value.endpoint,
    deviceToken: DEFAULT_ORCA_ACCESS_KEY,
    publicKeyB64: OPEN_ACCESS_HOST_KEY_PLACEHOLDER,
    scope: 'runtime',
    openAccess: true
  }
}

/** Rebuild a parsed link with the typed address as endpoint; the host key stays the link's. */
export function applyEndpointOverride(
  link: ParsedHostAccessLink,
  endpointOverride: string
): { ok: true; value: ParsedHostAccessLink } | { ok: false; message: string } {
  if (endpointOverride === '') {
    return { ok: true, value: link }
  }
  const normalized = normalizeOpenAccessEndpoint(endpointOverride)
  if (!normalized.ok) {
    return { ok: false, message: normalized.message }
  }
  return {
    ok: true,
    value: {
      pairing: { ...link.pairing, endpoint: normalized.value.endpoint },
      displayEndpoint: normalized.value.displayEndpoint,
      endpointKind: normalized.value.endpointKind
    }
  }
}

/** Swap the link's token, e.g. for the host's fixed default access key. Empty means keep. */
export function applyDeviceTokenOverride(
  link: ParsedHostAccessLink,
  deviceTokenOverride: string
): ParsedHostAccessLink {
  if (deviceTokenOverride === '') {
    return link
  }
  return { ...link, pairing: { ...link.pairing, deviceToken: deviceTokenOverride } }
}
