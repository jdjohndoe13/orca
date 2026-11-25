import * as z from 'zod'
import { RuntimeRpcEnvelopeSchema } from '../remote-runtime/rpc/runtime-rpc-envelope'
import { requiredString } from './rpc-param-primitives'
import {
  REMOTE_RUNTIME_RELAY_RUNTIME_CAPABILITY,
  REMOTE_RUNTIME_RELAY_ATTACH_RUNTIME_CAPABILITY
} from '../remote-runtime/protocol/protocol-version'

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
// Why a fourth vehicle: the phone's socket is shared and cannot be closed to
// retire a bridge, so the bridge's owner releases it by the request id that
// opened it. An old gateway answers method_not_found, which the phone treats as
// success (the bridge then leaks until socket close — the status quo).
export const RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD =
  'runtimeEnvironment.downstream.unsubscribe'

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
 * Phase-2 attached-operation methods, dialed via `runtimeEnvironment.call`.
 * Milestone 2 widens the attached surface from terminals/agent-session streams
 * to the full operate surface a relayed workspace needs: git source control and
 * PR landing plus hosted review creation (GitHub + GitLab), worktree/repo
 * management, the files read side, folder workspace lifecycle, structured
 * agent-session lifecycle, terminal management (including the worktree-sleep
 * shutdown), workspace port scans, and pairing preflights. Deliberately absent:
 * `agentSession.list` — no such method is registered anywhere — and anything
 * else not enumerated here. `terminal.send` / `terminal.updateViewport` /
 * `terminal.close` are the pty-transport's write tick, resize pause fallback,
 * and pane retirement — without them an acknowledged write or guest-initiated
 * close surfaces a refusal instead of reaching the upstream PTY.
 * Host-targeted calls carry host ids; the gateway rewrites them
 * (runtime-environment-relay-param-rewrite).
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
  'files.watch',
  'git.status',
  'git.history',
  'git.diff',
  'git.commitDiff',
  'git.commitCompare',
  'git.branchCompare',
  'git.branchDiff',
  'git.stage',
  'git.unstage',
  'git.bulkStage',
  'git.bulkUnstage',
  'git.discard',
  'git.bulkDiscard',
  'git.commit',
  'git.checkout',
  'git.checkIgnored',
  'git.submoduleStatus',
  'git.upstreamStatus',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.fastForward',
  'git.rebaseFromBase',
  'git.abortMerge',
  'git.abortRebase',
  'git.conflictOperation',
  'git.localBranches',
  'git.remoteFileUrl',
  'git.remoteCommitUrl',
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.cancelGenerateCommitMessage',
  'git.cancelGeneratePullRequestFields',
  'git.discoverCommitMessageModels',
  'git.forkSync',
  'worktree.show',
  'worktree.ps',
  'worktree.activate',
  'worktree.create',
  'worktree.rm',
  'worktree.forceDeleteBranch',
  'worktree.resolvePrBase',
  'worktree.resolveMrBase',
  'worktree.set',
  'worktree.persistSortOrder',
  'worktree.prefetchCreateBase',
  'worktree.teardownMissingTerminals',
  'worktree.listRetiredNames',
  'repo.gitAvailable',
  'repo.show',
  'repo.searchRefs',
  'repo.baseRefDefault',
  'repo.setBaseRef',
  'repo.sparsePresets',
  'repo.saveSparsePreset',
  'repo.hooksCheck',
  'files.read',
  'files.readPreview',
  'files.readChunk',
  'files.readDir',
  'files.list',
  'files.listAll',
  'files.search',
  'files.searchPaths',
  'files.stat',
  'files.pathsExist',
  'files.readDocPreview',
  'files.resolveTerminalPath',
  'files.readTerminalArtifact',
  'files.readTerminalArtifactPreview',
  'folderWorkspace.create',
  'folderWorkspace.update',
  'folderWorkspace.delete',
  'agentSession.cancel',
  'agentSession.send',
  'agentSession.close',
  'agentSession.options',
  'agentSession.setOption',
  'agentSession.commands',
  'agentSession.conversationCommand',
  'agentSession.respondToApproval',
  'agentSession.respondToQuestion',
  'agentSession.hold',
  'agentSession.release',
  'agentSession.history',
  'agentSession.handoffStatus',
  'agentSession.restartContinue',
  'agentSession.restartResumable',
  'agentSession.restartResumableDismiss',
  'agentSession.restartResume',
  'agentSession.reveal',
  'agentSession.rewind',
  'agentSession.unsubscribe',
  'agentSession.ensure',
  'terminal.list',
  'terminal.create',
  'terminal.split',
  'terminal.focus',
  'terminal.wait',
  'terminal.isRunningAgent',
  'terminal.agentStatus',
  'terminal.inspectProcess',
  'terminal.resolvePane',
  'terminal.resolveIdentity',
  'terminal.restoreFit',
  'terminal.getAutoRestoreFit',
  'terminal.setAutoRestoreFit',
  'terminal.adoptOrphans',
  'terminal.stopExact',
  'terminal.sleep',
  'terminal.closeTab',
  'terminal.clearBuffer',
  'terminal.recoverPane',
  'session.tabs.close',
  'session.tabs.closeLifecycle',
  'session.tabs.setTabProps',
  'session.tabs.updatePaneLayout',
  'github.repoSlug',
  'github.workItem',
  'github.workItemDetails',
  'github.prForBranch',
  'github.prChecks',
  'github.prCheckDetails',
  'github.prComments',
  'github.prFileContents',
  'github.listLabels',
  'github.listAssignableUsers',
  'github.validateAccountBinding',
  'github.rateLimit',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.updatePRState',
  'github.updatePRTitle',
  'github.markPRReadyForReview',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.addIssueComment',
  'github.addPRReviewComment',
  'github.addPRReviewCommentReply',
  'github.resolveReviewThread',
  'github.setPRFileViewed',
  'github.repoUpstream',
  'gitlab.listMRs',
  'gitlab.workItemByPath',
  'gitlab.workItemDetails',
  'gitlab.mergeMR',
  'gitlab.updateMR',
  'gitlab.updateMRState',
  'gitlab.jobTrace',
  'gitlab.resolveMRDiscussion',
  'gitlab.rateLimit',
  'hostedReview.getCreationEligibility',
  'hostedReview.create',
  'hostedReview.createStacked',
  'hostedReview.forBranch',
  'workspacePorts.scan',
  'workspacePorts.kill',
  'preflight.check',
  'preflight.detectAgents',
  'skills.discover'
] as const

