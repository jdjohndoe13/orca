import { describe, it, expect } from 'vitest'
import {
  splitWorkspaceSessionByHost,
  mergeWorkspaceSessionsFromHosts,
  type HostIdByWorktreeId
} from './workspace-session-host-split'
import { mergeWorkspaceSessionsWithHostShadow } from './workspace-session-host-contention'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS } from '../../../shared/workspace-session-worktree-key'
import { HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import type { BrowserPage } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const RUNTIME_A: ExecutionHostId = 'runtime:env-a'
const RUNTIME_B: ExecutionHostId = 'runtime:env-b'

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeUnifiedTab(id: string, worktreeId: string): Tab {
  return {
    id,
    entityId: id,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId: 'leaf-1' }, activeLeafId: 'leaf-1', expandedLeafId: null }
}

function makeBrowserPage(id: string, workspaceId: string, worktreeId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId,
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

/** worktree id convention in these tests: `<host>-wt-...`, except local ones. */
function ownerByPrefix(): HostIdByWorktreeId {
  return (worktreeId: string) => {
    if (worktreeId.startsWith('a-')) {
      return RUNTIME_A
    }
    if (worktreeId.startsWith('b-')) {
      return RUNTIME_B
    }
    return LOCAL_EXECUTION_HOST_ID
  }
}

describe('splitWorkspaceSessionByHost', () => {
  it('keeps global fields only on the local slice', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      activeWorktreeId: 'local-wt',
      activeTabId: 'tab-1',
      browserUrlHistory: [
        { url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }
      ],
      activeConnectionIdsAtShutdown: ['ssh-target']
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeRepoId).toBe('repo-1')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeConnectionIdsAtShutdown).toEqual(['ssh-target'])
    // No runtime slice is created when nothing is worktree-owned by it.
    expect(slices[RUNTIME_A]).toBeUndefined()
  })

  it('never replicates a local-owned global onto a non-local slice', () => {
    // The regression this pins: one template handed to every host put a byte-identical copy of
    // local's browserUrlHistory in each runtime partition, undoing #18161's load-time drop on the
    // very next full snapshot write. 66 KB per host at 200 entries, growing with host count.
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      browserUrlHistory: [
        { url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }
      ],
      workspaceDocHistory: [
        {
          docLocation: { kind: 'workspace-doc', worktreeId: 'local-wt', filePath: 'a.md' },
          title: 'a.md',
          lastVisitedAt: 2,
          visitCount: 1
        }
      ],
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(Object.keys(slices).sort()).toEqual([LOCAL_EXECUTION_HOST_ID, RUNTIME_A, RUNTIME_B])
    for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
      expect(slices[LOCAL_EXECUTION_HOST_ID]?.[field]).toEqual(state[field])
      expect(Object.hasOwn(slices[RUNTIME_A] ?? {}, field)).toBe(false)
      expect(Object.hasOwn(slices[RUNTIME_B] ?? {}, field)).toBe(false)
    }
    // The read path is unaffected: local always carries them, so the merge never reaches its
    // fallback to another slice.
    const merged = mergeWorkspaceSessionsFromHosts(slices)
    for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
      expect(merged[field]).toEqual(state[field])
    }
  })

  it('routes worktree-keyed maps to their owner host', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(Object.keys(slices[LOCAL_EXECUTION_HOST_ID]?.tabsByWorktree ?? {})).toEqual(['local-wt'])
    expect(Object.keys(slices[RUNTIME_A]?.tabsByWorktree ?? {})).toEqual(['a-wt'])
    expect(Object.keys(slices[RUNTIME_B]?.tabsByWorktree ?? {})).toEqual(['b-wt'])
  })

  it('routes host-qualified visit recency to the partition the key names', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: {
        'local-wt': 1,
        'a-wt': 2,
        'ssh:builder|ssh-wt': 3,
        'runtime:env-a|a-wt': 4
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    // Why the key's own host and not 'local': the recency row has to land in the same partition as
    // the workspace it describes, or a read that adopts one without the other reports a visit for
    // a workspace it has no tabs for (#12721).
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.lastVisitedAtByWorktreeId).toEqual({ 'local-wt': 1 })
    expect(slices[RUNTIME_A]?.lastVisitedAtByWorktreeId).toEqual({
      'a-wt': 2,
      'runtime:env-a|a-wt': 4
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal is a well-formed ssh: host id; ExecutionHostId is a template-literal type a plain string cannot satisfy.
    expect(slices['ssh:builder' as ExecutionHostId]?.lastVisitedAtByWorktreeId).toEqual({
      'ssh:builder|ssh-wt': 3
    })
  })

  it('routes tab-keyed maps via the owning tab worktree (legacy + unified)', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] },
      unifiedTabs: { 'b-wt': [makeUnifiedTab('t-b', 'b-wt')] },
      terminalLayoutsByTabId: { 't-a': makeLayout(), 't-b': makeLayout() },
      remoteSessionIdsByTabId: { 't-a': 'sess-a', 't-b': 'sess-b' }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.terminalLayoutsByTabId).toHaveProperty('t-a')
    expect(slices[RUNTIME_B]?.terminalLayoutsByTabId).toHaveProperty('t-b')
    expect(slices[RUNTIME_A]?.remoteSessionIdsByTabId).toEqual({ 't-a': 'sess-a' })
    expect(slices[RUNTIME_B]?.remoteSessionIdsByTabId).toEqual({ 't-b': 'sess-b' })
  })

  it('keeps orphan tab layouts (unknown worktree) in the local slice', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { orphan: makeLayout() }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.terminalLayoutsByTabId).toHaveProperty('orphan')
    expect(slices[RUNTIME_A]).toBeUndefined()
  })

  it('routes tab-keyed rows through a caller-supplied tab index when the payload has no tab rows', () => {
    // A debounced patch that changed only layouts (a park capture) or only PTY bindings carries
    // no tabsByWorktree; the index stands in for the rows the payload never mentioned.
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { 't-a': makeLayout() },
      remoteSessionIdsByTabId: { 't-a': 'sess-a' },
      terminalPtyIncarnationsByPaneKey: { 't-a:leaf-1': 'inc-3' }
    }
    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix(), {
      worktreeIdByTabId: new Map([['t-a', 'a-wt-1']])
    })
    expect(slices[RUNTIME_A]?.terminalLayoutsByTabId).toHaveProperty('t-a')
    expect(slices[RUNTIME_A]?.remoteSessionIdsByTabId).toEqual({ 't-a': 'sess-a' })
    expect(slices[RUNTIME_A]?.terminalPtyIncarnationsByPaneKey).toEqual({ 't-a:leaf-1': 'inc-3' })
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.terminalLayoutsByTabId).toEqual({})
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.remoteSessionIdsByTabId).toEqual({})
  })

  it('keeps a tab the supplied index does not name in the local slice', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { orphan: makeLayout() }
    }
    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix(), {
      worktreeIdByTabId: new Map([['t-a', 'a-wt-1']])
    })
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.terminalLayoutsByTabId).toHaveProperty('orphan')
    expect(slices[RUNTIME_A]).toBeUndefined()
  })

  it('routes browser pages via their record worktreeId', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      browserPagesByWorkspace: {
        'ws-a': [makeBrowserPage('p-a', 'ws-a', 'a-wt')],
        'ws-local': [makeBrowserPage('p-local', 'ws-local', 'local-wt')]
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.browserPagesByWorkspace).toHaveProperty('ws-a')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.browserPagesByWorkspace).toHaveProperty('ws-local')
  })

  it('routes markdown frontmatter visibility via the open file worktree', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        'a-wt': [
          {
            filePath: '/a/file.md',
            relativePath: 'file.md',
            worktreeId: 'a-wt',
            language: 'markdown'
          }
        ]
      },
      markdownFrontmatterVisible: { '/a/file.md': true, '/unknown.md': true }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.markdownFrontmatterVisible).toEqual({ '/a/file.md': true })
    // Unknown file id has no owner → stays local.
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.markdownFrontmatterVisible).toEqual({
      '/unknown.md': true
    })
  })

  it('partitions activeWorktreeIdsOnShutdown by owner', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeIdsOnShutdown: ['a-wt', 'b-wt', 'local-wt']
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.activeWorktreeIdsOnShutdown).toEqual(['a-wt'])
    expect(slices[RUNTIME_B]?.activeWorktreeIdsOnShutdown).toEqual(['b-wt'])
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeWorktreeIdsOnShutdown).toEqual(['local-wt'])
  })

  it('routes sleeping agent records via their worktreeId', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-a': {
          paneKey: 'pane-a',
          worktreeId: 'a-wt',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'x' },
          prompt: 'p',
          state: 'done',
          capturedAt: 1,
          updatedAt: 2
        }
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-a')
  })

  it('routes terminal incarnation authority with its owning surface', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('tab-a', 'a-wt')] },
      terminalPtyIncarnationsByPaneKey: { 'tab-a:leaf-a': 'inc-a' },
      terminalSurfaceTombstonesByPaneKey: {
        'tab-b:leaf-b': {
          worktreeId: 'b-wt',
          parentTabId: 'tab-b',
          leafId: 'leaf-b',
          ptyId: 'pty-b',
          incarnationId: 'inc-b',
          retiredAt: 1
        }
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.terminalPtyIncarnationsByPaneKey).toEqual({
      'tab-a:leaf-a': 'inc-a'
    })
    expect(slices[RUNTIME_B]?.terminalSurfaceTombstonesByPaneKey).toHaveProperty('tab-b:leaf-b')
  })

  it('does not send host-private topology authority through renderer partitions', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('tab-a', 'a-wt')] },
      terminalTopologyRevisionByRepoId: { 'a-repo': 7 }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.terminalTopologyRevisionByRepoId).toBeUndefined()
    expect(slices[RUNTIME_A]?.terminalTopologyRevisionByRepoId).toBeUndefined()
  })
})

