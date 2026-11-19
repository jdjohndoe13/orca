// Streams whose host names its registration only in the `ready` frame. The transport that saw that
// frame is the only holder of a current id, so it alone sends the release.
export const READY_STREAM_RELEASE_METHODS: ReadonlyMap<string, string> = new Map([
  ['browser.screencast', 'browser.screencast.unsubscribe'],
  ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe'],
  ['notifications.subscribe', 'notifications.unsubscribe'],
  ['accounts.subscribe', 'accounts.unsubscribe']
])

export function isReadyIdStream(method: string | undefined): boolean {
  return method !== undefined && READY_STREAM_RELEASE_METHODS.has(method)
}

export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  const release = READY_STREAM_RELEASE_METHODS.get(method)
  return release ? { method: release, params: { subscriptionId } } : null
}

export type ServerSubscriptionStream = {
  method: string
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
}

export function sendServerSubscriptionUnsubscribe(
  stream: ServerSubscriptionStream,
  sendRpc: (method: string, params: unknown) => void
): void {
  if (!stream.subscriptionId) {
    return
  }
  const unsubscribe = buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId)
  if (unsubscribe) {
    sendRpc(unsubscribe.method, unsubscribe.params)
  }
}

/** Cancel a ready-id stream: release now if the host named its id, else let the
 *  ready reply (or the unsent drop) handle it. */
export function disposeServerSubscription(
  stream: ServerSubscriptionStream,
  sendRpc: (method: string, params: unknown) => void,
  remove: () => void
): void {
  stream.cancelled = true
  if (stream.subscriptionId) {
    sendServerSubscriptionUnsubscribe(stream, sendRpc)
    remove()
  } else if (!stream.sent) {
    remove()
  }
}
