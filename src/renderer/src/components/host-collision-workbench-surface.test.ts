// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { makeRepo, makeTerminalTab, makeWorktree } from './worktree-jump/worktree-jump-palette-test-fixtures'
import { useTerminalWorkspaceFoundation } from './terminal/workbench/use-terminal-workspace-foundation'
import { useTerminalWorkspaceStoreBindings } from './terminal/workbench/use-terminal-workspace-store-bindings'
import { useTerminalWorkspaceProjection } from './terminal/workbench/use-terminal-workspace-projection'
import type { AppState } from '../store/types'

// Why (STA-4343): one repo on several execution hosts publishes the SAME worktree id, so the
// unified session keeps one `host|id` row per claimant. The workbench is bare-id keyed, so a
// click on the other host's card keeps `activeWorktreeId` and swaps only the active host's stamp
// — and the surface kept painting the primary host's tabs. These tests pin the workbench's row
// reads to the ACTIVE workspace's host, and pin that nothing else changes spelling.

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`
const LOCAL_HOST = 'local' as const
const SSH_HOST = 'ssh:paired-box' as const

const localKey = `${LOCAL_HOST}|${CONTESTED_ID}`
const sshKey = `${SSH_HOST}|${CONTESTED_ID}`

const initialState = useAppStore.getInitialState()

/** One repo path claimed by two hosts, plus a workspace only one host publishes. */
function catalog(): Pick<AppState, 'repos' | 'worktreesByRepo'> {
  return {
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: LOCAL_HOST, path: 'C:\\vmd' }),
        makeWorktree(CONTESTED_ID, 'vmd', { hostId: SSH_HOST, path: 'C:\\vmd' }),
        makeWorktree(UNCONTESTED_ID, 'other', { hostId: LOCAL_HOST, path: 'C:\\other' })
      ]
    }
  }
}

function makeBrowserWorkspace(
  id: string
): NonNullable<AppState['browserTabsByWorktree'][string]>[number] {
  return {
    id,
    worktreeId: CONTESTED_ID,
    activePageId: `${id}-page`,
    pageIds: [`${id}-page`],
    url: 'https://example.com',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

/** The session the store holds after hydration: one row per claimant, distinct tabs. */
function contestedRows(): Pick<
  AppState,
  'tabsByWorktree' | 'browserTabsByWorktree' | 'tabBarOrderByWorktree' | 'activeTabIdByWorktree'
> {
  return {
    tabsByWorktree: {
      [localKey]: [makeTerminalTab('tab-local', CONTESTED_ID, 'Local shell')],
      [sshKey]: [makeTerminalTab('tab-ssh', CONTESTED_ID, 'SSH shell')],
      [UNCONTESTED_ID]: [makeTerminalTab('tab-other', UNCONTESTED_ID, 'Other shell')]
    },
    browserTabsByWorktree: {
      [localKey]: [makeBrowserWorkspace('ws-local')],
      [sshKey]: [makeBrowserWorkspace('ws-ssh')]
    },
    tabBarOrderByWorktree: {
      [localKey]: ['tab-local'],
      [sshKey]: ['tab-ssh']
    },
    activeTabIdByWorktree: { [localKey]: 'tab-local', [sshKey]: 'tab-ssh' }
  }
}

/** The real controller chain, as far as the projection — the workbench's row reads. */
function useWorkbenchProjection() {
  const foundation = useTerminalWorkspaceFoundation()
  const store = Object.assign(foundation, useTerminalWorkspaceStoreBindings(foundation))
  return Object.assign(store, useTerminalWorkspaceProjection(store))
}

function activate(hostId: AppState['activeWorkspaceExecutionHostId']): void {
  act(() => {
    useAppStore.setState({
      activeWorktreeId: CONTESTED_ID,
      activeWorkspaceExecutionHostId: hostId
    })
  })
}

describe('host-colliding workbench surface reads', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    // The projection's capability sync asks the preload for snapshot capability; a null answer
    // means "unknown" and the sync backs off, which is what a hidden test window does anyway.
    Object.assign(window, {
      api: { pty: { getAuthoritativeBufferSnapshotCapabilities: async () => null } }
    })
    useAppStore.setState({ ...catalog(), ...contestedRows() })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('reads the SSH host row when the SSH host is the active workspace', () => {
    activate(SSH_HOST)

    const { result } = renderHook(() => useWorkbenchProjection())

    expect(result.current.activeWorktreeSessionRowKey).toBe(sshKey)
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(['tab-ssh'])
    expect(result.current.worktreeBrowserTabs.map((tab) => tab.id)).toEqual(['ws-ssh'])
    expect(result.current.tabBarOrder).toEqual(['tab-ssh'])
  })

  it('flips to the local host row when the local card is clicked', () => {
    const { result, rerender } = renderHook(() => useWorkbenchProjection())
    activate(SSH_HOST)
    rerender()
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(['tab-ssh'])

    // The whole point: the bare id is unchanged, so only the host stamp moving can re-point the
    // surface. Without the subscribed row key every dep holds and the SSH tabs stay on screen.
    activate(LOCAL_HOST)
    rerender()

    expect(result.current.renderedActiveWorktreeId).toBe(CONTESTED_ID)
    expect(result.current.activeWorktreeSessionRowKey).toBe(localKey)
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(['tab-local'])
    expect(result.current.worktreeBrowserTabs.map((tab) => tab.id)).toEqual(['ws-local'])
    expect(result.current.tabBarOrder).toEqual(['tab-local'])
  })

  it('reads no row for a contested id whose host is unknown', () => {
    // No active host stamp: the accessor's empty-prefix bucket matches no row, which is the
    // correct answer — falling back to the bare key would show the primary host's tabs.
    activate(null)

    const { result } = renderHook(() => useWorkbenchProjection())

    expect(result.current.tabs).toEqual([])
    expect(result.current.worktreeBrowserTabs).toEqual([])
  })

  it('keeps the bare-key read for a workspace only one host publishes', () => {
    act(() => {
      useAppStore.setState({
        activeWorktreeId: UNCONTESTED_ID,
        activeWorkspaceExecutionHostId: LOCAL_HOST
      })
    })

    const { result } = renderHook(() => useWorkbenchProjection())

    expect(result.current.activeWorktreeSessionRowKey).toBe(UNCONTESTED_ID)
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(['tab-other'])
  })

  it('resolves the layout and focused group from the active host row', () => {
    useAppStore.setState({
      groupsByWorktree: {
        [localKey]: [
          {
            id: 'group-local',
            worktreeId: CONTESTED_ID,
            activeTabId: null,
            tabOrder: [],
            recentTabIds: []
          }
        ],
        [sshKey]: [
          {
            id: 'group-ssh',
            worktreeId: CONTESTED_ID,
            activeTabId: null,
            tabOrder: [],
            recentTabIds: []
          }
        ]
      },
      activeGroupIdByWorktree: { [localKey]: 'group-local', [sshKey]: 'group-ssh' }
    })
    activate(SSH_HOST)

    const { result } = renderHook(() => useWorkbenchProjection())

    expect(result.current.getEffectiveLayoutForWorktree(CONTESTED_ID)).toEqual({
      type: 'leaf',
      groupId: 'group-ssh'
    })
    activate(LOCAL_HOST)
    expect(result.current.getEffectiveLayoutForWorktree(CONTESTED_ID)).toEqual({
      type: 'leaf',
      groupId: 'group-local'
    })
  })
})