describe('mergeWorkspaceSessionsFromHosts', () => {
  it('takes global fields from the local slice', () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'local-repo',
        activeWorktreeId: 'local-wt'
      },
      [RUNTIME_A]: {
        ...getDefaultWorkspaceSession(),
        // A non-local slice's global fields must lose to local.
        activeRepoId: 'runtime-repo',
        tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] }
      }
    })

    expect(merged.activeRepoId).toBe('local-repo')
    expect(merged.tabsByWorktree).toHaveProperty('a-wt')
  })

  it('falls back to a non-local slice for globals when local is absent', () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [RUNTIME_A]: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'runtime-repo'
      }
    })
    expect(merged.activeRepoId).toBe('runtime-repo')
  })

  it('tolerates missing and empty slices', () => {
    const merged = mergeWorkspaceSessionsFromHosts({})
    expect(merged.tabsByWorktree).toBeUndefined()
    expect(() => mergeWorkspaceSessionsFromHosts({ [RUNTIME_A]: undefined })).not.toThrow()
  })

  it('does not merge host-private topology authority into unified renderer state', () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { duplicate: 3 }
      },
      [RUNTIME_A]: {
        ...getDefaultWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { duplicate: 9 }
      }
    })

    expect(merged.terminalTopologyRevisionByRepoId).toBeUndefined()
  })
})

