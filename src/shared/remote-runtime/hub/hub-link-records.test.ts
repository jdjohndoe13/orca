import { describe, expect, it } from 'vitest'
import { hubBridgeEndpoint, hubListUrl, normalizeHubUrl } from './hub-link-records'
import {
  createHubEnvironmentRow,
  hubEnvironmentId,
  parseHubInstanceList
} from './hub-instance-rows'

const KEY = Buffer.alloc(32, 7).toString('base64')

describe('hub url normalization', () => {
  it('accepts a bare host and defaults to wss', () => {
    expect(normalizeHubUrl('hub.example.com')).toEqual({
      ok: true,
      value: 'wss://hub.example.com'
    })
  })

  it('keeps a port and a ws scheme', () => {
    expect(normalizeHubUrl('ws://hub.example.com:6770')).toEqual({
      ok: true,
      value: 'ws://hub.example.com:6770'
    })
  })

  it('maps http(s) to ws(s) so one origin serves both', () => {
    expect(normalizeHubUrl('https://hub.example.com:6770')).toEqual({
      ok: true,
      value: 'wss://hub.example.com:6770'
    })
    expect(normalizeHubUrl('http://127.0.0.1:6770')).toEqual({
      ok: true,
      value: 'ws://127.0.0.1:6770'
    })
  })

  it('drops trailing slashes and a root path', () => {
    expect(normalizeHubUrl('wss://hub.example.com/')).toEqual({
      ok: true,
      value: 'wss://hub.example.com'
    })
  })

  it('rejects paths, queries, wildcards and other schemes', () => {
    expect(normalizeHubUrl('wss://hub.example.com/v1/list').ok).toBe(false)
    expect(normalizeHubUrl('wss://hub.example.com?a=1').ok).toBe(false)
    expect(normalizeHubUrl('0.0.0.0').ok).toBe(false)
    expect(normalizeHubUrl('ftp://hub.example.com').ok).toBe(false)
    expect(normalizeHubUrl('  ').ok).toBe(false)
    expect(normalizeHubUrl('hub.example.com has spaces').ok).toBe(false)
  })
})

describe('hub urls', () => {
  it('derives the list url over http(s) on the same origin', () => {
    expect(hubListUrl('wss://hub.example.com:6770')).toBe('https://hub.example.com:6770/v1/list')
    expect(hubListUrl('ws://127.0.0.1:6770')).toBe('http://127.0.0.1:6770/v1/list')
  })

  it('builds the bridge endpoint from the hub origin and the listed path', () => {
    expect(hubBridgeEndpoint('wss://hub.example.com:6770', '/v1/bridge/abc')).toBe(
      'wss://hub.example.com:6770/v1/bridge/abc'
    )
  })
})

describe('hub list parsing', () => {
  const row = {
    instanceId: 'inst-1',
    name: 'Build box',
    publicKeyB64: KEY,
    ports: [22],
    capabilities: ['shell'],
    source: 'vm',
    bridgePath: '/v1/bridge/inst-1'
  }

  it('accepts a well-formed list', () => {
    const parsed = parseHubInstanceList(200, {
      hubId: 'hub-1',
      protocolVersion: 1,
      instances: [row]
    })
    expect(parsed).toEqual({
      ok: true,
      value: { hubId: 'hub-1', instances: [row], unreadableCount: 0 }
    })
  })

  it('reports a non-2xx by status', () => {
    expect(parseHubInstanceList(401, { error: 'missing_access_key' })).toEqual({
      ok: false,
      reason: 'status',
      status: 401
    })
  })

  it('rejects an unreadable body rather than reporting an empty hub', () => {
    expect(parseHubInstanceList(200, { protocolVersion: 2, instances: [] })).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('drops one unreadable instance and keeps the rest', () => {
    const parsed = parseHubInstanceList(200, {
      protocolVersion: 1,
      instances: [row, { instanceId: 'x' }]
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.instances).toHaveLength(1)
      expect(parsed.value.unreadableCount).toBe(1)
    }
  })
})

describe('hub row synthesis', () => {
  const row = {
    instanceId: 'inst-1',
    name: 'Build box',
    publicKeyB64: KEY,
    ports: [],
    capabilities: [],
    bridgePath: '/v1/bridge/inst-1'
  }

  it('derives a stable id from the instance id', () => {
    expect(hubEnvironmentId('inst-1')).toBe('hub-inst-1')
  })

  it('dials the bridge, carries the access key as the device token, and pins the real key', () => {
    const environment = createHubEnvironmentRow('wss://hub.example.com:6770', row, 'access-key', {
      now: 1000
    })
    expect(environment.id).toBe('hub-inst-1')
    expect(environment.source).toBe('hub')
    expect(environment.endpoints).toEqual([
      {
        id: `ws-${environment.id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'wss://hub.example.com:6770/v1/bridge/inst-1',
        deviceToken: 'access-key',
        publicKeyB64: KEY
      }
    ])
    // The listed key is a real pin, so the endpoint is not an open-access (TOFU) dial.
    expect(environment.endpoints[0]?.openAccess).toBeUndefined()
    expect(environment.preferredEndpointId).toBe(`ws-${environment.id}`)
  })
})
