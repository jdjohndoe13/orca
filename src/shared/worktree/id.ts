import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from '../cross-platform-path'
import { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'
import type { Repo } from '../repo-types'

export { WORKTREE_ID_SEPARATOR } from '../pty-session-id-format'

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
  return `${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  return separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
}

/**
 * Canonical comparison form of a worktree id: the repoId is compared EXACT and only the path folds,
 * through the same `normalizeRuntimePathForComparison` a `path:` selector has always applied and
 * byte-exact id matching denied the renderer (#16243). Null for a malformed id, so callers keep
 * exact matching for it. Comparison only — never persist or return this key.
 */
export function worktreeIdComparisonKey(worktreeId: string): string | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed || !parsed.repoId || !parsed.worktreePath) {
    return null
  }
  return `${parsed.repoId}${WORKTREE_ID_SEPARATOR}${normalizeRuntimePathForComparison(
    parsed.worktreePath
  )}`
}

/**
 * Why: workspace identity is per *workspace*, not per checkout dir. Folder projects back several
 * independent workspaces with one directory, separated only by the `::workspace:<uuid>` suffix that
 * filesystem callers must strip; stripping it here instead lets one session steal a sibling's PTYs.
 * Normalize only path spelling, so Windows/WSL/SSH ids still match themselves across hosts, and
 * fall back to exact equality for a malformed id.
 */
export function worktreeIdsEqual(left: string, right: string): boolean {
  const leftKey = worktreeIdComparisonKey(left)
  return leftKey === null ? left === right : leftKey === worktreeIdComparisonKey(right)
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

export function splitWorktreeIdForFilesystem(worktreeId: string): ParsedWorktreeId | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return null
  }
  return {
    repoId: parsed.repoId,
    // Why: folder projects can have multiple workspace sessions backed by the
    // same directory. Their IDs carry a UUID suffix, but filesystem callers
    // still need the real folder path as cwd/root.
    worktreePath: parsed.worktreePath.replace(FOLDER_WORKSPACE_INSTANCE_SUFFIX, '')
  }
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
