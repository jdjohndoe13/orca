import { join } from 'node:path'
import { stringifyJsonWithinByteLimit } from '../../json-stream/node-bounded-json-stringify'
import { writeSecureFile } from '../../secure-storage/secure-file'
import { readEnvironmentRegistryFile } from './runtime-environment-store-observation'
import {
  HUB_LINK_RECORD_SCHEMA,
  normalizeHubUrl,
  type HubLinkRecord
} from '../hub/hub-link-records'

// Hub links live in their own file so an older build cannot reject the pairing store, and so a
// link's access key never rides along in orca-environments.json. Same isolation as the WSL
// deployments file. Records stay opaque at the envelope level: one unreadable record is dropped
// rather than hiding every hub.

const HUB_LINKS_FILE = 'orca-hub-links.json'
export const MAX_HUB_LINKS_FILE_BYTES = 64 * 1024

export class HubLinkStoreInvalidError extends Error {
  constructor(path: string) {
    super(`Could not read Orca hub links at ${path}; the file is invalid.`)
    this.name = 'HubLinkStoreInvalidError'
  }
}

export function getHubLinkStorePath(userDataPath: string): string {
  return join(userDataPath, HUB_LINKS_FILE)
}

export type HubLinks = { links: HubLinkRecord[]; unreadableCount: number }

export function readHubLinks(userDataPath: string): HubLinks {
  const path = getHubLinkStorePath(userDataPath)
  let text: string
  try {
    const read = readEnvironmentRegistryFile(path, MAX_HUB_LINKS_FILE_BYTES)
    if (!read) {
      return { links: [], unreadableCount: 0 }
    }
    text = read.buffer.toString('utf8')
  } catch {
    throw new HubLinkStoreInvalidError(path)
  }
  return parseHubLinksText(path, text)
}

export function parseHubLinksText(path: string, text: string): HubLinks {
  let raws: unknown[]
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('links' in parsed) ||
      !Array.isArray(parsed.links)
    ) {
      throw new Error('missing links array')
    }
    raws = parsed.links
  } catch {
    throw new HubLinkStoreInvalidError(path)
  }
  const links: HubLinkRecord[] = []
  let unreadableCount = 0
  for (const raw of raws) {
    const record = HUB_LINK_RECORD_SCHEMA.safeParse(raw)
    if (record.success) {
      links.push(record.data)
    } else {
      unreadableCount += 1
    }
  }
  links.sort((a, b) => a.hubUrl.localeCompare(b.hubUrl))
  return { links, unreadableCount }
}

export function writeHubLinks(userDataPath: string, links: readonly HubLinkRecord[]): void {
  const path = getHubLinkStorePath(userDataPath)
  writeSecureFile(
    path,
    stringifyJsonWithinByteLimit(
      { version: 1, links: [...links].sort((a, b) => a.hubUrl.localeCompare(b.hubUrl)) },
      MAX_HUB_LINKS_FILE_BYTES
    ).serialized,
    { durable: true }
  )
}

export type HubLinkMutation = {
  links: HubLinkRecord[]
  /** What the call did, so the caller can report it without re-reading. */
  kind: 'added' | 'updated' | 'removed' | 'unchanged'
}

/** The access key is a secret a user pastes, so it is stored as given, trimmed, and never derived. */
export function addHubLink(
  userDataPath: string,
  args: { hubUrl: string; accessKey: string; now?: number }
): HubLinkMutation {
  const normalized = normalizeHubUrl(args.hubUrl)
  if (!normalized.ok) {
    throw new Error(normalized.message)
  }
  const accessKey = args.accessKey.trim()
  if (accessKey === '') {
    throw new Error('The hub access key is required.')
  }
  const { links } = readHubLinks(userDataPath)
  const existing = links.find((link) => link.hubUrl === normalized.value)
  if (existing && existing.accessKey === accessKey) {
    return { links, kind: 'unchanged' }
  }
  const record: HubLinkRecord = {
    hubUrl: normalized.value,
    accessKey,
    addedAt: existing?.addedAt ?? args.now ?? Date.now()
  }
  const next = [...links.filter((link) => link.hubUrl !== normalized.value), record]
  writeHubLinks(userDataPath, next)
  return { links: next, kind: existing ? 'updated' : 'added' }
}

export function removeHubLink(userDataPath: string, hubUrl: string): HubLinkMutation {
  const normalized = normalizeHubUrl(hubUrl)
  if (!normalized.ok) {
    throw new Error(normalized.message)
  }
  const { links } = readHubLinks(userDataPath)
  if (!links.some((link) => link.hubUrl === normalized.value)) {
    return { links, kind: 'unchanged' }
  }
  const next = links.filter((link) => link.hubUrl !== normalized.value)
  writeHubLinks(userDataPath, next)
  return { links: next, kind: 'removed' }
}
