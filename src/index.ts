/**
 * testaipack — public API surface.
 *
 * Re-exports the phase pipeline anchors and shared error types. Concrete
 * implementations land in Stage 2.2 per docs/phases/*.ru.md.
 */
export * from './errors.js'
export * from './phases/00-cli-parse.js'
export * from './phases/01-workspace-setup.js'
export * from './phases/02-repo-clone.js'
export * from './phases/03-pack-install.js'
export * from './phases/04-home-isolation.js'
export * from './phases/05-preflight.js'
export * from './phases/06-run-side.js'
export * from './phases/07-aggregate.js'
export * from './phases/08-diff.js'
export * from './phases/09-judge.js'
export * from './phases/10-timeline.js'
export * from './phases/11-report-render.js'
export * from './phases/12-review-workspace.js'
export * from './phases/13-cleanup.js'
