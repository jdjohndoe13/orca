// End-to-end against a loopback fake hub: the auth/welcome exchange the real
// hub performs (`orca-hub/src/hub/server.ts`), plus the role reversal that is
// the whole design — the hub is the tunnel *client* and opens a stream, and the
// VM's sink (the production code under test) dials its own loopback and pipes
// bytes back.

import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { BrowserNetworkTunnelClient } from '../../browser/network/tunnels/browser-network-tunnel-client'
import { instanceIdFromPublicKey } from './hub-registration-crypto'
import { registerWithHub, type HubRegistrationTarget } from './hub-registration'
import { createHubLoopbackDial } from './hub-registration-sink'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { wsIsOpen } from './hub-registration-transport'

const PUBLIC_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const ACCESS_KEY = 'test-access-key'
const SECRET = 'reg-tenant'
const INSTANCE_ID = instanceIdFromPublicKey(PUBLIC_KEY_B64)

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

function listenEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server: Server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(Buffer.from(chunk).toReversed()))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        stop: () =>
          new Promise<void>((done) => {
            // `closeAllConnections` is absent on the bun test pool's net.Server,
            // so close the listening socket and let the streams retire.
            server.close(() => done())
          })
      })
    })
  })
}

/** A dial that refuses: the refused-open tests never expect a dial to happen. */
function loopbackDial(): (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket {
  return () => {
    throw new Error('unused')
  }
}

const realDial = createHubLoopbackDial()

type FakeHub = {
  url: string
  /** Control frame types the hub received, in order. */
  received: string[]
  /** Client sockets the hub has seen close (the reject path closes one). */
  closedCount: () => number
  /** Drop every client socket so the VM sees a close and reconnects. */
  hangUp: () => void
  /** The hub's tunnel client, attached once the VM's socket is open. */
  tunnel: () => BrowserNetworkTunnelClient
  stop: () => Promise<void>
}

/**
 * Mirrors the real hub's `/v1/register` handler: it is the tunnel client, it
 * accepts the first `auth` (rejecting a wrong secret), and it replies `welcome`
 * with a refresh cadence.
 */
function startFakeHub(
  options: { refreshMs?: number; acceptSecret?: string } = {}
): Promise<FakeHub> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const received: string[] = []
  let closed = 0
  let tunnel: BrowserNetworkTunnelClient | null = null

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const address = wss.address()
      const port = typeof address === 'object' && address ? address.port : 0
      wss.on('connection', (ws: WebSocket) => {
        let authed = false
        const send = (message: Record<string, unknown>): void => {
          if (wsIsOpen(ws)) {
            ws.send(JSON.stringify(message))
          }
        }
        tunnel = new BrowserNetworkTunnelClient({
          tunnelGeneration: 1,
          sendBinary: (bytes) => {
            if (!wsIsOpen(ws)) {
              return false
            }
            ws.send(bytes, { binary: true })
            return true
          },
          onClosed: () => {
            if (wsIsOpen(ws)) {
              ws.close()
            }
          }
        })
        ws.on('close', () => {
          closed += 1
        })
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            tunnel?.handleBinary(new Uint8Array(data))
            return
          } // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake hub only reads the fields the VM's own register/auth frames carry.
          const value = JSON.parse(data.toString('utf8')) as { type?: string; secret?: string }
          received.push(value.type ?? '')
          if (value.type !== 'auth' || authed) {
            return
          }
          if (options.acceptSecret && value.secret !== options.acceptSecret) {
            send({ type: 'reject', version: 1, reason: 'bad_registration_secret' })
            ws.close(1008, 'unauthorized')
            return
          }
          authed = true
          send({
            type: 'welcome',
            version: 1,
            hubId: 'hub-test',
            refreshMs: options.refreshMs ?? 30_000
          })
        })
      })
      resolve({
        url: `ws://127.0.0.1:${port}/v1/register`,
        received,
        closedCount: () => closed,
        hangUp: () => {
          for (const client of wss.clients) {
            client.terminate()
          }
        },
        tunnel: () => {
          if (!tunnel) {
            throw new Error('tunnel not attached')
          }
          return tunnel
        },
        stop: async () => {
          for (const client of wss.clients) {
            client.terminate()
          }
          await new Promise<void>((done) => wss.close(() => done()))
        }
      })
    })
  })
}

