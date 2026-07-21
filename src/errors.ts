/**
 * Errors: sum type of every PhaseError variant (one per ErrorCode value).
 *
 * Source of truth for the wire shape: the generated `PhaseError` / `ErrorCode`
 * types in src/generated (compiled from contract/main.tsp). Stage 2.2 will lift
 * these into Effect-tagged errors (Data.TaggedError) so each phase can fail
 * through Effect's typed channel.
 *
 * @see src/generated/types.ts
 * @see docs/phases/README.ru.md
 */

export type { ErrorCode, PhaseError } from '@generated'