describe('split → merge round trip', () => {
  function roundTrip(state: WorkspaceSessionState): WorkspaceSessionState {
    return mergeWorkspaceSessionsFromHosts(splitWorkspaceSessionByHost(state, ownerByPrefix()))
  }

  it('preserves a representative multi-host state', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      activeWorktreeId: 'a-wt',
      activeTabId: 't-a',
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      },
      unifiedTabs: { 'b-wt': [makeUnifiedTab('t-b', 'b-wt')] },
      terminalLayoutsByTabId: { 't-local': makeLayout(), 't-a': makeLayout(), 't-b': makeLayout() },
      remoteSessionIdsByTabId: { 't-a': 'sess-a' },
      activeTabIdByWorktree: { 'local-wt': 't-local', 'a-wt': 't-a' },
      activeWorktreeIdsOnShutdown: ['a-wt', 'b-wt'],
      lastVisitedAtByWorktreeId: { 'a-wt': 10, 'local-wt': 5 },
      defaultTerminalTabsAppliedByWorktreeId: { 'a-wt': true },
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      browserUrlHistory: [
        { url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }
      ]
    }

    expect(roundTrip(state)).toEqual(state)
  })

  it('preserves the default (empty) session', () => {
    const state = getDefaultWorkspaceSession()
    expect(roundTrip(state)).toEqual(state)
  })

  it('is byte-identical when the contested set is empty', () => {
    // The whole gate for the 99.9%: passing the (empty) contested set alongside the slices must
    // change nothing at all — no re-key, no re-order, no new bucket.
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      },
      activeTabIdByWorktree: { 'local-wt': 't-local', 'a-wt': 't-a' },
      lastVisitedAtByWorktreeId: { 'a-wt': 10, 'local-wt': 5 }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())
    expect(mergeWorkspaceSessionsFromHosts(slices, new Set())).toEqual(state)
  })

  it('keeps orphan-owned entries in local and preserves them', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { orphan: makeLayout() },
      remoteSessionIdsByTabId: { orphan: 'sess' }
    }
    const result = roundTrip(state)
    expect(result.terminalLayoutsByTabId).toEqual(state.terminalLayoutsByTabId)
    expect(result.remoteSessionIdsByTabId).toEqual(state.remoteSessionIdsByTabId)
  })

  it('handles a host with only runtime-owned worktrees (empty local maps)', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] },
      terminalLayoutsByTabId: { 't-a': makeLayout() }
    }
    expect(roundTrip(state)).toEqual(state)
  })

  it('keeps four claimants of one contested id as four buckets and back to four bare rows', () => {
    // The root-cause gate: one repo path registered on four hosts publishes ONE id, so all four
    // cards painted the primary's tabs. This single test pins the three rules together — the
    // display fix (four rows reach the renderer), the disk-format rule (every partition holds
    // only bare keys), and the write-back guarantee (each row returns to its own partition).
    const SHARED = 'repo-shared::/work/orca'
    const CLAIMANTS: readonly { host: ExecutionHostId; name: string }[] = [
      { host: LOCAL_EXECUTION_HOST_ID, name: 'local' },
      { host: 'ssh:builder', name: 'builder' },
      { host: 'ssh:runner', name: 'runner' },
      { host: 'ssh:deploy', name: 'deploy' }
    ]
    // Each partition carries the shapes the derived indexes read: a tab row (tabKeyed follows
    // it), an open file (fileKeyed follows it), a pane key (paneKeyed follows the tab).
    const partition = (name: string): WorkspaceSessionState => ({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [SHARED]: [makeTab(`t-${name}`, SHARED)] },
      activeTabIdByWorktree: { [SHARED]: `t-${name}` },
      openFilesByWorktree: {
        [SHARED]: [
          {
            filePath: `/${name}/file.md`,
            relativePath: 'file.md',
            worktreeId: SHARED,
            language: 'markdown'
          }
        ]
      },
      terminalLayoutsByTabId: { [`t-${name}`]: makeLayout() },
      markdownFrontmatterVisible: { [`/${name}/file.md`]: true },
      terminalPtyIncarnationsByPaneKey: { [`t-${name}:leaf-1`]: `inc-${name}` }
    })

    const merged = mergeWorkspaceSessionsWithHostShadow({
      [LOCAL_EXECUTION_HOST_ID]: partition('local'),
      'ssh:builder': partition('builder'),
      'ssh:runner': partition('runner'),
      'ssh:deploy': partition('deploy')
    })

    // (display) Four simultaneous buckets, every claimant qualified — including the primary —
    // and no bare key for a contested id to fall back onto.
    for (const { host, name } of CLAIMANTS) {
      expect(merged.session.tabsByWorktree?.[`${host}|${SHARED}`]?.map((t) => t.id)).toEqual([
        `t-${name}`
      ])
    }
    expect(merged.session.tabsByWorktree?.[SHARED]).toBeUndefined()
    // The shadow is no longer what carries a contested row home: the qualified key names the
    // partition, so nothing is parked for the contested case.
    expect(merged.shadow).toEqual({})

    // The catalog's opinion is deliberately wrong here (it answers 'local' for everything); the
    // key's own prefix wins, so a transient disagreement between the two contested sets cannot
    // route a row to a partition that loses it.
    const back = splitWorkspaceSessionByHost(merged.session, () => LOCAL_EXECUTION_HOST_ID)

    // (disk format) No qualified key survives anywhere in the write: every key of every
    // worktree-keyed field of every partition is bare. `lastVisitedAtByWorktreeId` is the one
    // field with its own host convention and is absent from this fixture, so the scan covers the
    // whole list without excusing it.
    expect(Object.keys(back).sort()).toEqual(CLAIMANTS.map((c) => c.host).sort())
    for (const { host } of CLAIMANTS) {
      const slice = back[host]
      for (const field of WORKTREE_KEYED_WORKSPACE_SESSION_FIELDS) {
        for (const key of Object.keys(slice?.[field] ?? {})) {
          expect(`${host} ${field} ${key}`).not.toContain('|')
        }
      }
    }

    // (write-back + derived indexes) Each row lands in the partition that wrote it, and the
    // tab-, file- and pane-keyed rows follow their owner WITHOUT re-keying — their own keys are
    // the tab id / file path / pane key, untouched.
    for (const { host, name } of CLAIMANTS) {
      const slice = back[host]
      expect(slice?.tabsByWorktree).toEqual({ [SHARED]: [makeTab(`t-${name}`, SHARED)] })
      expect(slice?.activeTabIdByWorktree).toEqual({ [SHARED]: `t-${name}` })
      expect(slice?.terminalLayoutsByTabId).toEqual({ [`t-${name}`]: makeLayout() })
      expect(slice?.markdownFrontmatterVisible).toEqual({ [`/${name}/file.md`]: true })
      expect(slice?.terminalPtyIncarnationsByPaneKey).toEqual({
        [`t-${name}:leaf-1`]: `inc-${name}`
      })
    }
  })

  it('routes a qualified row by its prefix even when the catalog does not yet consider it contested', () => {
    // The two contested sets have different sources and can disagree in the window between a
    // second host registering and the next write: the boot read qualified the row from the
    // PERSISTED partitions, but the live catalog still thinks the id is single-owner and answers
    // 'local' for it. The split must route by the key's own prefix, never the catalog's opinion,
    // or the co-claimant's row is written into the wrong partition and the original is lost —
    // the loss the transient disagreement must not be able to cause.
    const SHARED = 'repo-shared::/work/orca'
    const SSH_HOST: ExecutionHostId = 'ssh:builder'
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [`${SSH_HOST}|${SHARED}`]: [makeTab('t-ssh', SHARED)] },
      // The `worktreeArray` branch routes the same way; cover it so a second prefix-reading
      // branch cannot drift from the record branch.
      activeWorktreeIdsOnShutdown: [`${SSH_HOST}|${SHARED}`]
    }

    // A catalog that does NOT consider the id contested: it names exactly one host, 'local'.
    const back = splitWorkspaceSessionByHost(state, () => LOCAL_EXECUTION_HOST_ID)

    // The prefix won: the row is in the ssh partition it names, stripped back to the bare id —
    // not in the local partition the catalog's opinion would have routed it to.
    expect(back[SSH_HOST]?.tabsByWorktree).toEqual({ [SHARED]: [makeTab('t-ssh', SHARED)] })
    expect(back[SSH_HOST]?.activeWorktreeIdsOnShutdown).toEqual([SHARED])
    expect(back[LOCAL_EXECUTION_HOST_ID]?.tabsByWorktree?.[SHARED]).toBeUndefined()
    expect(back[LOCAL_EXECUTION_HOST_ID]?.activeWorktreeIdsOnShutdown ?? []).not.toContain(SHARED)
  })
})

