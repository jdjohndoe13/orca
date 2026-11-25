import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { ContestedWorkspaceIds } from '../../../../../shared/workspace-session-worktree-key'
import { qualifyHostWorkspaceSessionSlices } from '../../../../../shared/workspace-session-key-qualification'
import {
  GLOBAL_WORKSPACE_SESSION_FIELDS,
  WORKSPACE_SESSION_FIELD_OWNERSHIP
} from '../../../../../shared/workspace-session/workspace-session-host-field-ownership'
import {
  mergeWorkspaceSessionArrayField,
  mergeWorkspaceSessionRecordField,
  type WorkspaceSessionRecord
} from '../../../../../shared/workspace-session/workspace-session-host-records'
import type { HostSessionSlices } from './workspace-session-host-split'

/** Inverse of split: combine per-host slices into one unified session. Global
 *  fields are taken from the 'local' slice (it owns them); worktree/tab-scoped
 *  maps are unioned across all hosts. Tolerates missing or partial slices.
 *
 *  `contested` re-qualifies each partition's worktree-keyed keys with that partition's own host, so
 *  a store written before host-qualified keys migrates in memory on the first read and every
 *  claimant of a colliding id keeps its own row instead of losing it to the shared bucket. Omitted
 *  (or an empty set) leaves the merge exactly as it was: one row per bare id, byte-identical to the
 *  pre-fix shape for every install without a collision. */
export function mergeWorkspaceSessionsFromHosts(
  slices: HostSessionSlices,
  contested?: ContestedWorkspaceIds
): WorkspaceSessionState {
  const out = {} as WorkspaceSessionState
  const hostSlices = contested ? qualifyHostWorkspaceSessionSlices(slices, contested) : slices
  const local = hostSlices[LOCAL_EXECUTION_HOST_ID]

  // Global fields: 'local' wins. Fall back to any slice that has them so a
  // standalone non-local slice still yields sane active pointers.
  for (const field of GLOBAL_WORKSPACE_SESSION_FIELDS) {
    const fromLocal = local?.[field]
    if (fromLocal !== undefined) {
      ;(out as WorkspaceSessionRecord)[field] = fromLocal
      continue
    }
    for (const slice of Object.values(slices)) {
      if (slice && slice[field] !== undefined) {
        ;(out as WorkspaceSessionRecord)[field] = slice[field]
        break
      }
    }
  }

  for (const slice of Object.values(hostSlices)) {
    if (!slice) {
      continue
    }
    for (const field of Object.keys(
      WORKSPACE_SESSION_FIELD_OWNERSHIP
    ) as (keyof WorkspaceSessionState)[]) {
      const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
      if (ownership === 'global' || ownership === 'hostPrivate') {
        continue
      }
      if (ownership === 'worktreeArray') {
        mergeWorkspaceSessionArrayField(out as WorkspaceSessionRecord, field, slice)
      } else {
        mergeWorkspaceSessionRecordField(out as WorkspaceSessionRecord, field, slice)
      }
    }
  }

  return out
}
