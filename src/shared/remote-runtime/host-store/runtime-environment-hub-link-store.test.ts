import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import {
  addHubLink,
  getHubLinkStorePath,
  readHubLinks,
  removeHubLink
} from './runtime-environment-hub-link-store'
import {
  pruneHubEnvironmentsForLinks,
  syncHubEnvironments
} from './runtime-environment-hub-row-operations'

function key(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64')
}

function instance(
  id: string,
  name: string
): {
  instanceId: string
  name: string
  publicKeyB64: string
  ports: number[]
  capabilities: string[]
  bridgePath: string
} {
  return {
    instanceId: id,
    name,
    publicKeyB64: key(1),
    ports: [],
    capabilities: [],
    bridgePath: `/v1/bridge/${id}`
  }
}

describe('hub link store', () => {
  const tempDirs: string[] = []
  const userData = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hub-links-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('reports no links when the file is absent', () => {
    expect(readHubLinks(userData())).toEqual({ links: [], unreadableCount: 0 })
  })

  it('saves a link with a normalized url and the key as typed', () => {
    const dir = userData()
    const result = addHubLink(dir, {
      hubUrl: 'hub.example.com:6770',
      accessKey: '  secret  ',
      now: 1000
    })
    expect(result.kind).toBe('added')
    expect(result.links).toEqual([
      { hubUrl: 'wss://hub.example.com:6770', accessKey: 'secret', addedAt: 1000 }
    ])
    expect(readHubLinks(dir).links).toEqual(result.links)
  })

  it('replaces the key of an existing link instead of adding a second one', () => {
    const dir = userData()
    addHubLink(dir, { hubUrl: 'wss://hub.example.com', accessKey: 'a', now: 1000 })
    const result = addHubLink(dir, { hubUrl: 'hub.example.com', accessKey: 'b', now: 2000 })
    expect(result.kind).toBe('updated')
    expect(result.links).toEqual([
      { hubUrl: 'wss://hub.example.com', accessKey: 'b', addedAt: 1000 }
    ])
  })

  it('writes nothing when the same link and key are saved again', () => {
    const dir = userData()
    addHubLink(dir, { hubUrl: 'wss://hub.example.com', accessKey: 'a', now: 1000 })
    const before = readFileSync(getHubLinkStorePath(dir), 'utf8')
    expect(addHubLink(dir, { hubUrl: 'wss://hub.example.com', accessKey: 'a' }).kind).toBe(
      'unchanged'
    )
    expect(readFileSync(getHubLinkStorePath(dir), 'utf8')).toBe(before)
  })

  it('refuses an empty key and a bad address', () => {
    const dir = userData()
    expect(() => addHubLink(dir, { hubUrl: 'wss://hub.example.com', accessKey: '  ' })).toThrow(
      /access key/
    )
    expect(() => addHubLink(dir, { hubUrl: '0.0.0.0', accessKey: 'a' })).toThrow(/not connectable/)
  })

  it('removes a link and reports when it was not there', () => {
    const dir = userData()
    addHubLink(dir, { hubUrl: 'wss://hub.example.com', accessKey: 'a' })
    expect(removeHubLink(dir, 'hub.example.com').kind).toBe('removed')
    expect(readHubLinks(dir).links).toEqual([])
    expect(removeHubLink(dir, 'hub.example.com').kind).toBe('unchanged')
  })

  it('drops one unreadable record and keeps the rest', () => {
    const dir = userData()
    addHubLink(dir, { hubUrl: 'wss://good.example.com', accessKey: 'a' })
    const file = getHubLinkStorePath(dir)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test wrote this file; the shape is the store's own.
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { links: unknown[] }
    stored.links.push({ hubUrl: 'not-a-url', accessKey: 'x' })
    writeFileSync(file, JSON.stringify(stored))
    const read = readHubLinks(dir)
    expect(read.links.map((link) => link.hubUrl)).toEqual(['wss://good.example.com'])
    expect(read.unreadableCount).toBe(1)
  })
})

describe('pruning rows for the surviving links', () => {
  const tempDirs: string[] = []
  const userData = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hub-prune-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  it('removes rows whose hub is no longer a link', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: 'wss://gone.example.com',
      accessKey: 'a',
      instances: [instance('inst-1', 'Gone')],
      now: 1000
    })
    expect(pruneHubEnvironmentsForLinks(dir, []).removed).toBe(1)
    expect(pruneHubEnvironmentsForLinks(dir, []).removed).toBe(0)
  })

  it('keeps rows for a hub that is still a link, in any spelling', () => {
    const dir = userData()
    syncHubEnvironments(dir, {
      hubUrl: 'wss://hub.example.com:6770',
      accessKey: 'a',
      instances: [instance('inst-1', 'Box')],
      now: 1000
    })
    expect(pruneHubEnvironmentsForLinks(dir, ['hub.example.com:6770']).removed).toBe(0)
  })
})
