/**
 * Report: json — canonical serialisation of the full Report object.
 *
 * Validates the report against `reportSchema` before serialising so a bad
 * upstream payload surfaces here rather than as a corrupt file on disk.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { Report } from '@generated/types'
import { reportSchema } from '@generated/schemas'

export const renderJson = (report: Report): string => {
  const result = reportSchema.safeParse(report)
  if (!result.success) {
    throw new Error(
      `renderJson: report failed schema validation: ${JSON.stringify(result.error.issues)}`,
    )
  }
  return `${JSON.stringify(report, null, 2)}\n`
}
