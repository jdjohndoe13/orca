import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../workspace/ownership/worktree-runtime-owner'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { useAppStore } from '@/store/index'
import { readWorkspaceSessionRecord } from '@/store/workspace-session-key'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionOwnerForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

/**
 * The structured-chat row lives under the workspace's SESSION ROW KEY (`host|id` for a contested
 * id, STA-4343), never the bare id. The caller's explicit target wins; otherwise the store's own
 * evidence (the active workspace's stamp, the catalog) resolves it — and a contested id whose
 * host cannot be named is a deliberate miss, not a fallback to the bare key.
 */
export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: { workspaceId: string; sessionId: string; target?: RuntimeClientTarget }
): Tab | null {
  const state = useAppStore.getState()
  const row = readWorkspaceSessionRecord(
    state,
    unifiedTabsByWorktree,
    args.workspaceId,
    args.target ? executionHostIdForStructuredTarget(args.target) : null
  )
  return (
    (row?.entry ?? []).find(
      (candidate) =>
        candidate.worktreeId === args.workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId &&
        (!args.target ||
          structuredAgentSessionOwnerForTab(state, candidate) ===
            executionHostIdForStructuredTarget(args.target))
    ) ?? null
  )
}

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
  target?: RuntimeClientTarget
}): boolean {
  const state = useAppStore.getState()
  const row = readWorkspaceSessionRecord(
    state,
    state.unifiedTabsByWorktree,
    args.worktreeId,
    args.target ? executionHostIdForStructuredTarget(args.target) : null
  )
  const tab = (row?.entry ?? []).find(
    (candidate) =>
      candidate.id === args.tabId &&
      candidate.contentType === 'agent-session' &&
      (!args.target ||
        structuredAgentSessionOwnerForTab(state, candidate) ===
          executionHostIdForStructuredTarget(args.target))
  )
  if (!tab) {
    return false
  }
  // The store actions below resolve the row key themselves from the same state; the runtime
  // selector stays the BARE id because the host indexes its own session tabs by it.
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType('agent-session', args.worktreeId)
  requestNativeChatComposerFocus(tab.id)
  activateStructuredAgentSessionTabOnOwner(args.worktreeId, tab.entityId, args.target)
  return true
}

/** The chat's host keeps this client's tab selection; every local activation must reach it. */
export function activateStructuredAgentSessionTabOnOwner(
  worktreeId: string,
  sessionId: string,
  target?: RuntimeClientTarget,
  options?: { callerOnly?: boolean }
): void {
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
  void callRuntimeRpc(
    target ?? runtimeTargetForOwnerEnvironment(environmentId),
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      tabId: `agent-session:${sessionId}`,
      // Why both: navigation scopes new hosts to this client; notifyClients:false protects old hosts.
      ...(options?.callerOnly ? { notifyClients: false, navigation: 'caller' as const } : {})
    }
  )
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
}): boolean {
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: args.worktreeId,
    sessionId: args.sessionId,
    target: args.target
  })
  return tab
    ? activateStructuredAgentSessionTab({
        worktreeId: args.worktreeId,
        tabId: tab.id,
        target: args.target
      })
    : false
}
