import { parseExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { sessionTabsListRead } from './mobile-session-read-operations'
import { forwardedRuntimeCall } from './mobile-remote-runtime-forwarded-call'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

// The relay vehicles a mirrored (runtime-backed) workspace's session screen reads
// through the gateway: the tab list rides the one-shot `runtimeEnvironment.call`,
// and the row's `runtime:<env>` execution-host stamp names the gateway environment
// directly — the stamp suffix is the env id in the gateway's own store, which is
// exactly the `gatewayEnvironmentId` the relay call addresses.

const RELAY_SESSION_TABS_LIST_METHOD = 'session.tabs.list'

/** The gateway's own store id for the row's paired environment, or null when local. */
export function remoteRuntimeRelayAddress(
  worktreeHostId: string | null | undefined
): string | null {
  const parsed = parseExecutionHostId(worktreeHostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

/** Where the session screen's tabs come from: the gateway relay, or null for local. */
export type RelayTabsSource = { mode: 'pending' } | { mode: 'relay'; gatewayEnvironmentId: string }

/**
 * The tab source for a row whose `worktree.show` stamp may not have resolved yet.
 * `pending` parks the tab controller entirely (a local subscribe would answer an
 * empty snapshot for a mirrored row and paint the false empty state); `null` is
 * the unchanged local path.
 */
export function resolveRelayTabsSource(
  worktreeHostId: string | null | undefined,
  stampKnown: boolean
): RelayTabsSource | null {
  if (!stampKnown) {
    return { mode: 'pending' }
  }
  const gatewayEnvironmentId = remoteRuntimeRelayAddress(worktreeHostId)
  return gatewayEnvironmentId ? { mode: 'relay', gatewayEnvironmentId } : null
}

/** Derived from the operation's own sender parameter so this file never names the raw port. */
type TabsListSender = Parameters<typeof sessionTabsListRead.request>[0]

/**
 * The tab list for a mirrored workspace, read through the gateway and unwrapped
 * into the same reply shape a local `session.tabs.list` answers, so the tab
 * controller consumes it unchanged. Any refusal — the call's own, the gateway's
 * transport, or the upstream host's — arrives as a failure so the screen degrades
 * instead of mistaking an unreachable host for an empty session.
 */
export function requestRemoteSessionTabsList(
  client: TabsListSender,
  gatewayEnvironmentId: string,
  scope: string
): Promise<RpcResponse> {
  return forwardedRuntimeCall(client, gatewayEnvironmentId, RELAY_SESSION_TABS_LIST_METHOD, {
    worktree: scope
  })
}

/** The tab list read the controller runs: the gateway relay, or the local method.
 *  Not async: the local path must hand back the sender's own promise, and the
 *  controller's cohort timing is pinned to that microtask count. */
export function fetchSessionTabsList(
  client: TabsListSender,
  relay: RelayTabsSource | null | undefined,
  scope: string
): Promise<RpcResponse> {
  if (relay?.mode === 'relay') {
    return requestRemoteSessionTabsList(client, relay.gatewayEnvironmentId, scope)
  }
  return sessionTabsListRead.request(client, { worktree: scope })
}
