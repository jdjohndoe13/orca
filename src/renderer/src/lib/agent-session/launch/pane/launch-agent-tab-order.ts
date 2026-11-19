import { useAppStore } from '@/store/index'
import { reconcileTabOrder } from '@/lib/workspace/tabs/order/reconcile-tab-order'
import { workspaceEditorFiles } from '@/store/slices/editor/tabs/workspace-editor-files'
import { resolveWorkspaceSessionRowKey } from '@/store/workspace-session-key'

export function persistAgentLaunchTabOrder(worktreeId: string, tabId: string): void {
  const store = useAppStore.getState()
  // Why the row key: a contested id's tab rows live under `host|id`, so the order must be
  // reconciled against the tabs of the host this tab was created on. `setTabBarOrder` resolves
  // the same key itself, so the write below stays on the bare id.
  const rowKey = resolveWorkspaceSessionRowKey(store, worktreeId)
  const terminalIds = (store.tabsByWorktree[rowKey] ?? []).map((tab) => tab.id)
  const editorIds = workspaceEditorFiles(
    store.openFiles,
    store.unifiedTabsByWorktree[rowKey]
  ).map((file) => file.id)
  const browserIds = (store.browserTabsByWorktree?.[rowKey] ?? []).map((tab) => tab.id)
  const order = reconcileTabOrder(
    store.tabBarOrderByWorktree[rowKey],
    terminalIds,
    editorIds,
    browserIds
  ).filter((id) => id !== tabId)
  order.push(tabId)
  store.setTabBarOrder(worktreeId, order)
}
