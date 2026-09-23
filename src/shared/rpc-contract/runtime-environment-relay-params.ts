import { z } from 'zod'
import { RuntimeRpcEnvelopeSchema } from '../runtime-rpc-envelope'
import { requiredString } from './rpc-param-primitives'
import {
  REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY,
  REMOTE_RUNTIME_RELAY_ATTACH_RUNTIME_CAPABILITY
} from '../protocol-version'

// Why re-exported here: the method family below and the gating capabilities are
// one contract, and importing both from one module keeps them from drifting.
export { REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY, REMOTE_RUNTIME_RELAY_ATTACH_RUNTIME_CAPABILITY }

export const RUNTIME_ENVIRONMENT_RELAY_METHOD = 'runtimeEnvironment.call'
export const RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD = 'runtimeEnvironment.downstream.list'
// Why a second vehicle: binary terminal streams ride `terminal.multiplex` /
// `terminal.subscribe`, which are subscription methods — they cannot travel
// over the one-shot `runtimeEnvironment.call` envelope format.
export const RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD =
  'runtimeEnvironment.downstream.subscribe'

/**
 * Phase-1 forwardable reads: a read-only view of repos, projects, groups,
 * folder workspaces, worktrees, lineage, and folder path status (the reads the
 * relayed Projects tree needs to expand). The gateway answers everything else
 * with `forbidden` and forwards nothing upstream, so extending the relay
 * surface is an edit to these lists — never a new client call pattern.
 */
export const REMOTE_RUNTIME_RELAY_PHASE1_METHODS = [
  'status.get',
  'repo.list',
  'project.list',
  'projectHostSetup.list',
  'projectGroup.list',
  'worktree.detectedList',
  'worktree.list',
  'worktree.lineageList',
  'folderWorkspace.list',
  'folderWorkspace.getPathStatus'
] as const

export type RemoteRuntimeRelayPhase1Method = (typeof REMOTE_RUNTIME_RELAY_PHASE1_METHODS)[number]

/**
 * Phase-2 attached-operation methods: creating and activating terminals and
 * driving structured agent sessions on the upstream host, dialed via
 * `runtimeEnvironment.call`. Deliberately absent: `agentSession.list` — no such
 * method is registered anywhere — and other chat/session mutations that Phase 2
 * does not attach. `terminal.send` / `terminal.updateViewport` / `terminal.close`
 * are the pty-transport's write tick, resize pause fallback, and pane retirement —
 * without them an acknowledged write or guest-initiated close surfaces a refusal
 * instead of reaching the upstream PTY.
 */
export const REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS = [
  'session.tabs.createTerminal',
  'session.tabs.list',
  'session.tabs.listAll',
  'session.tabs.activate',
  'session.tabs.move',
  'terminal.send',
  'terminal.updateViewport',
  'terminal.close',
  'terminal.ensureAgentSession',
  'terminal.createAgentSession',
  'terminal.stop',
  'agentSession.subscribe',
  'agentSession.subscribeStatus',
  'agentSession.subscribeTurnCompletions',
  'notifications.subscribe',
  'files.watch'
] as const

export type RemoteRuntimeRelayAttachOperateMethod =
  (typeof REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS)[number]

/**
 * Phase-2 binary terminal streams the relay forwards. These exist only as
 * subscription methods (they open streaming sockets), so they ride
 * `runtimeEnvironment.downstream.subscribe` and never `runtimeEnvironment.call`.
 */
export const REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS = [
  'terminal.multiplex',
  'terminal.subscribe'
] as const

export type RemoteRuntimeRelayAttachStreamMethod =
  (typeof REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS)[number]

function relayMethodAllowed(method: string): (allowed: string) => boolean {
  return (allowed) => allowed === method
}

export function isRemoteRuntimeRelayPhase1Method(
  method: string
): method is RemoteRuntimeRelayPhase1Method {
  return REMOTE_RUNTIME_RELAY_PHASE1_METHODS.some(relayMethodAllowed(method))
}

export function isRemoteRuntimeRelayAttachOperateMethod(
  method: string
): method is RemoteRuntimeRelayAttachOperateMethod {
  return REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS.some(relayMethodAllowed(method))
}

