// @vitest-environment happy-dom
import { act } from 'react'
import type * as ReactModule from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '../store/types'
import { makeRepo, makeWorktree } from './worktree-jump/worktree-jump-palette-test-fixtures'
import TerminalPaneOverlayLayer from './terminal-pane/mounting/TerminalPaneOverlayLayer'
import { TerminalLegacyTerminalPanes } from './terminal/workbench/TerminalLegacyTerminalPanes'
import type { TerminalController } from './terminal/workbench/use-terminal-controller'

// Why (STA-4343, second half): the two rows of a contested id can hold the SAME tab id — the
// mirrored `web-terminal-<hostTabId>` id is minted from the HOST's own tab id, and two hosts'
// tab ids collide just like their worktree ids did. The pane's mount identity was the tab id,
// so switching the active host swapped the row the overlay renders but never remounted the
// pane, and the xterm stayed attached to the previous host's dead pty stream (black panel).
// These tests pin that the pane remounts when the host flips while the tab id does not, and
// that an uncontested workspace keeps the exact bare mount identity.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  mounts: new Array<string>(),
  unmounts: new Array<string>()
}))

vi.mock('./terminal-pane/mounting/TerminalOverlaySlot', async () => {
  const { useEffect } = await vi.importActual<typeof ReactModule>('react')
  return {
    TerminalOverlaySlot: function SlotHarness({ terminalTabId }: { terminalTabId: string }) {
      harness.mounts.push(terminalTabId)
      useEffect(
        () => () => {
          harness.unmounts.push(terminalTabId)
        },
        [terminalTabId]
      )
      return null
    }
  }
})

vi.mock('./terminal-pane/TerminalPane', async () => {
  const { useEffect } = await vi.importActual<typeof ReactModule>('react')
  return {
    default: function PaneHarness({ tabId }: { tabId: string }) {
      harness.mounts.push(tabId)
      useEffect(
        () => () => {
          harness.unmounts.push(tabId)
        },
        [tabId]
      )
      return null
    }
  }
})

