import {
  hubListUrl,
  normalizeHubUrl,
  type HubLinkRecord
} from '../../../../shared/remote-runtime/hub/hub-link-records'
import {
  parseHubInstanceList,
  type HubInstanceList,
  type HubInstanceRow
} from '../../../../shared/remote-runtime/hub/hub-instance-rows'

// The hub's list is fetched here, in the main process: the renderer never sees the access key
// beyond the moment it is typed, and the fetch must not become a renderer-side network primitive.

const HUB_LIST_TIMEOUT_MS = 8000
const HUB_LIST_MAX_BYTES = 1024 * 1024

export type HubListFailure =
  | 'unreachable'
  | 'unauthorized'
  | 'unsupported'
  | 'malformed'
  | 'too-large'

export type HubListResult =
  | { ok: true; instances: HubInstanceRow[]; hubId: string | null; unreadableCount: number }
  | { ok: false; failure: HubListFailure }

export type HubFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<Response>

/** Fetch one hub's instance list. Failures are typed, never thrown: an unreachable hub is normal. */
export async function fetchHubInstanceList(
  link: Pick<HubLinkRecord, 'hubUrl' | 'accessKey'>,
  fetchImpl: HubFetch = fetch
): Promise<HubListResult> {
  const normalized = normalizeHubUrl(link.hubUrl)
  if (!normalized.ok) {
    return { ok: false, failure: 'unsupported' }
  }
  let response: Response
  try {
    response = await fetchImpl(hubListUrl(normalized.value), {
      headers: { 'x-orca-access-key': link.accessKey, accept: 'application/json' },
      signal: AbortSignal.timeout(HUB_LIST_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, failure: 'unreachable' }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, failure: 'unauthorized' }
  }
  if (!response.ok) {
    return { ok: false, failure: 'unsupported' }
  }
  let body: unknown
  try {
    const text = await response.text()
    if (new TextEncoder().encode(text).length > HUB_LIST_MAX_BYTES) {
      return { ok: false, failure: 'too-large' }
    }
    body = JSON.parse(text)
  } catch {
    return { ok: false, failure: 'malformed' }
  }
  const parsed = parseHubInstanceList(response.status, body)
  if (!parsed.ok) {
    return {
      ok: false,
      failure: parsed.reason === 'status' ? statusFailure(parsed.status) : 'malformed'
    }
  }
  return listResult(parsed.value)
}

function statusFailure(status: number): HubListFailure {
  return status === 401 || status === 403 ? 'unauthorized' : 'unsupported'
}

function listResult(list: HubInstanceList): HubListResult {
  return {
    ok: true,
    instances: list.instances,
    hubId: list.hubId,
    unreadableCount: list.unreadableCount
  }
}
