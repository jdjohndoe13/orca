/**
 * Store-side mirror of a directly paired environment's repo catalog.
 *
 * The desktop renderer pulls every paired environment's `repo.list` and
 * `worktree.detectedList` over the runtime call and merges it client-side, so
 * only readers fenced to this host's persistence store — a paired phone above
 * all — need the rows to exist here. The mirror engages right after a verified
 * pairing stores its environment row and retires with the environment.
 */

import * as z from 'zod'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { mainProcessState } from '../../startup/main-process-state'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

export type PairedEnvironmentRepoCatalogEngraftSummary = {
  reposAdded: number
  reposUpdated: number
  reposPruned: number
  worktreesMirrored: number
  worktreesPruned: number
}

export type PairedEnvironmentRepoCatalogRetireSummary = {
  reposRemoved: number
}

export const PAIRED_REPO_CATALOG_TIMEOUT_MS = 15_000

/**
 * The runtime surface the mirror touches: only the catalog invalidations. Narrow
 * so tests can hand in a stub without casting the composed runtime.
 */
export type PairedEnvironmentRepoCatalogMirrorRuntimeSurface = Pick<
  OrcaRuntimeService,
  'invalidateWorktreeCatalog' | 'notifyFolderWorkspaceChanged'
>

export type PairedEnvironmentRepoCatalogMirrorDeps = {
  getStore: () => Store
  /** Test seam; production resolves the composed runtime from startup state. */
  getRuntime?: () => PairedEnvironmentRepoCatalogMirrorRuntimeSurface | null
}

let mirrorDeps: PairedEnvironmentRepoCatalogMirrorDeps | null = null

/** Composition root installs this with the live persistence store. */
export function configurePairedEnvironmentRepoCatalogMirror(
  dependencies: PairedEnvironmentRepoCatalogMirrorDeps
): void {
  mirrorDeps = dependencies
}

/** Engraft and retire live outside this module and read the deps through this seam. */
export function getPairedEnvironmentRepoCatalogMirrorDeps(): PairedEnvironmentRepoCatalogMirrorDeps | null {
  return mirrorDeps
}

/**
 * The base fields every `repo.list` row carries. `looseObject` keeps the rest of
 * the source row verbatim (badges, remote identities, SSH nesting) — the reply is
 * produced by the same persistence pipeline the source host persists with, so
 * extra keys are exactly that host's repo fields.
 */
const PairedRepoCatalogRowSchema = lazyZodSchema(() =>
  z.looseObject({
    id: z.string().min(1),
    path: z.string().min(1),
    displayName: z.string(),
    badgeColor: z.string(),
    addedAt: z.number(),
    kind: z.enum(['git', 'folder']).optional()
  })
)

export const PairedRepoCatalogListSchema = lazyZodSchema(() =>
  z.object({ repos: z.array(PairedRepoCatalogRowSchema) })
)

/** Only the fields the mirror consumes; like `repo.list`, unknown keys stay tolerated. */
const PairedWorktreeCatalogRowSchema = lazyZodSchema(() =>
  z.looseObject({
    path: z.string().min(1),
    displayName: z.string().optional(),
    ownership: z.string().optional()
  })
)

export const PairedWorktreeCatalogListSchema = lazyZodSchema(() =>
  z.object({
    authoritative: z.boolean(),
    worktrees: z.array(PairedWorktreeCatalogRowSchema)
  })
)

export type EngraftRow = z.infer<typeof PairedRepoCatalogRowSchema>

function resolveRuntime(
  deps: PairedEnvironmentRepoCatalogMirrorDeps
): PairedEnvironmentRepoCatalogMirrorRuntimeSurface | null {
  return deps.getRuntime?.() ?? mainProcessState.core.runtime
}

export function invalidateRuntimeCatalog(
  deps: PairedEnvironmentRepoCatalogMirrorDeps,
  touchedRepoIds: ReadonlySet<string>
): void {
  const runtime = resolveRuntime(deps)
  if (!runtime) {
    return
  }
  // Why: store writes bypass the runtime's own catalog caches — the same invalidation
  // trio the repository registration controller runs after a host adds a row.
  for (const repoId of touchedRepoIds) {
    runtime.invalidateWorktreeCatalog(repoId)
  }
  // `notifyReposChanged` is runtime-protected; this public composition already
  // emits the same reposChanged event plus the resolved-worktree invalidation.
  runtime.notifyFolderWorkspaceChanged()
}

export function warn(message: string, detail?: unknown): void {
  const detailText =
    detail instanceof Error ? detail.message : detail !== undefined ? String(detail) : undefined
  console.warn(`[repo-catalog-mirror] ${message}${detailText ? ` — ${detailText}` : ''}`)
}