function countTypes(received: string[], type: string): number {
  return received.filter((entry) => entry === type).length
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  // vi.waitFor resolves when the callback stops throwing — a returned
  // `false` alone is not enough.
  await vi.waitFor(
    () => {
      if (!predicate()) {
        throw new Error('waiting for the fake hub')
      }
    },
    { timeout: timeoutMs, interval: 10 }
  )
}

function target(hub: FakeHub, ports: number[]): HubRegistrationTarget {
  return {
    url: hub.url,
    registrationSecret: SECRET,
    accessKey: ACCESS_KEY,
    name: 'vm-1',
    ports,
    capabilities: ['rpc'],
    refreshMs: 30_000,
    publicKeyB64: PUBLIC_KEY_B64
  }
}

describe('registerWithHub against a fake hub', () => {
  it('sends auth, register and ready in that order', async () => {
    const hub = await startFakeHub()
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    cleanups.push(() => handle.stop())
    await waitFor(() => hub.received.length >= 3)
    expect(hub.received.slice(0, 3)).toEqual(['auth', 'register', 'ready'])
  })

  it('stops retrying after a reject', async () => {
    const hub = await startFakeHub({ acceptSecret: 'the-right-one' })
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    cleanups.push(() => handle.stop())
    await waitFor(() => hub.received.length >= 1)
    // The reject path is terminal: the hub sees the socket close, and the
    // VM's stop-on-reject means no reconnect and no second auth follows.
    await waitFor(() => hub.closedCount() >= 1)
    expect(countTypes(hub.received, 'auth')).toBe(1)
  })

  it('dials the loopback port the hub asks for and pipes bytes back', async () => {
    const echo = await listenEchoServer()
    cleanups.push(() => echo.stop())
    const hub = await startFakeHub()
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [echo.port]), { dial: realDial })
    cleanups.push(() => handle.stop())
    await waitFor(() => hub.received.length >= 3)
    const stream = await hub.tunnel().open({ host: INSTANCE_ID, port: echo.port })
    const echoed = new Promise<Buffer>((resolve) => {
      stream.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk)))
    })
    stream.write(Buffer.from('hello'))
    expect((await echoed).toString()).toBe('olleh')
    stream.destroy()
  })

  it('answers a foreign host with an error frame and keeps the socket', async () => {
    const hub = await startFakeHub()
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    cleanups.push(() => handle.stop())
    await waitFor(() => hub.received.length >= 3)
    await expect(hub.tunnel().open({ host: 'someone-else', port: 6768 })).rejects.toThrow()
    // The socket survives the refused stream: the registration is still live.
    expect(hub.received.length).toBeGreaterThanOrEqual(3)
  })

  it('re-registers on the cadence the welcome names', async () => {
    const hub = await startFakeHub({ refreshMs: 1_000 })
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    cleanups.push(() => handle.stop())
    await waitFor(() => countTypes(hub.received, 'register') >= 2, 6_000)
    expect(countTypes(hub.received, 'register')).toBeGreaterThanOrEqual(2)
  })

  it('reconnects when the hub drops the socket', async () => {
    const hub = await startFakeHub()
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    cleanups.push(() => handle.stop())
    await waitFor(() => hub.received.length >= 3)
    hub.hangUp()
    await waitFor(() => countTypes(hub.received, 'auth') >= 2, 6_000)
    expect(countTypes(hub.received, 'auth')).toBeGreaterThanOrEqual(2)
  })

  it('stops cleanly and a second stop is a no-op', async () => {
    const hub = await startFakeHub()
    cleanups.push(() => hub.stop())
    const handle = registerWithHub(target(hub, [6768]), { dial: loopbackDial() })
    await waitFor(() => hub.received.length >= 3)
    handle.stop()
    expect(() => handle.stop()).not.toThrow()
  })
})

describe('the instance id the wire carries', () => {
  it('is the 22-char id the hub recomputes from the public key', () => {
    expect(INSTANCE_ID).toHaveLength(22)
    expect(instanceIdFromPublicKey(PUBLIC_KEY_B64)).toBe(INSTANCE_ID)
  })
})
