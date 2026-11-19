import { describe, expect, it } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { readWorktreeSessionRow } from '@/components/terminal-workspace-session-row'

// Acceptance test for the unfinished half of the STA-4343 fix.
//
// The READ side resolves a contested id to `host|id` (see `terminal-workspace-session-row.ts`),
// but the store's WRITE actions still key the record by the bare id they were handed. So a tab
// created on a colliding host lands in a bucket no reader reads, and closing one misses.
// `pnpm tc` and the read-side suites pass with this skipped; it is the gate for the write side.

const REPO_ID = 'repo1'
const CONTESTED = `${REPO_ID}::C:\\vmd`
const SSH = 'ssh:paired-box'
const LOCAL = 'local'
// The session key is the id byte-for-byte — the host compares the key against the row id it
// published, so the id part never re-spells. (The contested GATE folds the separator spelling
// so the two spellings of one checkout count as one contested id.)
const sshKey = `${SSH}|${CONTESTED}`

describe('contested id write side', () => {
  it('createTab writes the row the read path reads', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        [REPO_ID]: [
          makeWorktree({ id: CONTESTED, repoId: REPO_ID, hostId: LOCAL, path: 'C:\\vmd' }),
          makeWorktree({ id: CONTESTED, repoId: REPO_ID, hostId: SSH, path: 'C:\\vmd' })
        ]
      },
      activeWorktreeId: CONTESTED,
      activeWorkspaceExecutionHostId: SSH
    })

    const tab = store.getState().createTab(CONTESTED)
    const after = store.getState()

    // The row the workbench reads must be the row the action wrote.
    expect(readWorktreeSessionRow(after, after.tabsByWorktree, CONTESTED, SSH)).toHaveLength(1)
    expect(after.tabsByWorktree[sshKey]?.map((t) => t.id)).toEqual([tab.id])
    // And no bare bucket may be created, or the next hydration resurrects the shared row.
    expect(after.tabsByWorktree[CONTESTED]).toBeUndefined()
  })
})
