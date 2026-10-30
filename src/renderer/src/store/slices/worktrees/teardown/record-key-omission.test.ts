import { describe, expect, it } from 'vitest'
import {
  omitRecordKeys,
  omitRecordKeysByWorktreeId,
  readRecordEntriesByWorktreeId
} from './record-key-omission'

describe('omitRecordKeys', () => {
  it('returns the same record when none of the keys are present', () => {
    const record = { a: 1 }
    expect(omitRecordKeys(record, ['b', 'c'])).toBe(record)
    expect(omitRecordKeys(record, new Set<string>())).toBe(record)
  })

  it('copies once and drops every present key', () => {
    const record = { a: 1, b: 2, c: 3 }
    const next = omitRecordKeys(record, new Set(['a', 'c', 'missing']))
    expect(next).not.toBe(record)
    expect(next).toEqual({ b: 2 })
    expect(record).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('drops a key whose value is undefined', () => {
    expect(omitRecordKeys({ a: undefined }, ['a'])).toEqual({})
  })

  it('normalizes a missing record to an empty one, as spread-then-delete did', () => {
    expect(omitRecordKeys(undefined, ['a'])).toEqual({})
  })
})

const ID = 'repo1::/path/wt1'
const HOST_A = 'runtime:aaaa'
const HOST_B = 'runtime:bbbb'

describe('omitRecordKeysByWorktreeId', () => {
  it('drops the bare key and every host-qualified spelling of the id (STA-4343)', () => {
    const record = {
      [ID]: 'bare',
      [`${HOST_A}|${ID}`]: 'a',
      [`${HOST_B}|${ID}`]: 'b',
      'other-repo::/path/other': 'keep',
      [`${HOST_A}|other-repo::/path/other`]: 'keep too'
    }
    expect(omitRecordKeysByWorktreeId(record, new Set([ID]))).toEqual({
      'other-repo::/path/other': 'keep',
      [`${HOST_A}|other-repo::/path/other`]: 'keep too'
    })
  })

  it('keeps the record identity when neither spelling is present', () => {
    const record = { 'other-repo::/x': 1 }
    expect(omitRecordKeysByWorktreeId(record, new Set([ID]))).toBe(record)
  })

  it('keeps a foreign key that merely contains the id as a substring', () => {
    // A pane key or a path-prefixed key is not a session key for the id; the decode
    // (getWorkspaceIdFromSessionKey) must not match it.
    const record = { [`prefix-${ID}`]: 1 }
    expect(omitRecordKeysByWorktreeId(record, new Set([ID]))).toBe(record)
  })
})

describe('readRecordEntriesByWorktreeId', () => {
  it('collects the bare and qualified rows of one id', () => {
    const record = {
      [ID]: ['t1'],
      [`${HOST_A}|${ID}`]: ['t2'],
      'other::/x': ['t3']
    }
    expect(readRecordEntriesByWorktreeId(record, ID).flat()).toEqual(['t1', 't2'])
  })

  it('returns nothing for an absent id or record', () => {
    expect(readRecordEntriesByWorktreeId({ 'other::/x': 1 }, ID)).toEqual([])
    expect(readRecordEntriesByWorktreeId(undefined, ID)).toEqual([])
  })
})
