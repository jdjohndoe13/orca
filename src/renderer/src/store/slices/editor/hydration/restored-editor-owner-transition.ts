import type { ActiveWorktreeStateTransition } from '../../worktrees/session/worktree-selection-contract'
import type { TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { sanitizeRecentTabIds } from '../../tabs/tab-selection-history'
import {
  nextActiveIdAfterRemoval,
  removeEmptyEditorGroups,
  removeTabIdsFromGroup,
  rekeyFileIdRecord
} from '../file-ids/open-file-path-rekey'
import { rekeyEditorBuffers } from '../buffers/editor-buffer-record'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from '../types/restored-editor-owner'
import { resolveRestoredEditorOwnerDestination } from './restored-editor-owner-destination'
import { rekeyRestoredEditorTabsInPlace } from './restored-editor-owner-in-place'
import {
  replaceRecordEntries,
  replaceTabBuckets
} from '../../../record-transitions/keyed-record-transitions'
import { resolveWorkspaceSessionRowKey } from '../../../workspace-session-key'

/** The group a moved restored tab joins: the workspace's active one, else its first, else a new one. The rows live under the session key, `host|id` for a contested id (STA-4343). */
export function restoredEditorTargetGroupId(
  s: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'> &
    Parameters<typeof resolveWorkspaceSessionRowKey>[0],
  worktreeId: string
): string {
  const rowKey = resolveWorkspaceSessionRowKey(s, worktreeId)
  return (
    s.activeGroupIdByWorktree[rowKey] ?? s.groupsByWorktree[rowKey]?.[0]?.id ?? createBrowserUuid()
  )
}

export function buildRestoredEditorOwnerTransition(
  args: RestoredEditorOwnerMigration,
  assignResult: (result: RestoredEditorOwnerResult) => void,
  /** The group main was asked to append to (layout-owner build). */
  proposedTargetGroupId?: string
): ActiveWorktreeStateTransition {
  return (s) => {
    const destination = resolveRestoredEditorOwnerDestination(s, args)
    if (!destination.ok) {
      assignResult({ ok: false, reason: destination.reason })
      return destination.reason === 'stale'
        ? { patch: {}, activate: false }
        : { patch: destination.patch, activate: false }
    }
    const { source, newFileId, previewIdMigrations, operationProvenance } = destination
    const parsedHost = parseExecutionHostId(args.targetExecutionHostId)
    const externalSshTargetId =
      parsedHost?.kind === 'ssh' && args.targetRuntimeEnvironmentId === null
        ? parsedHost.targetId
        : undefined
    const migrations = new Map([[source.id, newFileId], ...previewIdMigrations])
    const movedFileIds = new Set(migrations.keys())
    const sourceWorktreeId = source.worktreeId
    const targetWorktreeId = args.targetWorktreeId
    // The records live under the session key, `host|id` for a contested workspace id
    // (STA-4343); the open-file entities and the tab `worktreeId` fields keep the bare id.
    const sourceRowKey = resolveWorkspaceSessionRowKey(s, sourceWorktreeId)
    const targetRowKey = resolveWorkspaceSessionRowKey(s, targetWorktreeId)
    const movedTabs = (s.unifiedTabsByWorktree[sourceRowKey] ?? []).filter((tab) =>
      movedFileIds.has(tab.entityId)
    )
    const movedTabIds = new Set(movedTabs.map((tab) => tab.id))
    const tabIdMigration = new Map(
      movedTabs.map((tab) => [tab.id, migrations.get(tab.id) ?? tab.id])
    )
    const mappedMovedTabIds = movedTabs.map((tab) => tabIdMigration.get(tab.id) ?? tab.id)
    const mappedMovedTabIdSet = new Set(mappedMovedTabIds)
    const mappedMovedTabBarIds = movedTabs.map(
      (tab) => migrations.get(tab.entityId) ?? tab.entityId
    )
    const targetGroups = s.groupsByWorktree[targetRowKey] ?? []
    const targetGroupId = proposedTargetGroupId ?? restoredEditorTargetGroupId(s, targetWorktreeId)
    const targetGroup = targetGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId: targetWorktreeId,
      activeTabId: null,
      tabOrder: []
    }

    const previousSourceGroups = s.groupsByWorktree[sourceRowKey] ?? []
    const updatedSourceGroups = previousSourceGroups.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !movedTabIds.has(id))
      const activeTabId =
        group.activeTabId && movedTabIds.has(group.activeTabId)
          ? nextActiveIdAfterRemoval(group.tabOrder, group.recentTabIds, movedTabIds)
          : group.activeTabId
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: sanitizeRecentTabIds(
          (group.recentTabIds ?? []).filter((id) => !movedTabIds.has(id)),
          tabOrder
        )
      }
    })
    const sourceGroupState = removeEmptyEditorGroups(
      previousSourceGroups,
      updatedSourceGroups,
      movedTabIds,
      s.layoutByWorktree[sourceRowKey]
    )
    const destinationOrder = [
      ...targetGroup.tabOrder.filter((id) => !mappedMovedTabIds.includes(id)),
      ...mappedMovedTabIds
    ]
    const updatedTargetGroup: TabGroup = {
      ...targetGroup,
      activeTabId: mappedMovedTabIds.at(-1) ?? targetGroup.activeTabId,
      tabOrder: destinationOrder,
      recentTabIds: sanitizeRecentTabIds(
        [...(targetGroup.recentTabIds ?? []), ...mappedMovedTabIds],
        destinationOrder
      )
    }
    // Why: the migrated ids land in targetGroup only, so any sibling group holding the same id is left dangling.
    const nextTargetGroups = targetGroups.some((group) => group.id === targetGroupId)
      ? targetGroups.map((group) =>
          group.id === targetGroupId
            ? updatedTargetGroup
            : removeTabIdsFromGroup(group, mappedMovedTabIdSet)
        )
      : [
          ...targetGroups.map((group) => removeTabIdsFromGroup(group, mappedMovedTabIdSet)),
          updatedTargetGroup
        ]

    const nextSourceTabs = (s.unifiedTabsByWorktree[sourceRowKey] ?? []).filter(
      (tab) => !movedTabIds.has(tab.id)
    )
    const nextTargetTabs = [
      // Why: a leftover target tab carrying a migrated id would duplicate the id that destinationOrder keeps only once.
      ...(s.unifiedTabsByWorktree[targetRowKey] ?? []).filter(
        (tab) => !mappedMovedTabIdSet.has(tab.id)
      ),
      ...movedTabs.map((tab) => ({
        ...tab,
        id: tabIdMigration.get(tab.id) ?? tab.id,
        entityId: migrations.get(tab.entityId) ?? tab.entityId,
        groupId: targetGroupId,
        worktreeId: targetWorktreeId,
        ...(tab.executionHostId ? { executionHostId: args.targetExecutionHostId } : {})
      }))
    ]

    const sourceLayout = sourceGroupState.layout ?? null
    // Built only for the cross-workspace branch, where the source write can't touch the target key.
    const targetLayoutEntry: [string, AppState['layoutByWorktree'][string]][] =
      targetGroups.length === 0 || !s.layoutByWorktree[targetRowKey]
        ? [[targetRowKey, { type: 'leaf', groupId: targetGroupId }]]
        : []

    const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
    const sourceActiveFileId = nextActiveFileIdByWorktree[sourceRowKey]
    if (sourceActiveFileId && movedFileIds.has(sourceActiveFileId)) {
      nextActiveFileIdByWorktree[sourceRowKey] =
        s.openFiles.find(
          (file) => !movedFileIds.has(file.id) && file.worktreeId === sourceWorktreeId
        )?.id ?? null
    }
    nextActiveFileIdByWorktree[targetRowKey] = newFileId
    const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
    nextTabBarOrderByWorktree[sourceRowKey] = (
      nextTabBarOrderByWorktree[sourceRowKey] ?? []
    ).filter((id) => !movedFileIds.has(id) && !movedTabIds.has(id))
    nextTabBarOrderByWorktree[targetRowKey] = [
      ...(nextTabBarOrderByWorktree[targetRowKey] ?? []).filter(
        (id) => !mappedMovedTabBarIds.includes(id)
      ),
      ...mappedMovedTabBarIds
    ]
    const previousActiveGroupId = s.activeGroupIdByWorktree[sourceRowKey]
    const sourceActiveGroupId =
      sourceGroupState.groups.length === 0
        ? null
        : (sourceGroupState.groups.find((group) => group.id === previousActiveGroupId)?.id ??
          sourceGroupState.groups[0].id)
    const tabState =
      sourceWorktreeId === targetWorktreeId
        ? rekeyRestoredEditorTabsInPlace(
            s,
            targetWorktreeId,
            migrations,
            tabIdMigration,
            args.targetExecutionHostId,
            targetRowKey
          )
        : {
            activeFileIdByWorktree: nextActiveFileIdByWorktree,
            activeGroupIdByWorktree: replaceRecordEntries(s.activeGroupIdByWorktree, [
              [sourceRowKey, sourceActiveGroupId],
              [targetRowKey, targetGroupId]
            ]),
            activeTabTypeByWorktree: {
              ...s.activeTabTypeByWorktree,
              [targetRowKey]: 'editor' as const
            },
            groupsByWorktree: replaceRecordEntries(s.groupsByWorktree, [
              [sourceRowKey, sourceGroupState.groups],
              [targetRowKey, nextTargetGroups]
            ]),
            layoutByWorktree: replaceRecordEntries(s.layoutByWorktree, [
              [sourceRowKey, sourceLayout],
              ...targetLayoutEntry
            ]),
            tabBarOrderByWorktree: nextTabBarOrderByWorktree,
            unifiedTabsByWorktree: replaceTabBuckets(s.unifiedTabsByWorktree, [
              [sourceRowKey, nextSourceTabs],
              [targetRowKey, nextTargetTabs]
            ])
          }

    assignResult({ ok: true, fileId: newFileId })
    return {
      patch: {
        openFiles: s.openFiles.map((file) =>
          file.id === source.id
            ? {
                ...file,
                id: newFileId,
                worktreeId: targetWorktreeId,
                relativePath: args.targetRelativePath,
                runtimeEnvironmentId: args.targetRuntimeEnvironmentId,
                externalSshTargetId,
                operationProvenance,
                pendingOwnerMigration: undefined,
                mirroredFromRuntimeSession: undefined
              }
            : file.markdownPreviewSourceFileId === source.id
              ? {
                  ...file,
                  id: previewIdMigrations.get(file.id) ?? file.id,
                  worktreeId: targetWorktreeId,
                  relativePath: args.targetRelativePath,
                  runtimeEnvironmentId: args.targetRuntimeEnvironmentId,
                  externalSshTargetId,
                  operationProvenance,
                  markdownPreviewSourceFileId: newFileId,
                  pendingOwnerMigration: undefined,
                  mirroredFromRuntimeSession: undefined
                }
              : file
        ),
        ...rekeyEditorBuffers(s, s.openFiles, migrations, 'carry', () => ({
          pendingOwnerMigration: undefined
        })),
        editorDrafts: rekeyFileIdRecord(s.editorDrafts, migrations),
        editorCursorLine: rekeyFileIdRecord(s.editorCursorLine, migrations),
        markdownViewMode: rekeyFileIdRecord(s.markdownViewMode, migrations),
        markdownRichModeSizeOverride: rekeyFileIdRecord(s.markdownRichModeSizeOverride, migrations),
        editorViewMode: rekeyFileIdRecord(s.editorViewMode, migrations),
        markdownFrontmatterVisible: rekeyFileIdRecord(s.markdownFrontmatterVisible, migrations),
        markdownTableOfContentsVisible: rekeyFileIdRecord(
          s.markdownTableOfContentsVisible,
          migrations
        ),
        activeFileId: s.activeFileId ? (migrations.get(s.activeFileId) ?? s.activeFileId) : null,
        ...tabState,
        ...(s.pendingEditorReveal?.fileId && migrations.has(s.pendingEditorReveal.fileId)
          ? {
              pendingEditorReveal: {
                ...s.pendingEditorReveal,
                fileId: migrations.get(s.pendingEditorReveal.fileId)!,
                filePath: source.filePath
              }
            }
          : {}),
        ...(s.pendingEditorFocusRequest?.fileId &&
        migrations.has(s.pendingEditorFocusRequest.fileId)
          ? {
              pendingEditorFocusRequest: {
                ...s.pendingEditorFocusRequest,
                fileId: migrations.get(s.pendingEditorFocusRequest.fileId)!,
                worktreeId: targetWorktreeId
              }
            }
          : {}),
        ...(s.pendingExplorerReveal?.filePath === source.filePath &&
        s.pendingExplorerReveal.worktreeId === sourceWorktreeId
          ? {
              pendingExplorerReveal: {
                ...s.pendingExplorerReveal,
                worktreeId: targetWorktreeId
              }
            }
          : {})
      },
      activate: true,
      preferredActiveUnifiedTabId: mappedMovedTabIds.at(-1)
    }
  }
}
