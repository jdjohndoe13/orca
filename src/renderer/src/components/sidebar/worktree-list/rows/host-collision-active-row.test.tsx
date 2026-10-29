// @vitest-environment happy-dom

import type React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeItemRow, FolderWorkspaceItemRow } from '../listing/renderable-rows'
import type { RenderRow } from '../listing/render-row'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from '../drag/row-state'
import { renderWorktreeItemRow, type WorktreeItemRowContext } from './item-row'
import { renderFolderWorkspaceVirtualRow, type FolderWorkspaceRowContext } from './folder-row'
import { renderWorktreeVirtualRow, type WorktreeVirtualRowContext } from './virtual-row-dispatch'

// Why: the card is the consumer of the active flags; stubbing it keeps the assertion on
// which row the dispatcher marks active instead of the card's own styling. Mirrors the
// real card's `isActiveSurface = isActive` default and its inline lineage children.
vi.mock('../../WorktreeCard', () => ({
  default: ({
    worktree,
    isActive,
    isActiveSurface = isActive,
    isCurrentWorktree,
    lineageChildren
  }: {
    worktree: Worktree
    isActive?: boolean
    isActiveSurface?: boolean
    isCurrentWorktree?: boolean
    lineageChildren?: React.ReactNode
  }) => (
    <div
      data-worktree-card-host-identity={`${worktree.hostId ?? ''}|${worktree.id}`}
      data-card-active={isActive ? 'true' : 'false'}
      data-card-surface={isActiveSurface ? 'true' : 'false'}
      data-card-current={isCurrentWorktree ? 'true' : 'false'}
    >
      {lineageChildren}
    </div>
  )
}))

vi.mock('../../HostSectionHeaderMenu', () => ({
  HostSectionHeaderMenu: () => null
}))

const SHARED_ID = 'repo-1::/repo'
const SHARED_FOLDER_ID = 'folder:shared-folder'

function itemRow(hostId: ExecutionHostId | undefined): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: `all:${hostId ?? ''}|${SHARED_ID}`,
    sectionKey: 'all',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: row rendering reads only the id/host/display fields this fixture supplies; a full Worktree needs catalog state this suite does not build.
    worktree: {
      id: SHARED_ID,
      repoId: 'repo-1',
      hostId,
      displayName: 'shared',
      lineageChildCount: 0
    } as unknown as Worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function itemContext(
  overrides: Partial<
    Pick<
      WorktreeItemRowContext,
      'activeWorktreeId' | 'activeWorkspaceExecutionHostId' | 'currentWorktreeId'
    >
  >
): WorktreeItemRowContext {
  return {
    settings: null,
    groupBy: 'none',
    folderBackedProjectGroupIds: new Set(),
    groupKeyByRowKey: new Map(),
    groupIndexByRowKey: new Map(),
    agentSendTargetWorktreeId: null,
    worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
    nativeLineageDropTargetId: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    currentWorktreeId: null,
    highlightedRevealRowKey: null,
    selectedWorktreeIds: new Set(),
    selectedWorktrees: [],
    getActiveSurfaceVariant: () => 'primary',
    getLineageToggleHandler: () => () => {},
    onSelectionGesture: () => false,
    onContextMenuSelect: () => [],
    onImmediateActivate: () => {},
    onRowClickCapture: () => {},
    onRowPointerDown: () => {},
    onCardDragStart: () => {},
    onCardDragEnd: () => {},
    ...overrides
  }
}

function cardFlags(
  markup: string
): { id: string; active: string; surface: string; current: string }[] {
  return [
    ...markup.matchAll(
      /data-worktree-card-host-identity="([^"]*)" data-card-active="([^"]*)" data-card-surface="([^"]*)" data-card-current="([^"]*)"/g
    )
  ].map(([, id, active, surface, current]) => ({
    id,
    active,
    surface,
    current
  }))
}

function folderWorkspace(executionHostId: ExecutionHostId): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'group-1',
    name: 'shared folder',
    folderPath: '/srv/shared',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderRow(executionHostId: ExecutionHostId): FolderWorkspaceItemRow {
  return {
    type: 'folder-workspace',
    key: `folder-workspace:${executionHostId}`,
    folderWorkspace: folderWorkspace(executionHostId),
    projectGroup: {
      id: 'group-1',
      name: 'Group 1',
      parentPath: '/srv',
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    } satisfies ProjectGroup,
    depth: 0,
    groupDepth: 0
  }
}

function folderContext(
  overrides: Partial<
    Pick<
      FolderWorkspaceRowContext,
      'activeWorktreeId' | 'activeWorkspaceExecutionHostId' | 'currentWorktreeId'
    >
  >
): FolderWorkspaceRowContext {
  return {
    groupBy: 'none',
    newCardStyle: false,
    settings: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    currentWorktreeId: null,
    selectedWorktreeIds: new Set(),
    repoMap: new Map(),
    worktreeMap: new Map(),
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    prCache: null,
    hostedReviewCache: null,
    getCachedFolderWorkspacePathStatus: () => null,
    onSelectionGesture: () => false,
    onContextMenuSelect: () => [],
    onImmediateActivate: () => {},
    onRowClickCapture: () => {},
    onRowPointerDown: () => {},
    ...overrides
  }
}

function virtualItem(index: number): VirtualItem {
  return { key: index, index, start: index * 100, end: (index + 1) * 100, size: 100, lane: 0 }
}