/**
 * The main-process load path drops a global field from a non-local partition when the local slice
 * already has it, on the strength of exactly these two rules. If either moves, that prune starts
 * discarding a value the renderer would otherwise have read.
 */
describe('mergeWorkspaceSessionsFromHosts global-field precedence', () => {
  const localEntry = {
    url: 'local',
    normalizedUrl: 'local',
    title: 'l',
    lastVisitedAt: 2,
    visitCount: 1
  }
  const hostEntry = {
    url: 'host',
    normalizedUrl: 'host',
    title: 'h',
    lastVisitedAt: 1,
    visitCount: 1
  }

  it("takes a global field from 'local' whenever local has one, ignoring every other slice", () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        browserUrlHistory: [localEntry]
      },
      [RUNTIME_A]: { ...getDefaultWorkspaceSession(), browserUrlHistory: [hostEntry] }
    })
    expect(merged.browserUrlHistory).toEqual([localEntry])
  })

  it('falls back to another slice only when local does not have the field', () => {
    const local = getDefaultWorkspaceSession()
    delete local.browserUrlHistory
    const merged = mergeWorkspaceSessionsFromHosts({
      [LOCAL_EXECUTION_HOST_ID]: local,
      [RUNTIME_A]: { ...getDefaultWorkspaceSession(), browserUrlHistory: [hostEntry] }
    })
    expect(merged.browserUrlHistory).toEqual([hostEntry])
  })
})
