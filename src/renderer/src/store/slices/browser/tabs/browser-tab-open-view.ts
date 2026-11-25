import type { CreateBrowserTabOptions } from '../browser-slice-contract'
import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../../shared/browser/browser-blank-page'
import type { AppState } from '../../../types'
import { ownsGlobalSelection } from '../../../workspaces/selection/global-selection-owner'
import { workspaceEditorFiles } from '../../editor/tabs/workspace-editor-files'

// The window's own view of a browser tab it opens: its tab-bar order entry, browser selection and
// the address-bar focus a blank New Tab asks for; a layout-owner build writes it once drawn.
export function browserTabOpenView(
  s: AppState,
  worktreeId: string,
  browserTab: BrowserWorkspace,
  page: BrowserPage,
  options: CreateBrowserTabOptions | undefined,
  // Where this workspace's rows live: `host|id` for a contested id (STA-4343). The record reads
  // and writes below use it; `ownsGlobalSelection` and the floating check keep the bare id.
  rowKey: string = worktreeId
): Partial<AppState> {
  const workspaceId = browserTab.id
  // Without this tab: a frame may already have drawn its record.
  const existingTabs = (s.browserTabsByWorktree[rowKey] ?? []).filter(
    (tab) => tab.id !== workspaceId
  )
  const nextTabBarOrder = (() => {
    const currentOrder = s.tabBarOrderByWorktree[rowKey] ?? []
    const terminalIds = (s.tabsByWorktree[rowKey] ?? []).map((tab) => tab.id)
    const editorIds = workspaceEditorFiles(s.openFiles, s.unifiedTabsByWorktree[rowKey]).map(
      (file) => file.id
    )
    const ids = [...terminalIds, ...editorIds, ...existingTabs.map((tab) => tab.id)]
    const allExistingIds = new Set(ids)
    const base = currentOrder.filter((entryId) => allExistingIds.has(entryId))
    const inBase = new Set(base)
    return [...base, ...[...allExistingIds].filter((entryId) => !inBase.has(entryId)), workspaceId]
  })()

  const shouldActivate = options?.activate ?? true
  const shouldUpdateGlobalActiveSurface = shouldActivate && ownsGlobalSelection(s, worktreeId)
  const shouldFocusFloatingTab = shouldActivate && worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const shouldFocusAddressBar =
    (shouldUpdateGlobalActiveSurface || shouldFocusFloatingTab) &&
    // Why the doc check and not just the url: a document page is blank by construction, and
    // the blank url is exactly what marks a New Tab as wanting the address bar it does not have.
    !page.docLocation &&
    (options?.focusAddressBar ??
      (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL))

  return {
    tabBarOrderByWorktree: {
      ...s.tabBarOrderByWorktree,
      [rowKey]: nextTabBarOrder
    },
    activeBrowserTabId: shouldUpdateGlobalActiveSurface ? workspaceId : s.activeBrowserTabId,
    activeBrowserTabIdByWorktree: {
      ...s.activeBrowserTabIdByWorktree,
      [rowKey]: shouldActivate ? workspaceId : (s.activeBrowserTabIdByWorktree[rowKey] ?? null)
    },
    activeTabType: shouldUpdateGlobalActiveSurface ? 'browser' : s.activeTabType,
    activeTabTypeByWorktree: shouldActivate
      ? { ...s.activeTabTypeByWorktree, [rowKey]: 'browser' }
      : s.activeTabTypeByWorktree,
    pendingAddressBarFocusByPageId: shouldFocusAddressBar
      ? {
          ...s.pendingAddressBarFocusByPageId,
          [page.id]: true
        }
      : s.pendingAddressBarFocusByPageId,
    pendingAddressBarFocusByTabId: shouldFocusAddressBar
      ? {
          ...s.pendingAddressBarFocusByTabId,
          [workspaceId]: true,
          [page.id]: true
        }
      : s.pendingAddressBarFocusByTabId
  }
}
