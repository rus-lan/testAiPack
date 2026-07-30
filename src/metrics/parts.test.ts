import { describe, it, expect } from 'vitest'
import type { ExportPart } from '@generated/types'
import { isReasoning, isStepFinish, isText, isTool } from './parts.js'

const asPart = (v: Record<string, unknown>): ExportPart => v as ExportPart

describe('isText', () => {
  it('true for a well-formed text part', () => {
    expect(isText(asPart({ type: 'text', text: 'hi', id: 'x' }))).toBe(true)
  })

  it('true when text is an empty string (falsy but valid)', () => {
    expect(isText(asPart({ type: 'text', text: '', id: 'x' }))).toBe(true)
  })

  it('false when text is present but not a string', () => {
    expect(isText(asPart({ type: 'text', text: 123, id: 'x' }))).toBe(false)
  })

  it('false for a part stripped to {type, id} (no text field)', () => {
    expect(isText(asPart({ type: 'text', id: 'x' }))).toBe(false)
  })

  it('false for a different part type', () => {
    expect(isText(asPart({ type: 'reasoning', text: 'hi', time: { start: 0, end: 1 }, id: 'x' }))).toBe(false)
  })
})

describe('isReasoning', () => {
  it('true when time.start is a finite number, even without time.end', () => {
    expect(isReasoning(asPart({ type: 'reasoning', text: '', time: { start: 100 }, id: 'x' }))).toBe(true)
  })

  it('true for a well-formed reasoning part (both start and end)', () => {
    expect(isReasoning(asPart({ type: 'reasoning', text: '', time: { start: 100, end: 200 }, id: 'x' }))).toBe(true)
  })

  it('true when time.start is 0 (falsy but valid)', () => {
    expect(isReasoning(asPart({ type: 'reasoning', text: '', time: { start: 0 }, id: 'x' }))).toBe(true)
  })

  it('false for a part stripped to {type, id} (no time field)', () => {
    expect(isReasoning(asPart({ type: 'reasoning', id: 'x' }))).toBe(false)
  })

  it('false when time is present but start is missing/non-numeric', () => {
    expect(isReasoning(asPart({ type: 'reasoning', text: '', time: {}, id: 'x' }))).toBe(false)
    expect(isReasoning(asPart({ type: 'reasoning', text: '', time: { start: 'nope' }, id: 'x' }))).toBe(false)
  })

  it('false for a different part type', () => {
    expect(isReasoning(asPart({ type: 'text', text: 'hi', id: 'x' }))).toBe(false)
  })
})

describe('isTool', () => {
  it('true when state is an object, even without state.time', () => {
    expect(isTool(asPart({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending', input: {} }, id: 'x' }))).toBe(true)
  })

  it('true when state is an empty object (falsy-ish but a valid record)', () => {
    expect(isTool(asPart({ type: 'tool', tool: 'bash', callID: 'c1', state: {}, id: 'x' }))).toBe(true)
  })

  it('false when state is present but not a record (array or primitive)', () => {
    expect(isTool(asPart({ type: 'tool', tool: 'bash', callID: 'c1', state: [], id: 'x' }))).toBe(false)
    expect(isTool(asPart({ type: 'tool', tool: 'bash', callID: 'c1', state: 'x', id: 'x' }))).toBe(false)
  })

  it('false for a part stripped to {type, id} (no state field)', () => {
    expect(isTool(asPart({ type: 'tool', id: 'x' }))).toBe(false)
  })

  it('false for a different part type', () => {
    expect(isTool(asPart({ type: 'text', text: 'hi', id: 'x' }))).toBe(false)
  })
})

describe('isStepFinish', () => {
  it('true for a minimal step-finish part (only reads optional fields downstream)', () => {
    expect(isStepFinish(asPart({ type: 'step-finish', id: 'x' }))).toBe(true)
  })

  it('false for a different part type', () => {
    expect(isStepFinish(asPart({ type: 'text', text: 'hi', id: 'x' }))).toBe(false)
  })
})