export function isRemoteRuntimeRelayAttachStreamMethod(
  method: string
): method is RemoteRuntimeRelayAttachStreamMethod {
  return REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS.some(relayMethodAllowed(method))
}

/**
 * The one resolver both relay fences (gateway dispatch and the local guest
 * bridge) gate on. Phase-1 reads and the Phase-2 attached-operation set use the
 * same call vehicle; the binary terminal streams additionally ride the
 * subscribe vehicle and are accepted by the streaming fence only.
 */
export function isRelayForwardableRuntimeMethod(method: string): boolean {
  return isRemoteRuntimeRelayPhase1Method(method) || isRemoteRuntimeRelayAttachOperateMethod(method)
}

export function isRelayForwardableRuntimeStreamMethod(method: string): boolean {
  return isRelayForwardableRuntimeMethod(method) || isRemoteRuntimeRelayAttachStreamMethod(method)
}

// Stable anchor for refusal classifiers (renderer toast, tests): the tail of
// the message may change with the list, this prefix and the spacing after it
// may not without invalidating every matcher across app versions.
export const REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX = 'Runtime relay does not forward'

/** One wording for all three refusal fences (gateway dispatch, the local call
 *  bridge and the local subscribe bridge). */
export function runtimeEnvironmentRelayPhase1AllowlistMessage(method: string): string {
  return [
    `${REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX} ${method}.`,
    `Allowed (Phase 1): ${REMOTE_RUNTIME_RELAY_PHASE1_METHODS.join(', ')}.`,
    `Allowed (Phase 1 + attach operate, over ${RUNTIME_ENVIRONMENT_RELAY_METHOD}): ${REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS.join(
      ', '
    )}.`,
    `Allowed (Phase 1 + attach stream, over ${RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD}): ${REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS.join(
      ', '
    )}.`
  ].join(' ')
}

const RuntimeEnvironmentRelayMethodSchema = requiredString('Missing upstream method')

export const RuntimeEnvironmentGatewayCallParamsSchema = z.looseObject({
  gatewayEnvironmentId: requiredString('Missing gateway environment ID'),
  method: RuntimeEnvironmentRelayMethodSchema,
  params: z.unknown().optional()
})
export type RuntimeEnvironmentGatewayCallParams = z.infer<
  typeof RuntimeEnvironmentGatewayCallParamsSchema
>

/**
 * `response` carries the upstream host's RPC envelope VERBATIM — including its
 * failure envelopes, so a caller must read `response.ok` before treating the
 * outer relay result as success. `_meta.gatewayEnvironmentId` is the addressing
 * key the gateway resolved, letting a caller match a reply to the row it named.
 */
export const RuntimeEnvironmentGatewayCallResultSchema = z.looseObject({
  response: RuntimeRpcEnvelopeSchema,
  _meta: z.looseObject({ gatewayEnvironmentId: z.string().min(1) })
})
export type RuntimeEnvironmentGatewayCallResult = z.infer<
  typeof RuntimeEnvironmentGatewayCallResultSchema
>

export const RuntimeEnvironmentDownstreamListParamsSchema = z.looseObject({})

export const RuntimeEnvironmentGatewaySubscribeParamsSchema = z.looseObject({
  gatewayEnvironmentId: requiredString('Missing gateway environment ID'),
  method: RuntimeEnvironmentRelayMethodSchema,
  params: z.unknown().optional()
})
export type RuntimeEnvironmentGatewaySubscribeParams = z.infer<
  typeof RuntimeEnvironmentGatewaySubscribeParamsSchema
>

/**
 * One `emit` value per forwarded upstream event, streamed by
 * `runtimeEnvironment.downstream.subscribe`. `response` rides the upstream
 * envelope VERBATIM (success or failure, its `_meta` names the upstream host —
 * never this gateway); binary PTY frames travel as raw binary frames instead,
 * byte-identical, never wrapped in this payload. `end` is the stream-finished
 * marker; `error` carries transport failures so the subscriber can retry.
 */
export const RuntimeEnvironmentGatewaySubscribeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response'), response: RuntimeRpcEnvelopeSchema }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() })
])
export type RuntimeEnvironmentGatewaySubscribeEvent = z.infer<
  typeof RuntimeEnvironmentGatewaySubscribeEventSchema
>
