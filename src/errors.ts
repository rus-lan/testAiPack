import { Data } from 'effect'
import type { ErrorCode, PhaseError as PhaseErrorWire } from '@generated'

export type { ErrorCode }
export type { PhaseErrorWire }

export type PhaseName =
  | 'cli-parse'
  | 'workspace-setup'
  | 'repo-clone'
  | 'pack-install'
  | 'home-isolation'
  | 'preflight'
  | 'run-side'
  | 'aggregate'
  | 'diff'
  | 'judge'
  | 'timeline'
  | 'report-render'
  | 'review-workspace'
  | 'cleanup'

export interface PhaseErrorData {
  readonly code: ErrorCode
  readonly phase: PhaseName
  readonly message: string
  readonly cause?: unknown
  readonly context?: Record<string, unknown>
  readonly timestamp: Date
}

export class PhaseError extends Data.TaggedError('PhaseError')<PhaseErrorData> {}

export interface SerializedPhaseError {
  readonly _tag: 'PhaseError'
  readonly code: ErrorCode
  readonly phase: PhaseName
  readonly message: string
  readonly cause?: unknown
  readonly context?: Record<string, unknown>
  readonly timestamp: string
}

export const serializePhaseError = (e: PhaseError): SerializedPhaseError => ({
  _tag: 'PhaseError',
  code: e.code,
  phase: e.phase,
  message: e.message,
  ...(e.cause === undefined ? {} : { cause: e.cause }),
  ...(e.context === undefined ? {} : { context: e.context }),
  timestamp: e.timestamp.toISOString(),
})

const make =
  (phase: PhaseName) =>
  (
    message: string,
    code: ErrorCode,
    context?: Record<string, unknown>,
  ): PhaseError =>
    new PhaseError({
      code,
      phase,
      message,
      timestamp: new Date(),
      ...(context === undefined ? {} : { context }),
    })

export const cliParseError = make('cli-parse')
export const workspaceSetupError = make('workspace-setup')
export const repoCloneError = make('repo-clone')
export const packInstallError = make('pack-install')
export const homeIsolationError = make('home-isolation')
export const preflightError = make('preflight')
export const runSideError = make('run-side')
export const aggregateError = make('aggregate')
export const diffError = make('diff')
export const judgeError = make('judge')
export const timelineError = make('timeline')
export const reportRenderError = make('report-render')
export const reviewWorkspaceError = make('review-workspace')
export const cleanupError = make('cleanup')

export const PHASE_NAMES: readonly PhaseName[] = [
  'cli-parse',
  'workspace-setup',
  'repo-clone',
  'pack-install',
  'home-isolation',
  'preflight',
  'run-side',
  'aggregate',
  'diff',
  'judge',
  'timeline',
  'report-render',
  'review-workspace',
  'cleanup',
]