export type RemoteRuntimeRelayAttachOperateMethod =
  (typeof REMOTE_RUNTIME_RELAY_ATTACH_OPERATE_METHODS)[number]

/**
 * Phase-2 binary terminal streams the relay forwards. These exist only as
 * subscription methods (they open streaming sockets), so they ride
 * `runtimeEnvironment.downstream.subscribe` and never `runtimeEnvironment.call`.
 * `session.tabs.subscribe` keeps a mirrored workspace's tab metadata live the
 * way a local screen gets it; its params name a worktree selector only, which
 * is why the zero-rewrite stream assert holds for it.
 */
export const REMOTE_RUNTIME_RELAY_ATTACH_STREAM_METHODS = [
  'terminal.multiplex',
  'terminal.subscribe',
  'session.tabs.subscribe'
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

/** Every relay refusal throws this shape (message from the one wording builder,
 *  code `forbidden` for the renderer's classifier), always before a transport
 *  dial. */
export function relayForbiddenError(method: string): Error {
  return Object.assign(new Error(runtimeEnvironmentRelayPhase1AllowlistMessage(method)), {
    code: 'forbidden'
  })
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

export const RuntimeEnvironmentGatewaySubscribeParamsSchema = z.looseObject({
  gatewayEnvironmentId: requiredString('Missing gateway environment ID'),
  method: RuntimeEnvironmentRelayMethodSchema,
  params: z.unknown().optional()
})
export type RuntimeEnvironmentGatewaySubscribeParams = z.infer<
  typeof RuntimeEnvironmentGatewaySubscribeParamsSchema
>

export const RuntimeEnvironmentGatewayUnsubscribeParamsSchema = z.looseObject({
  requestId: requiredString('Missing bridge request ID')
})
export type RuntimeEnvironmentGatewayUnsubscribeParams = z.infer<
  typeof RuntimeEnvironmentGatewayUnsubscribeParamsSchema
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
