import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../file-access/cross-platform-path'
import { WORKTREE_ID_SEPARATOR } from '../terminal/pty/lifecycle/pty-session-id-format'
import type { Repo } from '../repository/repo-types'

export { WORKTREE_ID_SEPARATOR } from '../terminal/pty/lifecycle/pty-session-id-format'

export type ParsedWorktreeId = {
  repoId: string
  worktreePath: string
}

export const FOLDER_WORKSPACE_INSTANCE_SEPARATOR = '::workspace:'
const FOLDER_WORKSPACE_INSTANCE_SUFFIX = new RegExp(
  `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f-]{36}$`
)

/**
 * The ONE canonical spelling of a `repoId::path` worktree id.
 *
 * The same Windows checkout reaches the client through two spellings — the host's git scan emits
 * `C:/vmd`, while an id built from a persisted `repo.path` yields `C:\vmd` — and the id is a
 * byte-exact map key everywhere (contested-id gate, session buckets, host-qualified keys). Two
 * spellings therefore never dedupe to one workspace, so the id never becomes contested, every
 * session key stays bare, and the two spellings split one workspace's rows across two buckets.
 *
 * Canonicalization is SEPARATORS only, gated on the path proving Windows drive/UNC syntax, and
 * case is preserved: backslash is a valid POSIX filename character, so a POSIX path like
 * `/a\b` must keep its own identity. This is the exact fold `normalizeRuntimePathSeparators`
 * already applies to the host's own scan output, so the canonical spelling IS the host's spelling.
 * Case is deliberately NOT folded — `normalizeRuntimePathForComparison` is a comparison key, and
 * lowercasing a persisted path would corrupt a real path on a case-sensitive host.
 *
 * Additive on the wire: an old host that byte-compares ids (before the `id:` comparison fallback
 * of #16494) still matches, because the canonical form is the forward-slash form it already
 * publishes for git-scanned workspaces.
 */
export function normalizeWorktreePathForId(worktreePath: string): string {
  return isWindowsAbsolutePathLike(worktreePath)
    ? normalizeRuntimePathSeparators(worktreePath)
    : worktreePath
}

/**
 * The other separator spelling of a Windows path in a worktree id, or the id unchanged when
 * nothing folds. `repo::C:\vmd` ↔ `repo::C:/vmd`; a POSIX path never has a second spelling
 * (a backslash there is a filename character). The two spellings are the same workspace by
 * definition, so a reader may consult the second spelling as a fallback without ever landing
 * on another workspace's row.
 */
export function swapWorktreeIdPathSpelling(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !isWindowsAbsolutePathLike(parsed.worktreePath)) {
    return worktreeId
  }
  const swapped = parsed.worktreePath.includes('\\')
    ? normalizeRuntimePathSeparators(parsed.worktreePath)
    : parsed.worktreePath.replace(/\//g, '\\')
  return swapped === parsed.worktreePath
    ? worktreeId
    : `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${swapped}`
}

/**
 * The id of a row as it is stored, with the path segment re-spelled canonically. A row whose id
 * already matches is returned unchanged, so callers can map without churning references.
 */
export function canonicalizeWorktreeId(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return worktreeId
  }
  const canonicalPath = normalizeWorktreePathForId(parsed.worktreePath)
  return canonicalPath === parsed.worktreePath
    ? worktreeId
    : `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${canonicalPath}`
}

/**
 * Worktree id of the repo's own checkout. A bare repo id is never a valid worktree id —
 * runtimes reject it with `worktree_id_requires_full_path` (#16447).
 *
 * Why NOT canonicalized: the host compares this id byte-exactly against its own persisted
 * `worktreeMeta` (the folder-locator's OMP identity survives on the raw id, and the
 * session-search scope resolves against the host's own registration), so the id built from
 * `repo.path` stays byte-faithful. The two Windows separator spellings converge at the
 * session-key layer (`workspaceSessionKeyCandidates`) and the load-time reconciliation.
 */
export function getRepoMainWorktreeId(repo: Pick<Repo, 'id' | 'path'>): string {
  return composeWorktreeId(repo.id, repo.path)
}

/** Worktree id for a checkout, spelled exactly as given: ids are never reassigned by a fold. */
export function composeWorktreeId(repoId: string, worktreePath: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${worktreePath}`
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

/** Comparison only; never persist/return the key. Keep repo IDs exact, fold only path spelling as path: selectors do, and leave malformed IDs unchanged (#16243). */
export function worktreeIdentityKey(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return worktreeId
  }
  return `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${normalizeRuntimePathForComparison(
    parsed.worktreePath
  )}`
}

/** Preserve folder-workspace instance suffixes: several sessions share one directory and must not steal sibling PTYs. Normalize path spelling only. */
export function worktreeIdsEqual(left: string, right: string): boolean {
  return worktreeIdentityKey(left) === worktreeIdentityKey(right)
}

export function splitWorktreeId(worktreeId: string): ParsedWorktreeId | null {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return null
  }
  return {
    repoId: worktreeId.slice(0, separatorIdx),
    worktreePath: worktreeId.slice(separatorIdx + WORKTREE_ID_SEPARATOR.length)
  }
}

/** `worktreeId` with its path mapped; the repo id and a folder workspace's instance suffix stay. */
export function rewriteWorktreeIdPath(
  worktreeId: string,
  mapPath: (path: string) => string
): string {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return worktreeId
  }
  const suffixAt = parsed.worktreePath.lastIndexOf(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
  const instanceId = parsed.worktreePath.slice(
    suffixAt + FOLDER_WORKSPACE_INSTANCE_SEPARATOR.length
  )
  const suffix =
    suffixAt > 0 && /^[0-9a-f-]{36}$/.test(instanceId) ? parsed.worktreePath.slice(suffixAt) : ''
  const path = parsed.worktreePath.slice(0, parsed.worktreePath.length - suffix.length)
  const mapped = mapPath(path)
  return mapped === path ? worktreeId : `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${mapped}${suffix}`
}

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return null
  }
  return {
    repoId: parsed.repoId,
    // Filesystem callers need the folder path without its workspace-session UUID suffix.
    worktreePath: parsed.worktreePath.replace(FOLDER_WORKSPACE_INSTANCE_SUFFIX, '')
  }
}

/** Folder-project workspaces on one directory differ only by instance suffix; they share the repo and cwd. */
export function worktreeIdsShareCheckout(left: string, right: string): boolean {
  return worktreeIdsEqual(checkoutWorktreeId(left), checkoutWorktreeId(right))
}

function checkoutWorktreeId(worktreeId: string): string {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  return parsed ? composeWorktreeId(parsed.repoId, parsed.worktreePath) : worktreeId
}

export function getWorktreePathBasenameFromId(worktreeId: string): string | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const normalizedPath = parsed?.worktreePath.trim().replace(/[\\/]+$/g, '') ?? ''
  if (!normalizedPath) {
    return null
  }
  const basename = normalizedPath.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || null
}
