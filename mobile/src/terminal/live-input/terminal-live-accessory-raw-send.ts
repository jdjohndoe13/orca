import { getTerminalLiveAccessoryRawSendTarget } from './terminal-live-accessory-raw-send-target'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../input-delivery/terminal-send-request'
import { terminalInputSend } from '../host-operations/mobile-terminal-operations'
import { forwardOrLocal } from '../../session/mobile-remote-runtime-forwarded-call'
import type { RelayTabsSource } from '../../session/mobile-remote-runtime-session-tabs'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { ConnectionState } from '../../transport/connection/connection-state'

type TerminalLiveAccessoryRawSendArgs = {
  readonly sendTerminalUserInput: typeof terminalInputSend.request
  readonly client: UnvalidatedRpcRequestPort | null
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
  // IME flush can outlive terminal selection; recheck the target afterward.
  const rawSendTarget = getTerminalLiveAccessoryRawSendTarget({
    targetHandle: args.targetHandle,
    activeHandle: args.activeHandle,
    activeSessionTabType: args.activeSessionTabType
  })
  // Why hoisted: the closure below cannot see the guard's narrowing of a property.
  const client = args.client
  if (!client || !rawSendTarget || args.connState !== 'connected') {
    return false
  }
  const sendParams = buildTerminalSendParams({
    terminal: rawSendTarget,
    text: args.bytes,
    enter: false,
    deviceToken: args.deviceToken
  })
  // Why: a mirrored row's raw send rides the gateway relay; the local path keeps
  // the ordered-input seam upstream introduced.
  return forwardOrLocal(client, args.sessionRelay, 'terminal.send', sendParams, () =>
    args.sendTerminalUserInput(client, sendParams, TERMINAL_INPUT_SEND_OPTIONS)
  ).then(
    (reply) => {
      return terminalInputSend.interpret(reply) === true
    },
    () => false
  )
}
