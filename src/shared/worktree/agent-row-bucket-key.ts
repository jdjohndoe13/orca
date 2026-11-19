import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host/execution-host'
import { isWebTerminalSurfaceTabId } from '../workspace-layout/terminal-surface-id'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from './host-qualified-identity'
import { hasContestedClaim, type ContestedWorkspaceIds } from '../workspace-session-worktree-key'
import { canonicalizeWorktreeId } from './id'

/**
 * The row bucket one agent row belongs to — the same string the card reads
 * (`resolveWorkspaceSessionKey`). An uncontested id keeps the bare key.
 *
 * For a contested id the entry's own transport stamp names the host; a
 * qualified tab-index value for the SAME workspace is equally authoritative
 * (it is already the store's row key). An entry that cannot name its host
 * lands in the empty-prefix bucket no card reads — hiding a row beats
 * painting one host's content into another's.
 */
export function agentRowBucketKey(args: {
  worktreeId: string | undefined
  tabRowKey: string | undefined
  tabId: string
  entry: Pick<AgentStatusEntry, 'connectionId'> | undefined
  contested: ContestedWorkspaceIds | undefined
}): string | undefined {
  const { worktreeId, tabRowKey, tabId, entry, contested } = args
  if (worktreeId) {
    // Why the bucket is NOT canonicalized: the read key (`workspaceSessionKey`) is the row id
    // byte-for-byte — the host compares the key against the row it published — so the bucket
    // must be the same spelling or the card byte-misses its own row. The contested GATE does
    // fold the spelling, so the qualify decision is the same for either spelling.
    if (hasContestedClaim(contested, worktreeId)) {
      // A qualified tab-index value is the store's own row key for this exact
      // workspace; a qualified value for a DIFFERENT id is a mirrored collision
      // the host-reported worktreeId outranks. The identity check folds the
      // spelling, the returned key does not.
      if (
        tabRowKey &&
        isWorktreeHostIdentity(tabRowKey) &&
        canonicalizeWorktreeId(getWorktreeIdFromHostIdentity(tabRowKey)) ===
          canonicalizeWorktreeId(worktreeId)
      ) {
        return tabRowKey
      }
      return composeWorktreeHostIdentity(entryExecutionHost(entry, tabId) ?? undefined, worktreeId)
    }
    return tabRowKey ?? worktreeId
  }
  return tabRowKey
}

/**
 * The host an entry's transport stamp proves. `connectionId: null` is the
 * local hook pipeline's positive stamp; a raw string is the mirrored web
 * session's environment id or the hook's SSH target id (the tab id tells the
 * two spellings apart); an absent stamp names no host and buckets to the
 * empty-prefix row no card reads.
 */
export function entryExecutionHost(
  entry: Pick<AgentStatusEntry, 'connectionId'> | undefined,
  tabId: string
): ExecutionHostId | null {
  const connectionId = entry?.connectionId
  if (connectionId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  if (!connectionId) {
    return null
  }
  return isWebTerminalSurfaceTabId(tabId)
    ? toRuntimeExecutionHostId(connectionId)
    : toSshExecutionHostId(connectionId)
}
