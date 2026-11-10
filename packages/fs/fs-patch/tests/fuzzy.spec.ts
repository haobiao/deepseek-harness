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

  it('tolerates indentation differences that vary by line', () => {
    const content = '  a\n    b\n'
    const result = findLiteralMatches(content, ' a\n     b')
    expect(result.strategy).toBe('per-line-indent')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 9]])
    expect(replaceLiteralMatches(content, result.matches, 'done')).toBe('done\n')
  })

  it('reports per-line matching over the full range when the search ends with a newline', () => {
    const content = '  a\n    b\n'
    const result = findLiteralMatches(content, ' a\n     b\n')
    expect(result.strategy).toBe('per-line-indent')
    expect(result.matches.map(match => [match.start, match.end])).toEqual([[0, 10]])
  })

  it('does not use the per-line pass when the trailing newline is absent from the file', () => {
    const result = findLiteralMatches('  a\n    b', ' a\n     b\n')
    expect(result.matches.some(match => match.strategy === 'per-line-indent')).toBe(false)
  })

  it('rejects a per-line window that diverges after its first line', () => {
    expect(findLiteralMatches('  a\n    b\n  c\n', ' a\n     b\n  z').matches).toEqual([])
  })

  it('rejects a uniform-indent window that diverges after its first line', () => {
    expect(findLiteralMatches('  a\n    b\n', ' a\n   c').matches).toEqual([])
  })

  it('does not match a multi-line search longer than the file', () => {
    expect(findLiteralMatches('a\n', ' x\n y').matches).toEqual([])
  })

  it('only reaches the per-line pass after a uniform offset failed', () => {
    const result = findLiteralMatches('  a\n  b\n', ' a\n b')
    expect(result.strategy).toBe('relative-indent')
  })

  it('does not use the per-line pass for a single-line search', () => {
    expect(findLiteralMatches(' only()\n', '    only()').matches).toEqual([])
  })

  it('matches a comment header transcribed with extra leading spaces on some lines', () => {
    const content = [
      '/*****************************************************************************',
      '    Func Name: XMLCFG_SlaveToMaster',
      ' Date Created: 2011/8/15',
      '       Author: Michael Ran (R02617)',
      '  Description: Transit the role of current process from backup process to',
      '               main process.',
      '        Input: VOID',
      '       Output: None',
      '       Return: VOID',
      '      Caution:',
      '------------------------------------------------------------------------------',
      '  Modification History',
      '  DATE        NAME             DESCRIPTION',
      '  --------------------------------------------------------------------------',
      '  YYYY-MM-DD',
      '*****************************************************************************/',
    ].join('\n') + '\n'
    const search = [
      '/*****************************************************************************',
      '     Func Name: XMLCFG_SlaveToMaster',
      ' Date Created: 2011/8/15',
      '        Author: Michael Ran (R02617)',
      '   Description: Transit the role of current process from backup process to',
      '                main process.',
      '         Input: VOID',
      '        Output: None',
      '        Return: VOID',
      '       Caution:',
      '------------------------------------------------------------------------------',
      '   Modification History',
      '   DATE        NAME             DESCRIPTION',
      '   --------------------------------------------------------------------------',
      '   YYYY-MM-DD',
      ' *****************************************************************************/',
    ].join('\n')
    const result = findLiteralMatches(content, search)
    expect(result.strategy).toBe('per-line-indent')
    expect(result.matches).toEqual([{ start: 0, end: content.length - 1, strategy: 'per-line-indent' }])
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

  it('returns no matches for an empty search', () => {
    expect(findLiteralMatches('a\n', '')).toEqual({ matches: [], strategy: 'exact' })
  })

  it('matches a whitespace-only search as an empty blank-line run', () => {
    const result = findLiteralMatches('\n', '\t')
    expect(result.strategy).toBe('blank-line-runs')
    expect(result.matches).toEqual([{ start: 0, end: 0, strategy: 'blank-line-runs' }])
  })

  it('rejects a blank-run window whose first line differs', () => {
    expect(findLiteralMatches('x\n\n\nb\n', 'a\n\nb').matches).toEqual([])
  })

  it('rejects a blank-run window that diverges after its first line', () => {
    expect(findLiteralMatches('a\n\n\nc\n', 'a\n\nb').matches).toEqual([])
  })

  it('rejects a blank-run search longer than the compressed file', () => {
    expect(findLiteralMatches('a\n', 'a\n\nb').matches).toEqual([])
  })

  it('rejects a blank-run match whose trailing newline is absent', () => {
    expect(findLiteralMatches('a\n\n\nb', 'a\n\nb\n').matches).toEqual([])
  })

  it('extends a blank-run match over its trailing newline', () => {
    const result = findLiteralMatches('a\n\n\nb\n', 'a\n\nb\n')
    expect(result.strategy).toBe('blank-line-runs')
    expect(result.matches).toEqual([{ start: 0, end: 6, strategy: 'blank-line-runs' }])
  })

  it('tolerates blank lines shorter than the shared indent', () => {
    const result = findLiteralMatches('  a\n\n\n  b\n', '  a\n \n  b')
    expect(result.strategy).toBe('blank-line-runs')
    expect(result.matches).toEqual([{ start: 0, end: 9, strategy: 'blank-line-runs' }])
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

  it('renders tabs in mismatch snippets', () => {
    const mismatch = locateLiteralMismatch('\tvalue\n', ' value')
    expect(mismatch).toEqual({ line: 1, column: 1, expected: '·value', actual: '→value' })
  })

  it('clips long lines with an ellipsis on each side', () => {
    const actualLine = 'x'.repeat(30) + 'a' + 'y'.repeat(60)
    const expectedLine = 'x'.repeat(30) + 'b' + 'y'.repeat(60)
    const mismatch = locateLiteralMismatch(`${actualLine}\n`, expectedLine)
    expect(mismatch).toEqual({
      line: 1,
      column: 31,
      expected: `…${'x'.repeat(24)}b${'y'.repeat(47)}…`,
      actual: `…${'x'.repeat(24)}a${'y'.repeat(47)}…`,
    })
  })

  it('points at a blank line when the search has only blank lines', () => {
    const mismatch = locateLiteralMismatch('abc\n\n', '\n')
    expect(mismatch).toEqual({ line: 2, column: 1, expected: '', actual: '' })
  })

  it('formats one model-facing clause', () => {
    const mismatch = locateLiteralMismatch('const value = 1\n', 'const value = 2')
    expect(formatLiteralMismatch(mismatch!)).toBe(
      'nearest candidate is line 1, column 15: expected "const·value·=·2" but found "const·value·=·1"',
    )
  })
})
