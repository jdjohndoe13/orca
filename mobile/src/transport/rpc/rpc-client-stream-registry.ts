import {
  BrowserScreencastSlots,
  decodeBrowserScreencast,
  routeBrowserScreencastFrame
} from '../browser-screencast-slots'
import type { BrowserScreencastFrame } from '../../browser/screencast/browser-screencast-protocol'
import type {
  RpcStreamingListener,
  RpcStreamSubscribeOptions,
  StreamRegistryOptions,
  StreamRequest
} from './rpc-client-stream-request'
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
import { createGatewayBridgeStreams } from '../gateway-bridge-streams'
import {
  isStreamEndResult,
  isStreamingSubscriptionReadyResult,
  isTerminalSubscribedResult
} from './rpc-subscription-result-shapes'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import * as sessionTabsStream from './rpc-client-session-tabs-stream'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'
import type { RpcResponse, RpcSuccess } from './rpc-wire-types'
import { translate } from '../../i18n/mobile-i18n'

export class RpcClientStreamRegistry {
  private readonly streams = new Map<string, StreamRequest>()
  private readonly terminalRouter = new RpcClientTerminalStreamRouter()
  private readonly bridge = createGatewayBridgeStreams()
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
      envelope: subscribeOptions?.envelope,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame,
      holdReplay: subscribeOptions?.holdReplay
    }
    this.streams.set(id, stream)
    for (const evicted of this.bridge.claim(method, params, id)) {
      this.evictTerminalVehicle(evicted)
    }
    if (method === 'browser.screencast') {
      this.replaceBrowserStream(id)
    }
    if (this.options.getState() === 'connected') {
      if (this.send(id, stream)) {
        stream.sent = true
      } else {
        this.finish(id, stream, {
          type: 'error',
          message: translate(
            'connection.rpcClientStreamRegistry.interrupted',
            'Connection interrupted'
          )
        })
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
      this.terminalRouter.reset(id)
      if (!stream.holdReplay?.(() => this.resendHeld(id, stream)) && !this.replay(id, stream)) {
        break
      }
    }
  }

  private resendHeld(id: string, stream: StreamRequest): void {
    if (
      this.streams.get(id) === stream &&
      !stream.sent &&
      !stream.cancelled &&
      this.options.getState() === 'connected'
    ) {
      this.replay(id, stream)
    }
  }

  // A failed write means the socket is gone; every stream then waits for the next connection.
  private replay(id: string, stream: StreamRequest): boolean {
    stream.sent = this.send(id, stream)
    if (!stream.sent) {
      this.markForReplay()
    }
    return stream.sent
  }

  markForReplay(): void {
    this.browserSlots.reset()
    for (const [id, stream] of this.streams) {
      stream.sent = false
      stream.receivedSnapshot = false
      // The id named a registration on the closed socket; the replay's ready brings the new one.
      stream.subscriptionId = undefined
      this.terminalRouter.reset(id)
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
        ? translate(
            'connection.rpcClientStreamRegistry.endedBeforeReady',
            'Streaming request ended before it was ready.'
          )
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
    const unwrapped = this.bridge.unwrap(stream.method, response.result)
    if (unwrapped.kind === 'keepalive') {
      return
    }
    if (unwrapped.kind === 'error') {
      this.finish(response.id, stream, { type: 'error', message: unwrapped.message })
      return
    }
    const result = unwrapped.result
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
        sendServerSubscriptionUnsubscribe(stream, (method, params) =>
          this.sendRpc(method, params, stream.envelope)
        )
        this.remove(response.id)
        return
      }
      if (stream.method === 'browser.screencast') {
        if (!this.browserSlots.acceptReady(response.id)) {
          this.sendRpc(
            'browser.screencast.unsubscribe',
            { subscriptionId: result.subscriptionId },
            stream.envelope
          )
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
        (method, params) => this.sendRpc(method, params, stream.envelope),
        () => this.remove(id)
      )
      return
    }
    if (stream && sessionTabsStream.holdUnsubscribe(stream)) {
      return
    }
    const bridgeRelease = this.bridge.release(stream?.method, id)
    if (bridgeRelease) {
      // The shared socket cannot close its way out of a bridge; the gateway releases
      // it by the request id that opened it, then the stream drops it like a lost reply.
      this.sendRpc(bridgeRelease.method, bridgeRelease.params, stream?.envelope)
      this.remove(id)
      return
    }
    // An unsent stream has nothing on the desktop, and one held for its owner's verdict must stay silent.
    const unsubscribe = stream?.sent
      ? buildRequestStreamUnsubscribe(stream.method, stream.params, id)
      : null
    if (unsubscribe) {
      this.sendRpc(unsubscribe.method, unsubscribe.params, stream?.envelope)
    }
    this.remove(id)
  }

  private replaceBrowserStream(id: string): void {
    for (const stale of this.browserSlots.claim(id)) {
      this.dispose(stale)
    }
  }

  // The stream's envelope rides its unsubscribes too: a routing field must reach the same host.
  private sendRpc(method: string, params: unknown, envelope?: RpcEnvelopeFields): boolean {
    return this.options.sendFrame({ id: this.options.nextId(), method, params, envelope })
  }

  private send(id: string, stream: StreamRequest): boolean {
    const { method, params, envelope } = stream
    return this.options.sendFrame({ id, method, params, envelope })
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    this.streams.delete(id)
    this.browserSlots.release(id)
    this.terminalRouter.reset(id)
    this.bridge.forget(id)
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
