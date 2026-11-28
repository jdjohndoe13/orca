import {
  addHubLink,
  pruneHubEnvironmentsForLinks,
  readHubLinks,
  removeHubEnvironmentsForHub,
  removeHubLink,
  syncHubEnvironments
} from '../../../../shared/remote-runtime/host-store/runtime-environment-hub-store'
import { normalizeHubUrl } from '../../../../shared/remote-runtime/hub/hub-link-records'
import type { HubAddResult } from '../../../../shared/remote-runtime/hub/hub-link-ipc-types'
import { fetchHubInstanceList } from './runtime-environment-hub-list-fetch'
import { publishRuntimeEnvironmentCatalogChanged } from '../catalog/runtime-environment-catalog-broadcast'

// The hub record is the client's whole relationship with a hub: it is stored, and its instances
// are rows derived from the hub's list. Everything here runs in the main process — the list fetch
// is a network call, and the store writes go through the environment store worker.

export type HubSyncOutcome = {
  hubUrl: string
  ok: boolean
  /** 'unreachable' | 'unauthorized' | … when the list could not be fetched. */
  failure?: string
  upserted: number
  removed: number
  skipped: number
}

export async function listHubLinksForIpc(
  userDataPath: string
): Promise<{ hubUrl: string; addedAt: number }[]> {
  const { links } = await readHubLinks(userDataPath)
  // The access key stays in main: the renderer only needs to know which hubs are configured.
  return links.map((link) => ({ hubUrl: link.hubUrl, addedAt: link.addedAt }))
}

/** Store a hub link and immediately mirror its instances into the environment catalog. */
export async function addHubLinkAndSync(
  userDataPath: string,
  args: { hubUrl: string; accessKey: string }
): Promise<HubAddResult> {
  const normalized = normalizeHubUrl(args.hubUrl)
  if (!normalized.ok) {
    return { ok: false, message: normalized.message }
  }
  try {
    const { links } = await addHubLink(userDataPath, args)
    const saved = links.find((link) => link.hubUrl === normalized.value)
    if (!saved) {
      return { ok: false, message: 'The hub address could not be saved.' }
    }
    const outcome = await syncOneHub(userDataPath, saved)
    publishRuntimeEnvironmentCatalogChanged()
    // The link is kept even when the hub was unreachable: the key may be right and the hub just
    // down, and the next sync (or startup) retries. `listed` tells the dialog why it's empty.
    return {
      ok: true,
      hubUrl: saved.hubUrl,
      instances: outcome.upserted,
      listed: outcome.ok
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function removeHubLinkAndRows(
  userDataPath: string,
  hubUrl: string
): Promise<{ removed: number }> {
  const removed = await removeHubEnvironmentsForHub(userDataPath, hubUrl)
  await removeHubLink(userDataPath, hubUrl)
  publishRuntimeEnvironmentCatalogChanged()
  return removed
}

/**
 * Re-sync every hub link. Runs at startup and whenever a link changes. A hub that is down keeps
 * the rows from its last good list: an unreachable hub is not an empty hub.
 */
export async function syncAllHubLinks(userDataPath: string): Promise<HubSyncOutcome[]> {
  const outcomes: HubSyncOutcome[] = []
  const { links } = await readHubLinks(userDataPath)
  // Rows whose hub is no longer a link (the file was edited while Orca was closed) go first: the
  // surviving link set is the only authority over which hubs may own rows.
  const pruned = await pruneHubEnvironmentsForLinks(
    userDataPath,
    links.map((link) => link.hubUrl)
  )
  if (pruned.removed > 0) {
    publishRuntimeEnvironmentCatalogChanged()
  }
  for (const link of links) {
    outcomes.push(await syncOneHub(userDataPath, link))
  }
  if (outcomes.some((outcome) => outcome.upserted > 0 || outcome.removed > 0)) {
    publishRuntimeEnvironmentCatalogChanged()
  }
  return outcomes
}

async function syncOneHub(
  userDataPath: string,
  link: { hubUrl: string; accessKey: string }
): Promise<HubSyncOutcome> {
  const listed = await fetchHubInstanceList(link)
  if (!listed.ok) {
    return {
      hubUrl: link.hubUrl,
      ok: false,
      failure: listed.failure,
      upserted: 0,
      removed: 0,
      skipped: 0
    }
  }
  const result = await syncHubEnvironments(userDataPath, {
    hubUrl: link.hubUrl,
    accessKey: link.accessKey,
    instances: listed.instances
  })
  return {
    hubUrl: link.hubUrl,
    ok: true,
    upserted: result.upserted,
    removed: result.removed,
    skipped: result.skipped.length
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to add the hub.'
}
