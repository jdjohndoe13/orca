import {
  BrowserScreencastSlots,
  decodeBrowserScreencast,
  routeBrowserScreencastFrame
} from './browser-screencast-slots'
import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import {
  buildRequestStreamUnsubscribe,
  updateGatewayBridgeTerminalViewport,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import {
  disposeServerSubscription,
  isReadyIdStream,
  sendServerSubscriptionUnsubscribe
} from './rpc-client-server-subscription'
import { isStreamingOpenerReply } from './rpc-acceptance-policies'
import {
  buildGatewayBridgeUnsubscribe,
  isGatewayBridgeStream,
  terminalVehicleKind,
  TerminalVehicleArbiter,
  unwrapGatewayBridgeEvent
} from './gateway-subscribe-envelope'
import {
  isStreamEndResult,
  isStreamingSubscriptionReadyResult,
  isTerminalSubscribedResult
} from './rpc-subscription-result-shapes'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import * as sessionTabsStream from './rpc-client-session-tabs-stream'
import type { ConnectionState, RpcResponse, RpcSuccess } from './types'

export type RpcStreamingListener = (result: unknown) => void

export type RpcStreamSubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

type StreamRequest = {
  method: string
  params: unknown
  listener?: RpcStreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
  receivedSnapshot?: boolean
}

type StreamRegistryOptions = {
  nextId: () => string
  deviceToken: string
  getState: () => ConnectionState
  sendEncrypted: (request: unknown) => boolean
}

export class RpcClientStreamRegistry {
  private readonly streams = new Map<string, StreamRequest>()
  private readonly terminalRouter = new RpcClientTerminalStreamRouter()
  private readonly terminalVehicles = new TerminalVehicleArbiter()
  private readonly browserSlots = new BrowserScreencastSlots()

  constructor(private readonly options: StreamRegistryOptions) {}

  subscribe(
    method: string,
    params: unknown,
    listener: RpcStreamingListener,
    subscribeOptions?: RpcStreamSubscribeOptions
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRequest = {
      method,
      params,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame
    }
    this.streams.set(id, stream)
    const vehicle = terminalVehicleKind(method, params)
    if (vehicle) {
      for (const evicted of this.terminalVehicles.claim(vehicle, id)) {
        this.evictTerminalVehicle(evicted)
      }
    }
    if (method === 'browser.screencast') {
      this.replaceBrowserStream(id)
    }
    if (this.options.getState() === 'connected') {
      if (this.send(id, stream)) {
        stream.sent = true
      } else {
        this.finish(id, stream, { type: 'error', message: 'Connection interrupted' })
      }
    } else {
      console.log('[net] subscribe queued — waiting for connected', {
        method,
        state: this.options.getState()
      })
    }
    return () => this.dispose(id)
  }

  replayAfterAuthentication(): void {
    for (const [id, stream] of this.streams) {
      if (stream.cancelled) {
        this.remove(id)
        continue
      }
      if (stream.sent) {
        continue
      }
      if (stream.method === 'browser.screencast') {
        this.browserSlots.queueForReplay(id)
      }
      this.resetTerminalRouting(id)
      if (this.send(id, stream)) {
        stream.sent = true
      } else {
        this.markForReplay()
        break
      }
    }
  }

  markForReplay(): void {
    this.browserSlots.reset()
    for (const [id, stream] of this.streams) {
      stream.sent = false
      stream.receivedSnapshot = false
      // The id named a registration on the closed socket; the replay's ready brings the new one.
      stream.subscriptionId = undefined
      this.resetTerminalRouting(id)
    }
  }

  handleResponse(response: RpcResponse): boolean {
    if (isStreamingOpenerReply(response)) {
      this.handleStreamingResponse(response)
      return true
    }
    const stream = this.streams.get(response.id)
    if (response.ok) {
      const result = (response as RpcSuccess).result as Record<string, unknown> | null
      if (stream && isStreamEndResult(result)) {
        this.finish(response.id, stream, result)
        return true
      }
      if (stream && result?.type === 'scrollback') {
        stream.listener?.(result)
        return true
      }
    }
    if (!stream) {
      return false
    }
    this.finish(response.id, stream, {
      type: 'error',
      message: response.ok
        ? 'Streaming request ended before it was ready.'
        : response.error.message,
      error: response.ok ? undefined : response.error
    })
    return true
  }

  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencast(bytes)
    if (browserFrame) {
      this.handleBrowserFrame(browserFrame)
      return
    }
    this.terminalRouter.handle(bytes)
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    updateTerminalSubscriptionViewport(this.streams.values(), terminal, viewport)
    updateGatewayBridgeTerminalViewport(this.streams.values(), terminal, viewport)
  }

  size(): number {
    return this.streams.size
  }

  private handleStreamingResponse(response: RpcSuccess): void {
    const stream = this.streams.get(response.id)
    if (!stream) {
      return
    }
    let result = response.result
    if (isGatewayBridgeStream(stream.method)) {
      const unwrapped = unwrapGatewayBridgeEvent(result)
      if (unwrapped.kind === 'keepalive') {
        return
      }
      if (unwrapped.kind === 'error') {
        this.finish(response.id, stream, { type: 'error', message: unwrapped.message })
        return
      }
      result = unwrapped.result
    }
    if (isStreamEndResult(result)) {
      this.finish(response.id, stream, result)
      return
    }
    if (sessionTabsStream.recordSnapshot(stream, result) && stream.cancelled) {
      this.dispose(response.id)
      return
    }
    if (isStreamingSubscriptionReadyResult(result)) {
      stream.subscriptionId = result.subscriptionId
      if (stream.cancelled) {
        sendServerSubscriptionUnsubscribe(stream, (method, params) => this.sendRpc(method, params))
        this.remove(response.id)
        return
      }
      if (stream.method === 'browser.screencast') {
        if (!this.browserSlots.acceptReady(response.id)) {
          this.sendRpc('browser.screencast.unsubscribe', { subscriptionId: result.subscriptionId })
          this.remove(response.id)
          return
        }
      }
    }
    if (isTerminalSubscribedResult(result) && stream.listener) {
      this.terminalRouter.register(response.id, result.streamId, stream.listener)
    }
    if (!stream.cancelled) {
      stream.listener?.(result)
    }
  }

  private dispose(id: string): void {
    const stream = this.streams.get(id)
    if (stream) {
      // A canceled opener may never reply; only its host cleanup route must survive.
      stream.listener = undefined
      stream.onBinaryFrame = undefined
    }
    if (stream && isReadyIdStream(stream.method)) {
      if (stream.method === 'browser.screencast') {
        this.browserSlots.release(id)
      }
      disposeServerSubscription(
        stream,
        (method, params) => this.sendRpc(method, params),
        () => this.remove(id)
      )
      return
    }
    if (stream && sessionTabsStream.holdUnsubscribe(stream)) {
      return
    }
    if (isGatewayBridgeStream(stream?.method)) {
      // The shared socket cannot close its way out of a bridge; the gateway
      // releases it by the request id that opened it. An old gateway answers
      // method_not_found, which the stream drops like any lost reply.
      const release = buildGatewayBridgeUnsubscribe(stream?.method, id)
      if (release) {
        this.sendRpc(release.method, release.params)
      }
      this.remove(id)
      return
    }
    const unsubscribe = buildRequestStreamUnsubscribe(stream?.method, stream?.params, id)
    if (unsubscribe) {
      this.sendRpc(unsubscribe.method, unsubscribe.params)
    }
    this.remove(id)
  }

  private replaceBrowserStream(id: string): void {
    for (const stale of this.browserSlots.claim(id)) {
      this.dispose(stale)
    }
  }

  private sendRpc(method: string, params: unknown): boolean {
    return this.sendFrame(this.options.nextId(), method, params)
  }

  private send(id: string, stream: StreamRequest): boolean {
    return this.sendFrame(id, stream.method, stream.params)
  }

  private sendFrame(id: string, method: string, params: unknown): boolean {
    return this.options.sendEncrypted({
      id,
      deviceToken: this.options.deviceToken,
      method,
      params
    })
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    this.streams.delete(id)
    this.browserSlots.release(id)
    this.resetTerminalRouting(id)
    this.terminalVehicles.forget(id)
    if (stream?.method === 'browser.screencast') {
      stream.cancelled = true
    }
  }

  /** The arbiter replaced this stream's binary vehicle: end it like a host-ended
   *  stream so the session layer's `end` path (unsubscribe + inventory recovery)
   *  runs and the screen can re-subscribe when it regains focus. */
  private evictTerminalVehicle(id: string): void {
    const stream = this.streams.get(id)
    if (stream && !stream.cancelled) {
      this.finish(id, stream, { type: 'end' })
    }
  }

  private resetTerminalRouting(id: string): void {
    this.terminalRouter.reset(id)
  }

  private handleBrowserFrame(frame: BrowserScreencastFrame): void {
    if (!this.browserSlots.active) {
      return
    }
    routeBrowserScreencastFrame(this.streams.get(this.browserSlots.active), frame)
  }

  /** Removed first, so neither the listener's dispose nor a replay can name a host-ended stream. */
  private finish(id: string, stream: StreamRequest, result: unknown): void {
    const listener = stream.cancelled ? undefined : stream.listener
    this.remove(id)
    listener?.(result)
  }
}
