import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { isWorkspaceSessionRecord } from '../../../../shared/workspace-session/workspace-session-host-records'
import {
  contestedIdsOwnedBy,
  HOST_ROW_REKEY_TO_BARE,
  HOST_ROW_REKEY_TO_HOST_CLAIM,
  HOST_ROW_REKEY_TO_HOST_FRESH,
  rekeyRecordForHostDirection
} from '../../../../shared/workspace-session-host-row-rekey'
import type { ContestedWorkspaceIds } from '../../../../shared/workspace-session-worktree-key'
import type { WebSessionTabsSyncState } from './state'

/**
 * The contested-id (STA-4343) spelling of the `web-session-tabs-sync` mirror.
 *
 * The host publishes its frames with the bare worktree id, so the pipeline reconciles in the bare
 * spelling — but the unified store must only ever hold the `host|id` spelling for a contested id:
 * the persistence split routes a bare key to the catalog's pinned primary (the lowest runtime id)
 * and strips the prefix, so the bare row collides last-wins with the primary's own row and
 * DB-pollutes that partition with whichever host's frame wrote the bare key last.
 *
 * The mirror therefore folds the host's live rows onto the bare key before the pipeline runs
 * (the read sees the host's own rows, not the co-claimant's), and re-spells the patch's record
 * keys back to `host|id` on the way out. The built tabs' `worktreeId` FIELDS stay bare — the
 * host's own id — only the record keys are qualified. An id the gate has not flagged is its own
 * key in both directions, so every install without a collision runs byte-identically to before.
 */

/**
 * The worktree-keyed records the pipeline writes (`withWorktreeEntry` call sites in
 * `apply-worktree-records.ts` and `apply-active-state.ts`) — the same list the reader resolves
 * by session key and the contest-rekey pass walks.
 */
const MIRROR_REKEYED_RECORD_FIELDS = [
  'tabsByWorktree',
  'browserTabsByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'tabBarOrderByWorktree',
  'activeTabIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeGroupIdByWorktree',
  'activeTabTypeByWorktree'
] as const satisfies readonly (keyof WebSessionTabsSyncState)[]

type MirrorRekeyedField = (typeof MIRROR_REKEYED_RECORD_FIELDS)[number]

/**
 * The pipeline's read view: this host's qualified rows fold onto the bare key the host
 * publishes, so the merge sees the host's live rows and retains a tab the user opened there.
 * The co-claimant's rows and the empty-prefix bucket never move. Reference-identical when the
 * store holds nothing of this host's to fold.
 */
export function foldWebSessionTabsRowsToBareView(
  state: WebSessionTabsSyncState,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): WebSessionTabsSyncState {
  const owned = contestedIdsOwnedBy(worktreeIds, contested)
  if (owned.size === 0) {
    return state
  }
  let next: Record<string, unknown> | undefined
  for (const field of MIRROR_REKEYED_RECORD_FIELDS) {
    const record = state[field]
    if (!isWorkspaceSessionRecord(record)) {
      continue
    }
    const folded = rekeyRecordForHostDirection<unknown>(
      record,
      owned,
      hostId,
      HOST_ROW_REKEY_TO_BARE
    )
    if (folded !== record) {
      next ??= { ...state }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the record list above, which classifies it as a worktree-keyed record, and the value is that field's own content with its keys re-spelled.
      next[field] = folded
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `next` is a shallow copy of the same state with record fields replaced by same-shaped re-keyed records.
  return (next as WebSessionTabsSyncState) ?? state
}

/**
 * The patch with this host's rows re-spelled to the `host|id` key the reader resolves.
 *
 * A field the pipeline changed carries its own bare write — the fresh merge — which wins the
 * host's bucket. A field the pipeline did NOT change but the REAL pre-state holds a bare row
 * for (the polluted boot shape, or the pre-contest row the contest flip could not name) must
 * still be included: the fold keeps the host's live row and drops the bare key, so the next
 * persistence split can never collide it into the primary's partition. The patch only gains a
 * key when the pre-state genuinely holds a bare row — otherwise the no-op stays `patch ===
 * state` and the identity fast-path is untouched.
 */
export function rekeyWebSessionTabsPatchToHost(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  worktreeIds: ReadonlySet<string>,
  hostId: ExecutionHostId,
  contested: ContestedWorkspaceIds
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const owned = contestedIdsOwnedBy(worktreeIds, contested)
  if (owned.size === 0) {
    return patch
  }
  const isNoOp = patch === state
  let next: Record<string, unknown> | undefined
  const assign = (field: MirrorRekeyedField, value: unknown): void => {
    next ??= { ...patch }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field name comes from the record list above, which classifies it as a worktree-keyed record, and the value is that field's own content with its keys re-spelled.
    ;(next as Record<string, unknown>)[field] = value
  }
  for (const field of MIRROR_REKEYED_RECORD_FIELDS) {
    if (!isNoOp && Object.hasOwn(patch, field)) {
      const record = patch[field]
      if (isWorkspaceSessionRecord(record)) {
        const rekeyed = rekeyRecordForHostDirection<unknown>(
          record,
          owned,
          hostId,
          HOST_ROW_REKEY_TO_HOST_FRESH
        )
        if (rekeyed !== record) {
          assign(field, rekeyed)
        }
      }
      continue
    }
    const preRecord = state[field]
    const holdsBareRow =
      isWorkspaceSessionRecord(preRecord) &&
      [...owned].some((worktreeId) => Object.hasOwn(preRecord, worktreeId))
    if (holdsBareRow) {
      assign(
        field,
        rekeyRecordForHostDirection<unknown>(preRecord, owned, hostId, HOST_ROW_REKEY_TO_HOST_CLAIM)
      )
    }
  }
  return next ?? patch
}
