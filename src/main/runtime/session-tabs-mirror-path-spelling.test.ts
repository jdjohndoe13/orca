import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

// The relay's `session.tabs.list` is keyed by exact path spelling. A mirrored
// worktree whose id is stored as `C:\vmd` must resolve the same tabs when the
// client queries `C:/vmd`; a raw `Map.get` / `tabsByWorktree[key]` silently
// reports an empty `empty:0` snapshot instead. Windows-path-aware folding only
// (through `worktreeIdComparisonKey`), so POSIX `/a\b` stays a distinct name.
const REPO_ID = 'repo'
const WINDOWS_BACKSLASH_ID = 'repo::C:\\vmd'
const WINDOWS_FORWARD_SLASH_ID = 'repo::C:/vmd'
const POSIX_ID = 'repo::/a\\b'

function sessionWithTabs(worktreeId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: 'tab-2',
          ptyId: 'pty-2',
          worktreeId,
          title: 'Terminal 2',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    }
  }
}

function runtimeForSession(session: WorkspaceSessionState): OrcaRuntimeService {
  const store = {
    getWorkspaceSession: () => session,
    getRepo: () => ({ id: REPO_ID, path: 'C:\\repo', name: 'repo' }),
    getRepos: () => [{ id: REPO_ID, path: 'C:\\repo', name: 'repo' }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list path reads only these three store members; the rest of the runtime never touches this stub.
  return new OrcaRuntimeService(store as never)
}

describe('session.tabs.list path-spelling normalization', () => {
  it('resolves a backslash-stored worktree when queried with forward slashes', async () => {
    const runtime = runtimeForSession(sessionWithTabs(WINDOWS_BACKSLASH_ID))

    const result = await runtime.listMobileSessionTabs(`id:${WINDOWS_FORWARD_SLASH_ID}`)

    expect(result.tabs).toHaveLength(2)
  })

  it('resolves a forward-slash-stored worktree when queried with backslashes', async () => {
    const runtime = runtimeForSession(sessionWithTabs(WINDOWS_FORWARD_SLASH_ID))

    const result = await runtime.listMobileSessionTabs(`id:${WINDOWS_BACKSLASH_ID}`)

    expect(result.tabs).toHaveLength(2)
  })

  it('returns the same tabs for both spellings of one worktree', async () => {
    const runtime = runtimeForSession(sessionWithTabs(WINDOWS_BACKSLASH_ID))

    const backslash = await runtime.listMobileSessionTabs(`id:${WINDOWS_BACKSLASH_ID}`)
    const forward = await runtime.listMobileSessionTabs(`id:${WINDOWS_FORWARD_SLASH_ID}`)

    expect(forward.tabs.map((tab) => tab.id)).toEqual(backslash.tabs.map((tab) => tab.id))
  })

  it('keeps a POSIX id containing a backslash spelling-sensitive', async () => {
    // On a Linux host `/a\b` is a legitimate filename: the backslash must NOT
    // fold to a separator, so a sibling `/a/b` id must not steal its tabs.
    const runtime = runtimeForSession(sessionWithTabs(POSIX_ID))

    const result = await runtime.listMobileSessionTabs('id:repo::/a/b')

    expect(result.tabs).toEqual([])
  })
})
