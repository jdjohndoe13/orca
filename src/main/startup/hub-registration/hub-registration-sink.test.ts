import { describe, expect, it } from 'vitest'
import {
  HubSinkRefusalError,
  createHubSinkConnect,
  type HubLoopbackDial
} from './hub-registration-sink'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'

const INSTANCE_ID = 'Yw3NKWbEM2aRElRIu7JbT_'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sink tests only read `destroyed`; the rest of the socket shape is never touched.
const socket = { destroyed: false } as BrowserNetworkTunnelSocket

function recordingDial(): { dial: HubLoopbackDial; calls: BrowserNetworkTunnelOpen[] } {
  const calls: BrowserNetworkTunnelOpen[] = []
  return {
    calls,
    dial: (target) => {
      calls.push(target)
      return socket
    }
  }
}

function refusalOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof HubSinkRefusalError ? error.refusal : `unexpected:${String(error)}`
  }
}

describe('createHubSinkConnect', () => {
  it('dials a registered port for this instance on loopback', () => {
    const { dial, calls } = recordingDial()
    const connect = createHubSinkConnect(INSTANCE_ID, [6768], dial)
    expect(connect({ host: INSTANCE_ID, port: 6768 })).toBe(socket)
    // The host label is only an identifier; the dial is always this host's loopback.
    expect(calls).toEqual([{ host: '127.0.0.1', port: 6768 }])
  })

  it('refuses a foreign host', () => {
    const { dial, calls } = recordingDial()
    const connect = createHubSinkConnect(INSTANCE_ID, [6768], dial)
    expect(refusalOf(() => connect({ host: 'other-instance', port: 6768 }))).toBe('wrong_host')
    expect(calls).toEqual([])
  })

  it('refuses a port that was never registered', () => {
    const { dial, calls } = recordingDial()
    const connect = createHubSinkConnect(INSTANCE_ID, [6768], dial)
    expect(refusalOf(() => connect({ host: INSTANCE_ID, port: 8080 }))).toBe('port_not_registered')
    expect(calls).toEqual([])
  })

  it('accepts every registered port and still only dials loopback', () => {
    const { dial, calls } = recordingDial()
    const connect = createHubSinkConnect(INSTANCE_ID, [6768, 6769, 6770], dial)
    for (const port of [6768, 6769, 6770]) {
      connect({ host: INSTANCE_ID, port })
    }
    expect(calls).toEqual([
      { host: '127.0.0.1', port: 6768 },
      { host: '127.0.0.1', port: 6769 },
      { host: '127.0.0.1', port: 6770 }
    ])
  })
})
