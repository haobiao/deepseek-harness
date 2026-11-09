/** Tolerance-ladder matching, offset mapping, and failure localization. */

import { describe, expect, it } from 'vitest'
import {
  findLiteralMatches,
  formatLiteralMismatch,
  locateLiteralMismatch,
  replaceLiteralMatches,
} from '../src/index.ts'

describe('findLiteralMatches', () => {
  it('prefers an exact substring and reports every occurrence', () => {
    const content = 'a b\na b\n'
    const result = findLiteralMatches(content, 'a b')
    expect(result.strategy).toBe('exact')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 3], [4, 7]])
  })

  it('stops at the first pass that succeeds', () => {
    const result = findLiteralMatches('x \n', 'x')
    expect(result.strategy).toBe('exact')
    expect(result.matches).toEqual([{ start: 0, end: 1, strategy: 'exact' }])
  })

  it('ignores trailing whitespace in both the file and the search', () => {
    const content = 'foo   \nbar\t\n'
    const result = findLiteralMatches(content, 'foo\nbar')
    expect(result.strategy).toBe('trailing-whitespace')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 11]])
    expect(replaceLiteralMatches(content, result.matches, 'done')).toBe('done\n')
  })

  it('expands tabs in both the file and the search', () => {
    const result = findLiteralMatches('\tif (x)\n', '    if (x)')
    expect(result.strategy).toBe('expanded-tabs')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 7]])
  })

  it('ignores a uniform indentation difference on multi-line searches', () => {
    const content = '    if (x) {\n        y()\n    }\n'
    const search = 'if (x) {\n    y()\n}'
    const result = findLiteralMatches(content, search)
    expect(result.strategy).toBe('relative-indent')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 30]])
    expect(replaceLiteralMatches(content, result.matches, 'body')).toBe('body\n')
  })

  it('tolerates a different number of blank lines', () => {
    const result = findLiteralMatches('a\n\n\n\nb\n', 'a\n\nb')
    expect(result.strategy).toBe('blank-line-runs')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 6]])
  })

  it('normalizes typographic punctuation', () => {
    const result = findLiteralMatches('it’s “quoted” – dash\n', 'it\'s "quoted" - dash')
    expect(result.strategy).toBe('punctuation')
    expect(replaceLiteralMatches('it’s “quoted” – dash\n', result.matches, 'plain')).toBe('plain\n')
  })

  it('never collapses internal spaces', () => {
    expect(findLiteralMatches('a  b\n', 'a b').matches).toEqual([])
  })

  it('never ignores a nonuniform indentation difference', () => {
    expect(findLiteralMatches('  a\n    b\n', ' a\n  b').matches).toEqual([])
  })

  it('splices a CRLF file while preserving its line endings', () => {
    const content = 'line1\r\nfoo\r\n'
    const result = findLiteralMatches(content, 'foo')
    expect(result.matches).toEqual([{ start: 7, end: 10, strategy: 'exact' }])
    expect(replaceLiteralMatches(content, result.matches, 'BAR')).toBe('line1\r\nBAR\r\n')
  })

  it('keeps a byte-exact CRLF search to its exact occurrence', () => {
    const content = 'alpha\r\nbeta\nalpha\nbeta'
    const result = findLiteralMatches(content, 'alpha\r\nbeta')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ start: 0 })
  })

  it('matches an LF search inside a CRLF file', () => {
    const result = findLiteralMatches('alpha\r\nbeta\r\n', 'alpha\nbeta')
    expect(result.strategy).toBe('exact')
    expect(replaceLiteralMatches('alpha\r\nbeta\r\n', result.matches, 'x')).toBe('x\r\n')
  })

  it('replaces several matches without shifting the earlier offsets', () => {
    const content = 'x y x'
    const result = findLiteralMatches(content, 'x')
    expect(replaceLiteralMatches(content, result.matches, 'long')).toBe('long y long')
  })
})

describe('locateLiteralMismatch', () => {
  it('points at the nearest line and column that differ', () => {
    const mismatch = locateLiteralMismatch('const value = 1\n', 'const value = 2')
    expect(mismatch).toEqual({
      line: 1,
      column: 15,
      expected: 'const·value·=·2',
      actual: 'const·value·=·1',
    })
  })

  it('renders visible whitespace', () => {
    const mismatch = locateLiteralMismatch('    x\n', '  y')
    expect(mismatch).toEqual({ line: 1, column: 3, expected: '··y', actual: '····x' })
  })

  it('returns undefined for empty content', () => {
    expect(locateLiteralMismatch('', 'x')).toBeUndefined()
  })

  it('formats one model-facing clause', () => {
    const mismatch = locateLiteralMismatch('const value = 1\n', 'const value = 2')
    expect(formatLiteralMismatch(mismatch!)).toBe(
      'nearest candidate is line 1, column 15: expected "const·value·=·2" but found "const·value·=·1"',
    )
  })
})
