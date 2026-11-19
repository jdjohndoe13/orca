import type { TabGroupLayoutNode } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TabsSlice, TabsSliceSet } from './tabs-slice-contract'
import { updateSplitRatio } from '../../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import { replaceRecordEntries } from '../../record-transitions/keyed-record-transitions'
import { resolveWorkspaceSessionRowKey } from '../../workspace-session-key'

export function createTabsSplitRatioActions(
  set: TabsSliceSet
): Pick<TabsSlice, 'setTabGroupSplitRatio'> {
  return {
    setTabGroupSplitRatio: (worktreeId, nodePath, ratio) => {
      set((state) => {
        // The row key is `host|id` for a contested workspace id (STA-4343); the bare key misses
        // the row, so the ratio would be written to a bucket the split never reads.
        const rowKey = resolveWorkspaceSessionRowKey(state, worktreeId)
        const currentLayout = state.layoutByWorktree[rowKey]
        if (!currentLayout) {
          return state
        }
        // No-op ratios must preserve root identity to avoid waking every subscriber (STA-3328).
        let targetNode: TabGroupLayoutNode | undefined = currentLayout
        for (const segment of nodePath.length > 0 ? nodePath.split('.') : []) {
          targetNode =
            targetNode &&
            targetNode.type === 'split' &&
            (segment === 'first' || segment === 'second')
              ? targetNode[segment]
              : undefined
        }
        if (!targetNode || targetNode.type !== 'split' || (targetNode.ratio ?? 0.5) === ratio) {
          return state
        }
        return {
          // Why: split ratios belong to the tab-group model (not transient UI), so persist them for restores and multi-step group ops.
          layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [
            [
              rowKey,
              updateSplitRatio(currentLayout, nodePath.length > 0 ? nodePath.split('.') : [], ratio)
            ]
          ])
        }
      })
    }
  }
}
