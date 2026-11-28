import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { isPairingWildcardHostname } from '../../network/pairing-url'

// A "hub record" is the client's pointer to an Orca hub: where it is and the access key that
// unlocks its instance list. Instances are never stored here — they are derived rows (see
// hub-environment-rows) rebuilt from the hub's list so a hub's re-IP changes nothing on disk.

const HUB_URL_MAX_CHARACTERS = 2048
const HUB_ACCESS_KEY_MAX_CHARACTERS = 64 * 1024

export const HUB_LINK_RECORD_SCHEMA = lazyZodSchema(() =>
  z.object({
    hubUrl: z.string().min(1).max(HUB_URL_MAX_CHARACTERS),
    accessKey: z.string().min(1).max(HUB_ACCESS_KEY_MAX_CHARACTERS),
    addedAt: z.number().finite()
  })
)

export type HubLinkRecord = z.infer<typeof HUB_LINK_RECORD_SCHEMA>

export type NormalizeHubUrlResult = { ok: true; value: string } | { ok: false; message: string }

/**
 * Accept `hub.example.com`, `hub.example.com:6770`, `ws(s)://…` and `http(s)://…` and normalize to
 * a `wss://` (or `ws://` for loopback/plaintext) origin. The hub serves its list over http(s) and
 * its bridge over ws(s); both are derived from this one origin, so it is stored as a ws(s) origin.
 */
export function normalizeHubUrl(input: string): NormalizeHubUrlResult {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > HUB_URL_MAX_CHARACTERS) {
    return { ok: false, message: 'Enter the hub address, like hub.example.com:6770.' }
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, message: 'The hub address contains spaces.' }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, message: 'The hub address is not a valid URL.' }
  }
  const scheme = httpToWsScheme(url.protocol)
  if (!scheme || !url.hostname || url.username || url.password) {
    return { ok: false, message: 'The hub address must be a bare host or ws(s):// origin.' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' || url.search !== '' || url.hash !== '') {
    return { ok: false, message: 'The hub address must not include a path or query.' }
  }
  if (isPairingWildcardHostname(url.hostname)) {
    return { ok: false, message: 'That hub address is not connectable.' }
  }
  const normalized = new URL(`${scheme}://${url.host}`)
  return { ok: true, value: normalized.origin }
}

function httpToWsScheme(protocol: string): 'ws' | 'wss' | null {
  if (protocol === 'ws:' || protocol === 'wss:') {
    return protocol === 'ws:' ? 'ws' : 'wss'
  }
  if (protocol === 'http:' || protocol === 'https:') {
    return protocol === 'http:' ? 'ws' : 'wss'
  }
  return null
}

/** The hub's instance list, which the hub serves over http(s) on the same origin as its bridge. */
export function hubListUrl(hubUrl: string): string {
  const url = new URL(hubUrl)
  const scheme = url.protocol === 'ws:' ? 'http:' : 'https:'
  return `${scheme}//${url.host}/v1/list`
}

/** The bridge websocket a client dials for one instance; the hub's own `bridgePath` is the truth. */
export function hubBridgeEndpoint(hubUrl: string, bridgePath: string): string {
  const url = new URL(hubUrl)
  const path = bridgePath.startsWith('/') ? bridgePath : `/${bridgePath}`
  return `${url.origin}${path.replace(/\/+$/, '')}`
}
