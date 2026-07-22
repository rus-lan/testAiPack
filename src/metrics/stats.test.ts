import { describe, it, expect } from 'vitest'
import { interquartileRange, maximum, median, minimum, percentile, toNum } from './stats.js'

describe('median', () => {
  it('odd sample -> middle element', () => {
    expect(median([10, 20, 30])).toBe(20)
    expect(median([30, 10])).not.toBe(10)
  })

  it('even sample -> average of two middle elements', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it('single sample', () => {
    expect(median([7])).toBe(7)
  })

  it('empty sample -> 0', () => {
    expect(median([])).toBe(0)
  })

  it('unsorted input is sorted first', () => {
    expect(median([30, 10, 20])).toBe(20)
  })
})

describe('percentile', () => {
  it('p50 equals median for odd length', () => {
    expect(percentile([10, 20, 30], 50)).toBe(20)
  })

  it('p95 interpolates within the sample range', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const p95 = percentile(samples, 95)
    expect(p95).toBeGreaterThan(90)
    expect(p95).toBeLessThanOrEqual(100)
  })

  it('empty -> 0, single -> that value', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([42], 99)).toBe(42)
  })
})

describe('minimum / maximum', () => {
  it('report the bounds', () => {
    expect(minimum([4, 1, 9, 2])).toBe(1)
    expect(maximum([4, 1, 9, 2])).toBe(9)
  })

  it('empty -> 0', () => {
    expect(minimum([])).toBe(0)
    expect(maximum([])).toBe(0)
  })
})

describe('interquartileRange', () => {
  it('undefined when fewer than 4 samples', () => {
    expect(interquartileRange([1, 2, 3])).toBeUndefined()
    expect(interquartileRange([])).toBeUndefined()
  })

  it('P75 - P25 when N >= 4', () => {
    // Type-7 interpolation: P25=3.25, P75=7.75 -> IQR=4.5
    expect(interquartileRange([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(4.5, 5)
  })
})

describe('toNum', () => {
  it('parses string int64 and passes through numbers', () => {
    expect(toNum('123')).toBe(123)
    expect(toNum(456)).toBe(456)
    expect(toNum(undefined)).toBe(0)
  })

  it('falls back to 0 on non-numeric', () => {
    expect(toNum('not-a-number')).toBe(0)
  })
})
