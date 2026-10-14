import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import { forwardOrLocal } from '../session/mobile-remote-runtime-forwarded-call'
import type { RelayTabsSource } from '../session/mobile-remote-runtime-session-tabs'
import type { RpcClient } from '../transport/rpc-client'
import { terminalInputSend } from './mobile-terminal-operations'

type TerminalSubscriptionRegistry = {
  has: (handle: string) => boolean
}

type MobileTerminalQueryReplyOptions = {
  bytes: string
  client: RpcClient | null
  clientId: string | null
  connected: boolean
  handle: string
  hostSupportsQueryReplyInput: boolean
  subscribedTerminals: TerminalSubscriptionRegistry
  sessionRelay?: RelayTabsSource | null
}

export function sendMobileTerminalQueryReply({
  bytes,
  client,
  clientId,
  connected,
  handle,
  hostSupportsQueryReplyInput,
  subscribedTerminals,
  sessionRelay
}: MobileTerminalQueryReplyOptions): Promise<boolean> {
  // Why: every subscribed mobile xterm suppresses main's responder, including
  // hidden panes, so ownership follows the subscription rather than focus.
  // Hosts without terminal.query-reply-input.v1 strip inputKind and would take
  // reply bytes as floor-stealing shell input, so drop (pre-fix behavior).
  if (
    !client ||
    !connected ||
    !hostSupportsQueryReplyInput ||
    !subscribedTerminals.has(handle) ||
    !isTerminalQueryReply(bytes)
  ) {
    return Promise.resolve(false)
  }

  const params = {
    terminal: handle,
    text: bytes,
    enter: false,
    inputKind: 'query-reply' as const,
    ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {})
  }
  return forwardOrLocal(client, sessionRelay, 'terminal.send', params, () =>
    terminalInputSend.request(client, params)
  ).then(
    (reply) => terminalInputSend.interpret(reply) === true,
    () => false
  )
}
