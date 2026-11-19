import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  resolvePaneWorktreeRowKey,
  type WorkspaceSessionRowState
} from './pane-worktree-row-lookup'

type TerminalTabLookup = {
  getTab?: (tabId: string) => { contentType: string; entityId: string } | null
  hasTerminalTab?: (tabId: string) => boolean
}

/** Resolve a renderer tab id to the legacy terminal-tab id used by PTY state. */
export function resolveTerminalTabId(state: TerminalTabLookup, tabId: string): string {
  // The terminal-tab table is authoritative when both id forms are briefly present.
  // A stale unified entry must not redirect a live PTY owner to an older entity id.
  if (state.hasTerminalTab?.(tabId)) {
    return tabId
  }
  const unifiedTab = state.getTab?.(tabId)
  return unifiedTab?.contentType === 'terminal' ? unifiedTab.entityId : tabId
}

// Carry remount/recovery epochs on the same resolved row to avoid a second global tab scan.
type TerminalTabRecord = {
  id: string
  generation?: number
  recovery?: TerminalTab['recovery']
}
type TerminalTabState = {
  getTab?: (
    tabId: string
  ) => ({ contentType: string; entityId: string } & Partial<TerminalTabRecord>) | null
  tabsByWorktree: Record<string, readonly TerminalTabRecord[]>
  getTerminalTabOwnerWorktreeId?: (tabId: string) => string | null | undefined
}

/**
 * Resolve the live terminal tab (or unified tab) a pane renders for, by either id
 * form. Why the fallbacks: folder/worktree migrations can leave the pane's render
 * key stale for one commit, and a unified id's terminal tab lives under entityId.
 *
 * Contested ids (one repo path on several hosts, STA-4343) hold the trap: the overlay
 * renders the pane from the `host|id` row, but the two rows share the SAME tab id (the
 * mirrored `web-terminal-<hostTabId>` id is minted from the host's own tab id), so the
 * owner-index fallback (last-indexed bucket wins) and the flat scan can return the OTHER
 * host's row — wrong ptyId, wrong generation. The pane's bucket reads are scoped to the
 * resolved row key; for a contested id a miss is the answer, never the rival host's row.
 */
export function findTerminalTabForPane(
  state: TerminalTabState & WorkspaceSessionRowState,
  worktreeId: string,
  tabId: string
): TerminalTabRecord | null {
  const rowKey = resolvePaneWorktreeRowKey(state, worktreeId)
  // `rowKey !== worktreeId` is the contested gate: only then does the owner index / flat scan
  // risk the other host's bucket. An uncontested id keeps the exact fallbacks it had before.
  const contested = rowKey !== worktreeId
  const unifiedTab = state.getTab?.(tabId)
  const initialOwnerWorktreeId = contested
    ? null
    : (state.getTerminalTabOwnerWorktreeId?.(tabId) ??
      (unifiedTab?.contentType === 'terminal'
        ? state.getTerminalTabOwnerWorktreeId?.(unifiedTab.entityId)
        : null))
  const hasTabIn = (id: string | null | undefined, candidateId: string): boolean =>
    Boolean(id && state.tabsByWorktree[id]?.some((candidate) => candidate.id === candidateId))
  const terminalTabId = resolveTerminalTabId(
    {
      getTab: state.getTab,
      hasTerminalTab: (candidateId) =>
        hasTabIn(rowKey, candidateId) || hasTabIn(initialOwnerWorktreeId, candidateId)
    },
    tabId
  )
  const ownerWorktreeId = contested
    ? null
    : (state.getTerminalTabOwnerWorktreeId?.(terminalTabId) ?? initialOwnerWorktreeId)
  const byId = (id: string | null | undefined): TerminalTabRecord | undefined =>
    id ? state.tabsByWorktree[id]?.find((candidate) => candidate.id === terminalTabId) : undefined
  const unifiedTabRecord =
    unifiedTab && 'generation' in unifiedTab
      ? { id: unifiedTab.entityId, generation: unifiedTab.generation }
      : null
  if (contested) {
    // The overlay mounted this pane from the resolved row, so the tab id is present there; the
    // rival host's bucket is never this pane's row, so a miss is the answer, not the other row.
    return byId(rowKey) ?? unifiedTabRecord
  }
  return (
    byId(rowKey) ??
    byId(ownerWorktreeId) ??
    Object.values(state.tabsByWorktree)
      .flat()
      .find((candidate) => candidate.id === terminalTabId) ??
    unifiedTabRecord
  )
}
