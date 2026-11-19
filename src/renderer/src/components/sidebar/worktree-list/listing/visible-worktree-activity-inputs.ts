import type { BrowserWorkspace } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { structuredTabPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { createWorktreeTabBucketProjection } from '@/lib/workspace/tabs/worktree-tab-bucket-projection'
import type { StructuredChatSleptAtByPaneKey } from '@/store/slices/agent-status/structured-sessions/structured-chat-slept-at'

export type TerminalActivityTab = Pick<TerminalTab, 'id'>
export type BrowserActivityTab = Pick<BrowserWorkspace, 'id'>

export function createVisibleWorktreeTerminalActivityProjection(
  onInspectBucket?: (worktreeId: string) => void
) {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalActivityTab>({
    projectTab: (tab) => ({ id: tab.id }),
    isSameProjectedTab: (previousTab, nextTab) => previousTab.id === nextTab.id,
    onInspectBucket
  })
}

const terminalProjection = createVisibleWorktreeTerminalActivityProjection()

export function getVisibleWorktreeTerminalActivityTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, TerminalActivityTab[]> {
  return terminalProjection.project(tabsByWorktree)
}

const browserProjection = createWorktreeTabBucketProjection<BrowserWorkspace, BrowserActivityTab>({
  projectTab: (tab) => ({ id: tab.id }),
  isSameProjectedTab: (previousTab, nextTab) => previousTab.id === nextTab.id
})

export function getVisibleWorktreeBrowserActivityTabs(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): Record<string, BrowserActivityTab[]> {
  return browserProjection.project(browserTabsByWorktree)
}

export const EMPTY_STRUCTURED_CHAT_WORKTREE_IDS: ReadonlySet<string> = new Set()
const EMPTY_SLEPT_CHATS: StructuredChatSleptAtByPaneKey = {}
// Keyed by the record itself, not the chat list: the set's VALUES are the bucket
// keys, and a contested rekey (STA-4343) keeps the chat list's identity while the
// bucket keys move — keying by the list would serve a stale set.
const structuredChatWorktreeIds = new WeakMap<
  Record<string, Tab[]>,
  WeakMap<StructuredChatSleptAtByPaneKey, ReadonlySet<string>>
>()

/** Only explicit Sleep marks rest a structured chat; idle child teardown or restart must not hide its workspace. */
export function getWorktreeIdsWithStructuredChat(
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined,
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey = EMPTY_SLEPT_CHATS
): ReadonlySet<string> {
  if (!unifiedTabsByWorktree) {
    return EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
  }
  const cached = structuredChatWorktreeIds
    .get(unifiedTabsByWorktree)
    ?.get(structuredChatSleptAtByPaneKey)
  if (cached) {
    return cached
  }
  // Why the bucket key and not `tab.worktreeId` (STA-4343): the paired-host mirror qualifies the
  // record keys while the tab's own field stays the host's bare id, so the field would name the
  // shared bucket and one host's chat would keep every claimant's card awake. The bucket is the
  // spelling the reader asks about; an uncontested id's bucket is the bare id, as before.
  const worktreeIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (
        isStructuredTab(tab) &&
        structuredChatSleptAtByPaneKey[structuredTabPaneKey(tab)] === null
      ) {
        worktreeIds.add(worktreeId)
        break
      }
    }
  }
  const bySleptAt = structuredChatWorktreeIds.get(unifiedTabsByWorktree) ?? new WeakMap()
  bySleptAt.set(structuredChatSleptAtByPaneKey, worktreeIds)
  structuredChatWorktreeIds.set(unifiedTabsByWorktree, bySleptAt)
  return worktreeIds
}

export function getStructuredChatWorktreeIds(
  showSleepingWorkspaces: boolean,
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined,
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey = EMPTY_SLEPT_CHATS
): ReadonlySet<string> {
  return showSleepingWorkspaces
    ? EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
    : getWorktreeIdsWithStructuredChat(unifiedTabsByWorktree, structuredChatSleptAtByPaneKey)
}
