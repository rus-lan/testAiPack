/**
 * Type guards for ExportPart. The union carries a tolerant catch-all: a part
 * that fails its typed schema still validates as `{type, id}`, so `type`
 * alone can lie about the rest of the shape. isReasoning/isTool/isText also
 * check the field their callers read, so a part that fell through to the
 * catch-all is excluded rather than crashing downstream. isStepFinish only
 * feeds optional reads, so a type-tag check is enough.
 */
import type {
  ExportPart,
  ExportReasoningPart,
  ExportStepFinishPart,
  ExportTextPart,
  ExportToolPart,
} from '@generated/types'
import { isRecord } from '../util/types.js'

export const isText = (p: ExportPart): p is ExportTextPart =>
  p.type === 'text' && typeof (p as { readonly text?: unknown }).text === 'string'

export const isReasoning = (p: ExportPart): p is ExportReasoningPart => {
  if (p.type !== 'reasoning') return false
  const time = (p as { readonly time?: unknown }).time
  const start = isRecord(time) ? time['start'] : undefined
  return typeof start === 'number' && Number.isFinite(start)
}

export const isTool = (p: ExportPart): p is ExportToolPart =>
  p.type === 'tool' && isRecord((p as { readonly state?: unknown }).state)

export const isStepFinish = (p: ExportPart): p is ExportStepFinishPart => p.type === 'step-finish'