vi.mock('./native-chat/pane/routing/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))

vi.mock('./terminal-pane/parking/lifecycle/use-terminal-tab-cold-parking', () => ({
  useTerminalTabColdParking: () => new Set()
}))

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`
const LOCAL_HOST = 'local' as const
const SSH_HOST = 'ssh:paired-box' as const
const localKey = `${LOCAL_HOST}|${CONTESTED_ID}`
const sshKey = `${SSH_HOST}|${CONTESTED_ID}`

// The collision itself: one tab id, mirrored verbatim from the two hosts' own tab ids, with
// each host's own `remote:` pty (the same shape the live profile store shows).
const COLLIDING_TAB_ID = 'web-terminal-c1a8b7e4-7f90-4e52-9dcc-8cdaeec20495'

const initialState = useAppStore.getInitialState()

function catalog(): Pick<AppState, 'repos' | 'worktreesByRepo'> {
  return {
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree(CONTESTED_ID, 'vmd', {
          hostId: LOCAL_HOST,
          path: 'C:\\vmd'
        }),
        makeWorktree(CONTESTED_ID, 'vmd', {
          hostId: SSH_HOST,
          path: 'C:\\vmd'
        }),
        makeWorktree(UNCONTESTED_ID, 'other', {
          hostId: LOCAL_HOST,
          path: 'C:\\other'
        })
      ]
    }
  }
}

function terminalTab(ptyId: string, startupCwd: string): TerminalTab {
  return {
    id: COLLIDING_TAB_ID,
    ptyId,
    worktreeId: CONTESTED_ID,
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    generation: 0,
    startupCwd
  }
}

function unifiedAndGroups(
  rowKey: string,
  groupId: string
): {
  unifiedTabs: Record<string, Tab[]>
  groups: Record<string, TabGroup[]>
  activeGroup: Record<string, string>
} {
  const unified: Tab = {
    id: `unified-${groupId}`,
    entityId: COLLIDING_TAB_ID,
    worktreeId: CONTESTED_ID,
    groupId,
    contentType: 'terminal',
    label: 'agent',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    unifiedTabs: { [rowKey]: [unified] },
    groups: {
      [rowKey]: [
        {
          id: groupId,
          worktreeId: CONTESTED_ID,
          activeTabId: unified.id,
          tabOrder: [unified.id]
        }
      ]
    },
    activeGroup: { [rowKey]: groupId }
  }
}

/** Both hosts' rows hold the SAME tab id; only the pty and the cwd differ. */
function contestedRows(): Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'
> {
  const local = unifiedAndGroups(localKey, 'group-local')
  const ssh = unifiedAndGroups(sshKey, 'group-ssh')
  return {
    tabsByWorktree: {
      [localKey]: [terminalTab('remote:525d@@term_196e', 'C:\\vmd\\local')],
      [sshKey]: [terminalTab('remote:644f@@term_719f', 'C:\\vmd\\ssh')]
    },
    unifiedTabsByWorktree: { ...local.unifiedTabs, ...ssh.unifiedTabs },
    groupsByWorktree: { ...local.groups, ...ssh.groups },
    activeGroupIdByWorktree: { ...local.activeGroup, ...ssh.activeGroup }
  }
}

function activate(hostId: AppState['activeWorkspaceExecutionHostId']): void {
  act(() => {
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: hostId
    })
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  harness.mounts = []
  harness.unmounts = []
  useAppStore.setState(initialState, true)
  useAppStore.setState({ ...catalog(), ...contestedRows() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
})

function renderOverlay(): void {
  act(() => {
    root.render(
      <TerminalPaneOverlayLayer worktreeId={CONTESTED_ID} worktreePath="C:\\vmd" isWorktreeActive />
    )
  })
}

describe('host-colliding pane mount identity (overlay layer)', () => {
  it('remounts the pane when the active host flips while the tab id holds', () => {
    activate(LOCAL_HOST)
    renderOverlay()
    expect(harness.mounts).toEqual([COLLIDING_TAB_ID])
    expect(harness.unmounts).toEqual([])

    // The whole point: bare id, tab id, and generation all hold — only the host stamp moves,
    // and the pane (xterm + pty stream) must be replaced, not kept.
    activate(SSH_HOST)
    renderOverlay()
    expect(harness.unmounts).toEqual([COLLIDING_TAB_ID])
    expect(harness.mounts).toEqual([COLLIDING_TAB_ID, COLLIDING_TAB_ID])

    // And back: the pane must remount again onto the local row's own pty.
    activate(LOCAL_HOST)
    renderOverlay()
    expect(harness.unmounts).toHaveLength(2)
    expect(harness.mounts).toHaveLength(3)
  })

  it('keeps the bare mount identity for a workspace only one host publishes', () => {
    const bare = 'tab-bare'
    useAppStore.setState({
      tabsByWorktree: {
        [UNCONTESTED_ID]: [
          {
            id: bare,
            ptyId: 'pty-bare',
            worktreeId: UNCONTESTED_ID,
            title: 'bare',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            generation: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [UNCONTESTED_ID]: [
          {
            id: 'unified-bare',
            entityId: bare,
            worktreeId: UNCONTESTED_ID,
            groupId: 'group-bare',
            contentType: 'terminal',
            label: 'bare',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      groupsByWorktree: {
        [UNCONTESTED_ID]: [
          {
            id: 'group-bare',
            worktreeId: UNCONTESTED_ID,
            activeTabId: 'unified-bare',
            tabOrder: ['unified-bare']
          }
        ]
      },
      activeGroupIdByWorktree: { [UNCONTESTED_ID]: 'group-bare' }
    })
    act(() => {
      useAppStore.setState({
        activeWorktreeId: UNCONTESTED_ID,
        activeWorkspaceExecutionHostId: LOCAL_HOST
      })
    })
    act(() => {
      root.render(
        <TerminalPaneOverlayLayer
          worktreeId={UNCONTESTED_ID}
          worktreePath="C:\\other"
          isWorktreeActive
        />
      )
    })
    expect(harness.mounts).toEqual([bare])

    // A single-host install is byte-identical: the key stays the bare tab id, so the same
    // pane keeps its xterm across a host stamp that never qualified the key.
    act(() => {
      useAppStore.setState({ activeWorkspaceExecutionHostId: null })
    })
    act(() => {
      root.render(
        <TerminalPaneOverlayLayer
          worktreeId={UNCONTESTED_ID}
          worktreePath="C:\\other"
          isWorktreeActive
        />
      )
    })
    expect(harness.unmounts).toEqual([])
    expect(harness.mounts).toEqual([bare])
  })
})

describe('host-colliding pane mount identity (legacy panes)', () => {
  function renderLegacy(): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TerminalLegacyTerminalPanes reads only the fields listed here.
    const controller = {
      activeTabId: COLLIDING_TAB_ID,
      activeTabType: 'terminal',
      activeView: 'terminal',
      activityTerminalPortals: [],
      backgroundMountTabIdsByWorktreeRef: { current: new Map() },
      effectiveParkedTerminalWorktreeIds: new Set(),
      evictionExemptTerminalTabIds: new Set(),
      handleCloseTab: () => {},
      handlePtyExit: () => {},
      measurableBackgroundWorktreeIdsRef: { current: new Set() },
      mountedWorktreeIdsRef: { current: new Set([CONTESTED_ID]) },
      renderedActiveWorktreeId: CONTESTED_ID,
      tabsByWorktree: {
        [localKey]: [terminalTab('remote:525d@@term_196e', 'C:\\vmd\\local')],
        [sshKey]: [terminalTab('remote:644f@@term_719f', 'C:\\vmd\\ssh')]
      },
      worktreeBrowserTabs: [],
      worktreeFiles: [],
      workspaceSurfaces: [{ id: CONTESTED_ID, path: 'C:\\vmd' }]
    } as unknown as TerminalController
    act(() => {
      root.render(<TerminalLegacyTerminalPanes controller={controller} />)
    })
  }

  it('remounts the pane when the active host flips while the tab id holds', () => {
    activate(LOCAL_HOST)
    renderLegacy()
    expect(harness.mounts).toEqual([COLLIDING_TAB_ID])

    activate(SSH_HOST)
    renderLegacy()
    expect(harness.unmounts).toEqual([COLLIDING_TAB_ID])
    expect(harness.mounts).toEqual([COLLIDING_TAB_ID, COLLIDING_TAB_ID])
  })
})
