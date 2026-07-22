import { describe, it, expect } from 'vitest'
import {
  fmtCost,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtValue,
  sigLabel,
  toNum,
  trimTrailingZeros,
  verdictFor,
} from './format.js'
import type { MetricKind } from './format.js'
import type { MetricDelta } from '@generated/types'

describe('format — number helpers', () => {
  it.each([
    ['0', 0],
    ['12345', 12345],
    ['10987', 10987],
  ])('toNum("%s") === %d', (input, expected) => {
    expect(toNum(input)).toBe(expected)
  })

  it.each<[string | number, string]>([
    ['12345', '12345'],
    [10987, '10987'],
    [52000, '52000'],
    ['45000', '45000'],
  ])('fmtInt(%j) === %s', (input, expected) => {
    expect(fmtInt(input)).toBe(expected)
  })

  it.each<[number, string]>([
    [0, '0'],
    [0.045, '0.045'],
    [0.041, '0.041'],
    [0.004, '0.004'],
    [1.2, '1.2'],
    [1.0, '1'],
  ])('fmtCost(%d) === %s', (input, expected) => {
    expect(fmtCost(input)).toBe(expected)
  })

  it.each<[string, string]>([
    ['0.0450', '0.045'],
    ['1.2000', '1.2'],
    ['1.0000', '1'],
    ['5', '5'],
  ])('trimTrailingZeros(%j) === %j', (input, expected) => {
    expect(trimTrailingZeros(input)).toBe(expected)
  })
})

describe('format — signed deltas and percent', () => {
  it.each<[number, 'int' | 'cost' | 'rank', string]>([
    [-1358, 'int', '-1358'],
    [7000, 'int', '+7000'],
    [0, 'int', '0'],
    [-0.004, 'cost', '-0.004'],
    [0.004, 'cost', '+0.004'],
    [2, 'rank', '+2'],
    [0, 'rank', '0'],
  ])('fmtSigned(%d, %s) === %s', (value, kind, expected) => {
    expect(fmtSigned(value, kind)).toBe(expected)
  })

  it.each<[number, string]>([
    [-11.0, '-11.0%'],
    [15.6, '+15.6%'],
    [0, '0.0%'],
    [-8.9, '-8.9%'],
  ])('fmtPct(%d) === %s', (value, expected) => {
    expect(fmtPct(value)).toBe(expected)
  })

  it.each<[string | number, MetricKind, string]>([
    ['12345', 'int', '12345'],
    [0.045, 'cost', '0.045'],
    [4, 'rank', '4'],
  ])('fmtValue(%j, %s) === %s', (value, kind, expected) => {
    expect(fmtValue(value, kind)).toBe(expected)
  })
})

const delta = (
  better: MetricDelta['better'],
  significant: boolean,
): MetricDelta => ({
  absolute: 0,
  percent: 0,
  significant,
  better,
})

describe('format — verdict and significance labels', () => {
  it.each<[MetricDelta['better'], string]>([
    ['better', '✓ better'],
    ['worse', '⚠ worse'],
    ['neutral', '= same'],
    ['context-dependent', '≈ ctx'],
  ])('verdictFor(%s) === %s', (better, expected) => {
    expect(verdictFor(delta(better, false))).toBe(expected)
  })

  it.each<[MetricDelta['better'], boolean, string]>([
    ['better', true, '✓ significant'],
    ['worse', true, '⚠ significant'],
    ['neutral', true, 'significant'],
    ['context-dependent', true, 'significant'],
    ['neutral', false, '—'],
    ['better', false, 'in noise'],
    ['worse', false, 'in noise'],
  ])('sigLabel(%s, sig=%s) === %s', (better, significant, expected) => {
    expect(sigLabel(delta(better, significant))).toBe(expected)
  })
})
