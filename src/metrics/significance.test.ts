import { describe, it, expect } from 'vitest'
import { isSignificant } from './significance.js'

describe('isSignificant (1.5 x IQR rule)', () => {
  it('flagged when |absolute| > 1.5 x IQR', () => {
    // |20| > 7.5
    expect(isSignificant(20, 5)).toBe(true)
    expect(isSignificant(-20, 5)).toBe(true)
  })

  it('not flagged when |absolute| <= 1.5 x IQR', () => {
    // |10| <= 30
    expect(isSignificant(10, 20)).toBe(false)
    // boundary: |7.5| > 7.5 is false
    expect(isSignificant(7.5, 5)).toBe(false)
  })

  it('never flagged without an IQR (N < 4)', () => {
    expect(isSignificant(1000, undefined)).toBe(false)
  })
})