describe('sidebar host-collision active row', () => {
  it('marks only the matching-host item row active when workspace ids collide', () => {
    const markup = [itemRow('local'), itemRow('ssh:host-b')]
      .map((row) =>
        renderToStaticMarkup(
          renderWorktreeItemRow(
            itemContext({
              activeWorktreeId: SHARED_ID,
              activeWorkspaceExecutionHostId: 'ssh:host-b',
              currentWorktreeId: SHARED_ID
            }),
            row,
            false
          )
        )
      )
      .join('')

    expect(cardFlags(markup)).toEqual([
      { id: 'local|repo-1::/repo', active: 'false', surface: 'false', current: 'false' },
      { id: 'ssh:host-b|repo-1::/repo', active: 'true', surface: 'true', current: 'true' }
    ])
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
  })

  // Why: single-host installs never stamp the active host, so the bare match must survive.
  it('keeps the bare match when the session names no host', () => {
    const markup = renderToStaticMarkup(
      renderWorktreeItemRow(
        itemContext({ activeWorktreeId: SHARED_ID, currentWorktreeId: SHARED_ID }),
        itemRow(undefined),
        false
      )
    )

    expect(cardFlags(markup)).toEqual([
      { id: '|repo-1::/repo', active: 'true', surface: 'true', current: 'true' }
    ])
  })

  it('marks only the matching-host folder row active when workspace ids collide', () => {
    const markup = [folderRow('local'), folderRow('ssh:host-b')]
      .map((row) =>
        renderToStaticMarkup(
          renderFolderWorkspaceVirtualRow({
            ctx: folderContext({
              activeWorktreeId: SHARED_FOLDER_ID,
              activeWorkspaceExecutionHostId: 'ssh:host-b',
              currentWorktreeId: SHARED_FOLDER_ID
            }),
            row,
            vItem: virtualItem(0),
            measureVirtualRowElement: () => {}
          })
        )
      )
      .join('')

    expect(cardFlags(markup)).toEqual([
      { id: 'local|folder:shared-folder', active: 'false', surface: 'false', current: 'false' },
      {
        id: 'ssh:host-b|folder:shared-folder',
        active: 'true',
        surface: 'true',
        current: 'true'
      }
    ])
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('does not light a folder row on another host when the active folder is unhosted', () => {
    const markup = renderToStaticMarkup(
      renderFolderWorkspaceVirtualRow({
        ctx: folderContext({
          activeWorktreeId: SHARED_FOLDER_ID,
          activeWorkspaceExecutionHostId: 'local',
          currentWorktreeId: SHARED_FOLDER_ID
        }),
        row: folderRow('ssh:host-b'),
        vItem: virtualItem(0),
        measureVirtualRowElement: () => {}
      })
    )

    expect(cardFlags(markup)).toEqual([
      { id: 'ssh:host-b|folder:shared-folder', active: 'false', surface: 'false', current: 'false' }
    ])
  })

  it('gives the parent an active surface only for a child on the active host', () => {
    // The lineage group is one host's parent + that host's own children. The active
    // row is the same-id child on the OTHER host, which lives in a different group —
    // a bare id compare still lights this parent's surface through it.
    const parent = itemRow('local')
    const localChild = {
      ...itemRow('local'),
      rowKey: 'all:local|child',
      depth: 1,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage dispatch reads only the id/host fields this child fixture supplies; a full Worktree needs catalog state this suite does not build.
      worktree: { id: 'child', repoId: 'repo-1', hostId: 'local' } as unknown as Worktree
    }

    const dispatchContext = (
      activeWorkspaceExecutionHostId: ExecutionHostId
    ): WorktreeVirtualRowContext =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row dispatch reads only the context fields this fixture populates; the rest of WorktreeVirtualRowContext never reaches the rendered rows.
      ({
        renderRows: [],
        firstHeaderIndex: -1,
        activeStickyHeaderIndexRef: { current: null },
        activeStickyHostIndexRef: { current: null },
        measureVirtualRowElement: () => {},
        groupBy: 'none',
        workspaceStatuses: [],
        activeWorktreeId: 'child',
        worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
        orderedHostIds: [],
        hostDrag: { state: { draggingHostId: null }, onHandlePointerDown: () => {} },
        toggleGroupWithScrollAnchor: () => {},
        header: {},
        item: itemContext({
          activeWorktreeId: 'child',
          activeWorkspaceExecutionHostId,
          currentWorktreeId: 'child'
        }),
        folderWorkspace: folderContext({}),
        importedWorktreeCardActionState: new Map(),
        newExternalWorktreeInboxActionState: new Map()
      }) as unknown as WorktreeVirtualRowContext

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a lineage-group row is identified by key and rows alone; the dispatch under test reads nothing else off RenderRow.
    const lineageGroup = {
      type: 'lineage-group',
      key: 'lineage:local|parent',
      rows: [parent, localChild]
    } as unknown as RenderRow

    const activeOnLocalHost = renderToStaticMarkup(
      renderWorktreeVirtualRow(dispatchContext('local'), lineageGroup, virtualItem(0))
    )
    const activeOnOtherHost = renderToStaticMarkup(
      renderWorktreeVirtualRow(dispatchContext('ssh:host-b'), lineageGroup, virtualItem(0))
    )

    // Parent is on `local`: the local child keeps the parent's active surface, the
    // same-id child on `ssh:host-b` must not.
    expect(cardFlags(activeOnLocalHost).map((card) => card.surface)).toEqual(['true', 'true'])
    expect(cardFlags(activeOnOtherHost).map((card) => card.surface)).toEqual(['false', 'false'])
  })
})
