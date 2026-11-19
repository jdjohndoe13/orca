import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { ownsGlobalSelection } from '../../../workspaces/selection/global-selection-owner'
import { resolveWorkspaceSessionRowKey } from '../../../workspace-session-key'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX } from '../buffers/editor-buffer-views'

export function createOpenFileState(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'openFiles'
  | 'editorBuffers'
  | 'editorBufferIdOf'
  | 'editorBufferViews'
  | 'editorBufferDetached'
  | 'editorBufferKept'
  | 'editorBufferIdentityRevision'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'activeTabType'
  | 'recentlyClosedEditorTabsByWorktree'
  | 'setActiveTabType'
> {
  return {
    openFiles: [],
    editorBuffers: {},
    ...EMPTY_EDITOR_BUFFER_VIEW_INDEX,
    editorBufferDetached: {},
    editorBufferKept: {},
    editorBufferIdentityRevision: 0,
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabType: 'terminal',
    recentlyClosedEditorTabsByWorktree: {},
    // Require explicit worktree so background/floating actions cannot retype main-window selection.
    setActiveTabType: (type, worktreeId) =>
      set((s) => {
        // The slot lives under the session key, `host|id` for a contested workspace id (STA-4343).
        const rowKey = worktreeId ? resolveWorkspaceSessionRowKey(s, worktreeId) : null
        const setsGlobal = ownsGlobalSelection(s, worktreeId) && s.activeTabType !== type
        const setsWorktree = Boolean(
          rowKey &&
          !(Object.hasOwn(s.activeTabTypeByWorktree, rowKey) && s.activeTabTypeByWorktree[rowKey] === type)
        )
        // Unchanged selection publishes nothing; every publication wakes every store subscriber.
        if (!setsGlobal && !setsWorktree) {
          return s
        }
        return {
          ...(setsGlobal ? { activeTabType: type } : {}),
          ...(setsWorktree && rowKey
            ? { activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [rowKey]: type } }
            : {})
        }
      })
  }
}
