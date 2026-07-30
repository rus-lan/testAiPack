// Self-test for tests/helpers/variants.ts (WP1): every builder must produce
// objects that parse against the generated v2 zod schemas — this is what
// keeps 13 parallel packages structurally consistent without seeing each
// other's code (04-work-packages.md §5.2).

import { describe, expect, it } from 'vitest'
import {
  metricsReportSchema,
  reportSchema,
  runInputSchema,
  runResultSchema,
  variantAggregatesSchema,
  variantSpecSchema,
  workspaceTreeSchema,
} from '@generated/schemas'
import {
  makeMetricsReport,
  makeReportV2,
  makeRunResult,
  makeVariantAggregates,
  makeWorkspaceTree,
  shimPair,
  threeVariants,
} from './variants.js'

describe('shimPair', () => {
  it('produces a v2 RunInput that parses', () => {
    const { runInput } = shimPair()
    expect(() => runInputSchema.parse(runInput)).not.toThrow()
  })

  it('produces variants that each parse as VariantSpec', () => {
    const { variants } = shimPair()
    expect(variants).toHaveLength(2)
    for (const variant of variants) {
      expect(() => variantSpecSchema.parse(variant)).not.toThrow()
    }
  })

  it('desugars to old/new with exactly one pack on new', () => {
    const { runInput, variants } = shimPair()
    expect(runInput.baseline).toBe('old')
    expect(variants.map((v) => v.name)).toEqual(['old', 'new'])
    expect(variants[0]?.packs).toEqual([])
    expect(variants[1]?.packs).toEqual(['demo-pack'])
  })
})

describe('threeVariants', () => {
  it('produces a v2 RunInput that parses', () => {
    const { runInput } = threeVariants()
    expect(() => runInputSchema.parse(runInput)).not.toThrow()
  })

  it('produces variants that each parse as VariantSpec', () => {
    const { variants } = threeVariants()
    expect(variants).toHaveLength(3)
    for (const variant of variants) {
      expect(() => variantSpecSchema.parse(variant)).not.toThrow()
    }
  })

  it('is base + two single-pack variants, Stage 1 compliant', () => {
    const { runInput, variants } = threeVariants()
    expect(runInput.baseline).toBe('base')
    expect(runInput.packs).toHaveLength(2)
    for (const variant of variants) {
      expect(variant.packs.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('makeVariantAggregates', () => {
  it('parses against variantAggregatesSchema', () => {
    const aggregates = makeVariantAggregates('graphify')
    expect(() => variantAggregatesSchema.parse(aggregates)).not.toThrow()
    expect(aggregates.variant).toBe('graphify')
  })

  it('accepts overrides', () => {
    const aggregates = makeVariantAggregates('astgrep', { rawRunIds: ['session-x'] })
    expect(aggregates.rawRunIds).toEqual(['session-x'])
    expect(() => variantAggregatesSchema.parse(aggregates)).not.toThrow()
  })
})

describe('makeMetricsReport', () => {
  it('parses against metricsReportSchema with 3 variants and deltas vs base', () => {
    const metrics = makeMetricsReport()
    expect(() => metricsReportSchema.parse(metrics)).not.toThrow()
    expect(metrics.baseline).toBe('base')
    expect(metrics.variants.map((v) => v.variant)).toEqual(['base', 'graphify', 'astgrep'])
    expect(metrics.deltas.map((d) => d.variant)).toEqual(['graphify', 'astgrep'])
  })
})

describe('makeReportV2', () => {
  it('parses against reportSchema', () => {
    const report = makeReportV2()
    expect(() => reportSchema.parse(report)).not.toThrow()
    expect(report.schemaVersion).toBe(2)
  })

  it('accepts overrides', () => {
    const report = makeReportV2({ summary: { headlineResult: 'custom', perVariant: [], failures: [] } })
    expect(() => reportSchema.parse(report)).not.toThrow()
    expect(report.summary.headlineResult).toBe('custom')
  })
})

describe('makeRunResult', () => {
  it('parses against runResultSchema', () => {
    const result = makeRunResult('graphify', 2)
    expect(() => runResultSchema.parse(result)).not.toThrow()
    expect(result.variant).toBe('graphify')
    expect(result.runIndex).toBe(2)
  })
})

describe('makeWorkspaceTree', () => {
  it('parses against workspaceTreeSchema for N named variants', () => {
    const tree = makeWorkspaceTree('/tmp/ws', 2, ['base', 'graphify', 'astgrep'])
    expect(() => workspaceTreeSchema.parse(tree)).not.toThrow()
    expect(tree.variantTrees).toHaveLength(3)
    expect(tree.variantTrees[0]?.apps).toHaveLength(2)
  })
})
