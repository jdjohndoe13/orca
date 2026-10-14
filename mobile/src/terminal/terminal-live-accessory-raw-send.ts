import { reportWorkerTerminalUserInput } from './worker-terminal-takeover-report'
import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'
import { terminalInputSend } from './mobile-terminal-operations'
import { forwardOrLocal } from '../session/mobile-remote-runtime-forwarded-call'
import type { RelayTabsSource } from '../session/mobile-remote-runtime-session-tabs'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

type TerminalLiveAccessoryRawSendArgs = {
  readonly client: RpcClient | null
  readonly targetHandle: string
  readonly activeHandle: string | null
  readonly activeSessionTabType: string | null
  readonly connState: ConnectionState
  readonly bytes: string
  readonly deviceToken: string | null
  readonly sessionRelay?: RelayTabsSource | null
}

export async function sendTerminalLiveAccessoryRawBytes(
  args: TerminalLiveAccessoryRawSendArgs
): Promise<boolean> {
  // Why: async IME flushing can outlive the original terminal selection.
  const rawSendTarget = getTerminalLiveAccessoryRawSendTarget({
    targetHandle: args.targetHandle,
    activeHandle: args.activeHandle,
    activeSessionTabType: args.activeSessionTabType
  })
  if (!args.client || !rawSendTarget || args.connState !== 'connected') {
    return false
  }
  const sendParams = buildTerminalSendParams({
    terminal: rawSendTarget,
    text: args.bytes,
    enter: false,
    deviceToken: args.deviceToken
  })
  const relay = args.sessionRelay
  return forwardOrLocal(args.client, relay, 'terminal.send', sendParams, () =>
    terminalInputSend.request(args.client!, sendParams, TERMINAL_INPUT_SEND_OPTIONS)
  ).then(
    (reply) => {
      const accepted = terminalInputSend.interpret(reply) === true
      if (accepted && relay?.mode !== 'relay') {
        reportWorkerTerminalUserInput(args.client!, rawSendTarget)
      }
      return accepted
    },
    () => false
  )
}
