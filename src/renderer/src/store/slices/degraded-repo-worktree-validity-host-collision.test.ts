import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/repository/appearance/repo-badge-color'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../../../../shared/worktree/catalog/degraded-repo-worktree-validity'
import { buildWorkspaceTerminalRowPlan } from '../terminals/hydration/workspace-terminal-row-plan'
import { makeWorktree } from './worktrees/worktree.test-fixture'
import { makeTab as makeTerminalTab } from '../terminals/testing/terminal-tab.test-fixture'

// Why (STA-4343): four paired machines each holding `C:\vmd` publish the SAME worktree id, so the
// unified session gives each claimant its own `host|id` row. Hydration validates every session key
// against the catalog, and a catalog that only spells workspaces bare throws every contested row
// away — the sidebar then shows one host's tabs in all four cards. These tests pin the qualified
// spelling as valid so the row survives.

const REPO_ID = 'repo-1'
const CONTESTED_ID = `${REPO_ID}::C:\\vmd`
const UNCONTESTED_ID = `${REPO_ID}::C:\\other`

const repo: Repo = {
  id: REPO_ID,
  path: 'C:/vmd',
  displayName: 'vmd',
  badgeColor: DEFAULT_REPO_BADGE_COLOR,
  addedAt: 0,
  connectionId: null,
  executionHostId: 'local'
}

/** The same `repo-1::C:\vmd` claimed by two execution hosts — the collision the bug needs. */
const contestedRows = [
  makeWorktree({ id: CONTESTED_ID, repoId: REPO_ID, hostId: 'local', path: 'C:\\vmd' }),
  makeWorktree({
    id: CONTESTED_ID,
    repoId: REPO_ID,
    hostId: 'ssh:paired-box',
    path: 'C:\\vmd'
  })
]

const catalog = {
  repos: [repo],
  worktreesByRepo: {
    [REPO_ID]: [
      ...contestedRows,
      makeWorktree({ id: UNCONTESTED_ID, repoId: REPO_ID, hostId: 'local', path: 'C:\\other' })
    ]
  }
}

/** Tab ids cannot contain `:` or `|` (see `isValidTerminalTabId`), so they are named separately. */
function sessionWithEntries(
  entries: readonly (readonly [string, string])[]
): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  session.tabsByWorktree = Object.fromEntries(
    entries.map(([key, tabId]) => [key, [makeTerminalTab({ id: tabId, worktreeId: key })]])
  )
  return session
}

describe('host-qualified session keys in the hydration validity set', () => {
  it('accepts a contested row keyed by its own host', () => {
    const valid = buildValidWorktreeIdsForSessionHydration(catalog, [
      `local|${CONTESTED_ID}`,
      `ssh:paired-box|${CONTESTED_ID}`
    ])

    // The whole fix: without the qualified spelling in the set, the row-hydration filter below
    // drops the row and the card goes blank.
    expect(valid.has(`local|${CONTESTED_ID}`)).toBe(true)
    expect(valid.has(`ssh:paired-box|${CONTESTED_ID}`)).toBe(true)
  })

  it('keeps the bare id valid for every workspace, contested or not', () => {
    const valid = buildValidWorktreeIdsForSessionHydration(catalog, [])

    expect(valid.has(CONTESTED_ID)).toBe(true)
    expect(valid.has(UNCONTESTED_ID)).toBe(true)
  })

  it('does not accept a host that publishes no such row', () => {
    const valid = buildValidWorktreeIdsForSessionHydration(catalog, [
      `ssh:stranger|${CONTESTED_ID}`
    ])

    // A made-up host must not be admitted: it would resurrect a row for a host that never wrote
    // one, which is the same class of cross-host confusion the bug is about.
    expect(valid.has(`ssh:stranger|${CONTESTED_ID}`)).toBe(false)
  })

  it('hydrates one row per claimant of a contested id instead of dropping both', () => {
    const localKey = `local|${CONTESTED_ID}`
    const sshKey = `ssh:paired-box|${CONTESTED_ID}`
    const session = sessionWithEntries([
      [localKey, 'tab-local'],
      [sshKey, 'tab-ssh'],
      [UNCONTESTED_ID, 'tab-other']
    ])

    const valid = buildValidWorktreeIdsForSessionHydration(
      catalog,
      collectPersistedWorktreeIdsForSessionHydration(session)
    )
    const plan = buildWorkspaceTerminalRowPlan(session, valid)

    // Before the fix both contested rows vanished here and only the uncontested row survived.
    expect(Object.keys(plan.tabsByWorktree).sort()).toEqual(
      [localKey, sshKey, UNCONTESTED_ID].sort()
    )
    expect(plan.tabsByWorktree[localKey]?.map((tab) => tab.id)).toEqual(['tab-local'])
    expect(plan.tabsByWorktree[sshKey]?.map((tab) => tab.id)).toEqual(['tab-ssh'])
  })

  it('still drops a contested row for a host that has since left the catalog', () => {
    const session = sessionWithEntries([[`ssh:retired-box|${CONTESTED_ID}`, 'tab-retired']])

    const valid = buildValidWorktreeIdsForSessionHydration(
      catalog,
      collectPersistedWorktreeIdsForSessionHydration(session)
    )
    const plan = buildWorkspaceTerminalRowPlan(session, valid)

    // Deletion must keep working: a host that no longer publishes the id loses its row, exactly as
    // a bare id whose worktree is gone.
    expect(plan.tabsByWorktree).toEqual({})
  })
})
