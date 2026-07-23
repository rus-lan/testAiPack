/**
 * Type guard: `true` for plain objects (excludes `null` and arrays). Shared by
 * opencode event parsing, run-side outcome analysis, and judge response
 * extraction.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
