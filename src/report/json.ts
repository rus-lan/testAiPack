/**
 * Report: json — canonical serialisation of the full Report object.
 *
 * Validates the report against `reportSchema` before serialising so a bad
 * upstream payload surfaces here rather than as a corrupt file on disk.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import { Effect } from 'effect'
import type { Report } from '@generated/types'
import { reportSchema } from '@generated/schemas'
import { reportRenderError } from '../errors.js'
import type { PhaseError } from '../errors.js'

export const renderJson = (report: Report): Effect.Effect<string, PhaseError> =>
  Effect.gen(function* () {
    const result = reportSchema.safeParse(report)
    if (!result.success) {
      return yield* Effect.fail(
        reportRenderError(
          `report failed schema validation: ${JSON.stringify(result.error.issues)}`,
          'E_EXPORT_INVALID',
          { issues: result.error.issues },
        ),
      )
    }
    return `${JSON.stringify(report, null, 2)}\n`
  })
