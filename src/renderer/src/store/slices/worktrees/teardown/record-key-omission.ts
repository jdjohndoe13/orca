import { recordDraft } from '../../../record-transitions/keyed-record-transitions'
import { getWorkspaceIdFromSessionKey } from '../../../../../../shared/workspace-session-worktree-key'

/**
 * Key removal that keeps a record's identity when it had none of the keys.
 *
 * Why identity matters here: teardown rewrites dozens of store maps at once, and
 * a removed worktree has an entry in only a few of them. Copying the rest anyway
 * gives every one a new reference, which rerenders every component selecting it
 * for no data change.
 *
 * Why nullish input yields `{}`: some worktree-isolation callers hand over states
 * with a slice omitted, and the spread-then-delete this replaces normalized those
 * to an empty record. Production always initialises them, so the fresh object here
 * costs nothing at runtime.
 */
export function omitRecordKeys<T>(
  record: Record<string, T> | undefined,
  keys: Iterable<string>
): Record<string, T> {
  if (!record) {
    return {}
  }
  const draft = recordDraft(record)
  for (const key of keys) {
    draft.delete(key)
  }
  return draft.finish()
}

/**
 * Like `omitRecordKeys`, but for a worktree-keyed record: a key is dropped when the
 * workspace it names is in `worktreeIds`, whatever spelling it uses.
 *
 * Why the decode: a contested id's rows live under `host|id` (STA-4343), so a bare-only
 * omit leaves them as orphans — and the contest-rekey pass re-spells a surviving
 * qualified row back to the bare key when the contest clears, resurrecting the removed
 * workspace's tabs. A key that is not a session key for one of these ids (a pane key, a
 * `host|id`-prefixed path) decodes to something else and is kept.
 */
export function omitRecordKeysByWorktreeId<T>(
  record: Record<string, T> | undefined,
  worktreeIds: ReadonlySet<string>
): Record<string, T> {
  if (!record) {
    return {}
  }
  let next: Record<string, T> | null = null
  for (const key of Object.keys(record)) {
    if (!worktreeIds.has(getWorkspaceIdFromSessionKey(key))) {
      continue
    }
    next ??= { ...record }
    delete next[key]
  }
  return next ?? record
}

/**
 * Every entry a worktree-keyed record holds for one id, across both spellings — the read
 * counterpart of `omitRecordKeysByWorktreeId`. A tab/PTY/layout sweep needs the contested
 * row too, or the doomed tab's PTY is never collected and its scrollback leaks.
 */
export function readRecordEntriesByWorktreeId<T>(
  record: Readonly<Record<string, T>> | undefined,
  worktreeId: string
): T[] {
  if (!record) {
    return []
  }
  const entries: T[] = []
  for (const [key, entry] of Object.entries(record)) {
    if (getWorkspaceIdFromSessionKey(key) === worktreeId) {
      entries.push(entry)
    }
  }
  return entries
}
