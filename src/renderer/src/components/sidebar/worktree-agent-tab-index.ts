import type { AppState } from '@/store/types'

type TabWorktreeIndexSource = {
  tabsByWorktree: AppState['tabsByWorktree']
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

type TabWorktreeIndexCache = {
  tabsByWorktree: TabWorktreeIndexSource['tabsByWorktree']
  tabIdToWorktreeId: Map<string, string>
}

type LiveTabWorktreeIndexCache = TabWorktreeIndexCache & {
  unifiedTabsByWorktree: TabWorktreeIndexSource['unifiedTabsByWorktree']
}

let tabWorktreeIndexCache: TabWorktreeIndexCache | null = null
let liveTabWorktreeIndexCache: LiveTabWorktreeIndexCache | null = null

// Why exported: the Settings -> Repositories runtime summary needs the same
// tab -> worktree index, and rebuilding it there would re-walk every tab bucket
// on each store write.
export function getTabIdToWorktreeId(
  tabsByWorktree: TabWorktreeIndexSource['tabsByWorktree']
): Map<string, string> {
  if (tabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree) {
    return tabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexCache = { tabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}

export function getLiveTabIdToWorktreeId(
  tabsByWorktree: TabWorktreeIndexSource['tabsByWorktree'],
  unifiedTabsByWorktree: TabWorktreeIndexSource['unifiedTabsByWorktree']
): Map<string, string> {
  if (
    liveTabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree &&
    liveTabWorktreeIndexCache.unifiedTabsByWorktree === unifiedTabsByWorktree
  ) {
    return liveTabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map(getTabIdToWorktreeId(tabsByWorktree))
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        tabIdToWorktreeId.set(tab.id, worktreeId)
      }
    }
  }
  liveTabWorktreeIndexCache = { tabsByWorktree, unifiedTabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}
