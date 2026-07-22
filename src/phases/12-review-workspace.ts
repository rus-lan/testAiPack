/**
 * Phase 12: review-workspace
 *
 * Generates a VSCode multi-root `review.code-workspace` so the user can open
 * OLD, NEW and PACK side by side. Soft phase: never fails — file-write errors
 * are logged as warnings and the phase still returns a result.
 *
 * @see docs/phases/12-review-workspace.ru.md
 * @see contract/phases/12-review-workspace.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  Manifest,
  ReviewWorkspaceInput,
  ReviewWorkspaceResult,
  WorkspaceTree,
} from '@generated/types'
import type { PhaseError } from '../errors.js'
import { ensureDir, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'

export interface WorkspaceFolder {
  readonly path: string
  readonly name: string
}

export interface ReviewWorkspaceFile {
  readonly folders: readonly WorkspaceFolder[]
  readonly settings: {
    readonly 'workbench.colorCustomizations': Record<string, never>
  }
}

export const mapIdeToBinary = (ide: string): string => {
  if (ide === 'cursor') return 'cursor'
  if (ide === 'code-insiders') return 'code-insiders'
  return 'code'
}

const fallbackRunDir = (workspace: WorkspaceTree, side: 'old' | 'new', reviewRun: number): string =>
  path.join(workspace.root, 'apps', `${side}Version`, `run-${String(reviewRun)}`)

/**
 * Pure builder for the workspace JSON. Paths are relative to `locationDir`
 * (the directory that will hold `review.code-workspace`, normally `results/`).
 */
export const buildWorkspaceJson = (
  reviewRun: number,
  workspace: WorkspaceTree,
  locationDir: string,
): ReviewWorkspaceFile => {
  const oldAbs = workspace.appsOld[reviewRun - 1] ?? fallbackRunDir(workspace, 'old', reviewRun)
  const newAbs = workspace.appsNew[reviewRun - 1] ?? fallbackRunDir(workspace, 'new', reviewRun)
  const rel = (abs: string): string => path.relative(locationDir, abs)
  return {
    folders: [
      { path: rel(oldAbs), name: `OLD (baseline) run-${String(reviewRun)}` },
      { path: rel(newAbs), name: `NEW (with pack) run-${String(reviewRun)}` },
      { path: rel(workspace.pack), name: 'PACK source (read-only)' },
    ],
    settings: { 'workbench.colorCustomizations': {} },
  }
}

const resolveReviewRun = (manifest: Manifest): number => {
  const raw = manifest.flagDefaults.reviewRun
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 && raw <= manifest.runs ? raw : 1
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10)
    return Number.isInteger(n) && n >= 1 && n <= manifest.runs ? n : 1
  }
  return 1
}

const resolveIde = (manifest: Manifest): string => {
  const raw = manifest.flagDefaults.ide
  return typeof raw === 'string' && raw !== '' ? raw : 'vscode'
}

const soft =
  (label: string) =>
  (e: FsError): Effect.Effect<void> =>
    Effect.sync(() => {
      console.warn(`review-workspace: ${label} failed: ${e.operation} on ${e.path}: ${String(e.cause)}`)
    })

export const reviewWorkspace = (
  input: ReviewWorkspaceInput,
): Effect.Effect<ReviewWorkspaceResult, PhaseError> =>
  Effect.gen(function* () {
    const { manifest, workspace } = input
    const reviewRun = resolveReviewRun(manifest)
    const ide = resolveIde(manifest)
    const locationDir = workspace.results
    const file = buildWorkspaceJson(reviewRun, workspace, locationDir)
    const workspacePath = path.join(locationDir, 'review.code-workspace')

    yield* ensureDir(locationDir).pipe(Effect.catchAll(soft('ensureDir')))
    yield* writeFile(workspacePath, `${JSON.stringify(file, null, 2)}\n`).pipe(
      Effect.catchAll(soft('writeFile')),
    )

    const command = `${mapIdeToBinary(ide)} ${workspacePath}`
    return { workspacePath, opened: false, command }
  })
