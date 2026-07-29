/**
 * Report: yaml — same canonical Report object serialised as YAML.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import { Effect } from 'effect'
import { stringify } from 'yaml'
import type { Report } from '@generated/types'
import { reportSchema } from '@generated/schemas'
import { reportRenderError } from '../errors.js'
import type { PhaseError } from '../errors.js'

export const renderYaml = (report: Report): Effect.Effect<string, PhaseError> =>
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
    return stringify(report)
  })
