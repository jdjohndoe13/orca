import { useEffect } from 'react'
import type { WorkspaceVisibleTabType } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveRepairedActiveTerminalTabId } from './active-terminal-repair'

type ActiveTerminalRepairInput = {
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
  activeTabIdByWorktree: Record<string, string | null>
  // The row key, not the bare id: the remembered active tab is a session row, and a contested
  // id's row lives under `host|id` — reading the bare key would repair the other host's tab.
  activeWorktreeSessionRowKey: string | null
  setActiveTab: (tabId: string) => void
  tabs: TerminalTab[]
}

export function repairActiveTerminalTab({
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeWorktreeSessionRowKey,
  setActiveTab,
  tabs
}: ActiveTerminalRepairInput): boolean {
  const rememberedTabId =
    activeWorktreeSessionRowKey !== null &&
    Object.hasOwn(activeTabIdByWorktree, activeWorktreeSessionRowKey)
      ? (activeTabIdByWorktree[activeWorktreeSessionRowKey] ?? null)
      : null
  const repairedTabId = resolveRepairedActiveTerminalTabId({
    activeTabType,
    activeTabId,
    rememberedTabId,
    tabs
  })
  if (!repairedTabId) {
    return false
  }
  setActiveTab(repairedTabId)
  return true
}

export function useActiveTerminalRepair(input: ActiveTerminalRepairInput): void {
  const {
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeWorktreeSessionRowKey,
    setActiveTab,
    tabs
  } = input
  useEffect(() => {
    repairActiveTerminalTab({
      activeTabId,
      activeTabIdByWorktree,
      activeTabType,
      activeWorktreeSessionRowKey,
      setActiveTab,
      tabs
    })
    // Why: `tabs` is the dependency so repair reacts to order/content changes, not just scalar ids.
  }, [
    activeTabId,
    activeTabType,
    setActiveTab,
    tabs,
    activeTabIdByWorktree,
    activeWorktreeSessionRowKey
  ])
}
