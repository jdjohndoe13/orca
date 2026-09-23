import { z } from 'zod'
import { RuntimeRpcEnvelopeSchema } from '../runtime-rpc-envelope'
import { requiredString } from './rpc-param-primitives'
import { REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY } from '../protocol-version'

// Why re-exported here: the method family below and the gating capability are
// one contract, and importing both from one module keeps them from drifting.
export { REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY }

export const RUNTIME_ENVIRONMENT_RELAY_METHOD = 'runtimeEnvironment.call'
export const RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD = 'runtimeEnvironment.downstream.list'

/**
 * Phase-1 forwardable reads: a read-only view of repos, projects, groups,
 * folder workspaces, worktrees, lineage, and folder path status (the reads the
 * relayed Projects tree needs to expand). The gateway answers everything else
 * with `forbidden` and forwards nothing upstream, so extending the relay
 * surface is an edit to this list — never a new client call pattern. Still no
 * subscriptions, no streaming, no mutations.
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

export function isRemoteRuntimeRelayPhase1Method(
  method: string
): method is RemoteRuntimeRelayPhase1Method {
  return REMOTE_RUNTIME_RELAY_PHASE1_METHODS.some((allowed) => allowed === method)
}

// Stable anchor for refusal classifiers (renderer toast, tests): the tail of
// the message may change with the list, this prefix and the spacing after it
// may not without invalidating every matcher across app versions.
export const REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX = 'Runtime relay does not forward'

/** One wording for both refusal fences (gateway dispatch and the local bridge). */
export function runtimeEnvironmentRelayPhase1AllowlistMessage(method: string): string {
  return `${REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX} ${method}. Allowed (Phase 1): ${REMOTE_RUNTIME_RELAY_PHASE1_METHODS.join(
    ', '
  )}.`
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
