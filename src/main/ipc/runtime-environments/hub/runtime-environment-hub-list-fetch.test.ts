import { describe, expect, it } from 'vitest'
import { fetchHubInstanceList, type HubFetch } from './runtime-environment-hub-list-fetch'

const KEY = Buffer.alloc(32, 3).toString('base64')

function response(status: number, body: unknown): Response {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch code under test only uses ok/status/text() from the Response.
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function fetchReturning(status: number, body: unknown): { fetch: HubFetch; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push([url, init.headers['x-orca-access-key'] ?? ''])
      return response(status, body)
    }
  }
}

describe('hub list fetch', () => {
  it('asks the hub over https for the instance list with the access key', async () => {
    const hub = fetchReturning(200, {
      hubId: 'hub-1',
      protocolVersion: 1,
      instances: [
        {
          instanceId: 'inst-1',
          name: 'Box',
          publicKeyB64: KEY,
          ports: [],
          capabilities: [],
          bridgePath: '/v1/bridge/inst-1'
        }
      ]
    })
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://hub.example.com:6770', accessKey: 'secret' },
      hub.fetch
    )
    expect(hub.calls).toEqual([['https://hub.example.com:6770/v1/list', 'secret']])
    expect(result).toEqual({
      ok: true,
      instances: [
        {
          instanceId: 'inst-1',
          name: 'Box',
          publicKeyB64: KEY,
          ports: [],
          capabilities: [],
          bridgePath: '/v1/bridge/inst-1'
        }
      ],
      hubId: 'hub-1',
      unreadableCount: 0
    })
  })

  it('types a rejected access key as unauthorized', async () => {
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://hub.example.com', accessKey: 'nope' },
      fetchReturning(401, { error: 'missing_access_key' }).fetch
    )
    expect(result).toEqual({ ok: false, failure: 'unauthorized' })
  })

  it('reports a hub that cannot be reached', async () => {
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://down.example.com', accessKey: 'a' },
      async () => {
        throw new Error('ECONNREFUSED')
      }
    )
    expect(result).toEqual({ ok: false, failure: 'unreachable' })
  })

  it('reports an unreadable body without pretending the hub is empty', async () => {
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://hub.example.com', accessKey: 'a' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch code under test only uses ok/status/text() from the Response.
      async () => ({ ok: true, status: 200, text: async () => 'not json' }) as unknown as Response
    )
    expect(result).toEqual({ ok: false, failure: 'malformed' })
  })

  it('refuses an oversized body', async () => {
    const huge = { protocolVersion: 1, instances: [{ pad: 'x'.repeat(1024 * 1024) }] }
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://hub.example.com', accessKey: 'a' },
      async () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch code under test only uses ok/status/text() from the Response.
        ({ ok: true, status: 200, text: async () => JSON.stringify(huge) }) as unknown as Response
    )
    expect(result).toEqual({ ok: false, failure: 'too-large' })
  })

  it('treats a hub that does not speak the protocol as unsupported', async () => {
    const result = await fetchHubInstanceList(
      { hubUrl: 'wss://hub.example.com', accessKey: 'a' },
      fetchReturning(404, { error: 'not_found' }).fetch
    )
    expect(result).toEqual({ ok: false, failure: 'unsupported' })
  })
})
