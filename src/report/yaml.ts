/**
 * Report: yaml — same canonical Report object serialised as YAML.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import { stringify } from 'yaml'
import type { Report } from '@generated/types'
import { reportSchema } from '@generated/schemas'

export const renderYaml = (report: Report): string => {
  const result = reportSchema.safeParse(report)
  if (!result.success) {
    throw new Error(
      `renderYaml: report failed schema validation: ${JSON.stringify(result.error.issues)}`,
    )
  }
  return stringify(report)
}
