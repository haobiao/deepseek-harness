/**
 * Whitespace-tolerant literal matching and mismatch localization.
 *
 * The ladder is deliberately ordered from strict to permissive and stops at the
 * first strategy with a match, so an exact match never becomes ambiguous through
 * a later pass. Internal spaces are never collapsed, and leading indentation is
 * tolerated only as a uniform offset shared by every line of the search text.
 */

/** A matching pass in the tolerance ladder. */
export type LiteralMatchStrategy =
  | 'exact'
  | 'trailing-whitespace'
  | 'expanded-tabs'
  | 'relative-indent'
  | 'blank-line-runs'
  | 'punctuation'

/** One occurrence found in the caller's original string. */
export interface LiteralMatch {
  /** UTF-16 start offset in the original string, inclusive. */
  start: number
  /** UTF-16 end offset in the original string, exclusive. */
  end: number
  /** The pass that produced this match. */
  strategy: LiteralMatchStrategy
}

/** The first pass with at least one match, plus every match it found. */
export interface LiteralMatchResult {
  matches: LiteralMatch[]
  strategy: LiteralMatchStrategy
}

/** Nearest-line description of a search string that did not match. */
export interface LiteralMismatch {
  /** One-based line number in the content. */
  line: number
  /** One-based column of the first differing character. */
  column: number
  /** Visible representation of the expected text at that point. */
  expected: string
  /** Visible representation of the content actually there. */
  actual: string
}

interface MappedText {
  text: string
  /** `start[i]` is the offset in the original content of transformed character `i`. */
  start: number[]
  /** `end[i]` is the offset just past transformed character `i` in the original content. */
  end: number[]
}

interface MappedLine {
  text: string
  start: number[]
  end: number[]
}

interface LineSpan {
  text: string
  start: number
}

const RSTRIP = /[\t  ]+$/u
const LEADING = /^[\t  ]*/u

function identityLine(text: string): MappedLine {
  const start = new Array<number>(text.length)
  const end = new Array<number>(text.length)
  for (let index = 0; index < text.length; index++) {
    start[index] = index
    end[index] = index + 1
  }
  return { text, start, end }
}

function identityText(text: string): MappedText {
  const { start, end } = identityLine(text)
  return { text, start, end }
}

/** The original offset just past the transformed text, or zero for empty text. */
function endPosition(source: MappedText): number {
  return source.text.length === 0 ? 0 : (source.end[source.text.length - 1] as number)
}

/** Replace CRLF with LF while keeping each transformed character addressable. */
function normalizeCrlf(content: string): MappedText {
  if (!content.includes('\r\n')) return identityText(content)
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      parts.push('\n')
      start.push(index)
      end.push(index + 2)
      index += 1
    } else {
      parts.push(content[index] as string)
      start.push(index)
      end.push(index + 1)
    }
  }
  return { text: parts.join(''), start, end }
}

/** Rewrite every line, keeping each output character linked to its source range. */
function transformLines(source: MappedText, transform: (line: string) => MappedLine): MappedText {
  const parts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  const emit = (lineStart: number, transformed: MappedLine): void => {
    parts.push(transformed.text)
    for (let index = 0; index < transformed.text.length; index++) {
      const sourceIndex = lineStart + (transformed.start[index] as number)
      starts.push(source.start[sourceIndex] as number)
      ends.push(source.end[sourceIndex] as number)
    }
  }
  let start = 0
  while (true) {
    const newline = source.text.indexOf('\n', start)
    const end = newline < 0 ? source.text.length : newline
    emit(start, transform(source.text.slice(start, end)))
    if (newline < 0) break
    parts.push('\n')
    starts.push(source.start[newline] as number)
    ends.push(source.end[newline] as number)
    start = newline + 1
    /* v8 ignore next -- indexOf only returns a position before the end. */
    if (start > source.text.length) break
  }
  return { text: parts.join(''), start: starts, end: ends }
}

function rstrip(line: string): string {
  return line.replace(RSTRIP, '')
}

function stripLeading(line: string): string {
  return line.replace(LEADING, '')
}

function expandTabs(line: string): MappedLine {
  if (!line.includes('\t')) return identityLine(line)
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\t') {
      parts.push('    ')
      start.push(index, index, index, index)
      end.push(index + 1, index + 1, index + 1, index + 1)
    } else {
      parts.push(line[index] as string)
      start.push(index)
      end.push(index + 1)
    }
  }
  return { text: parts.join(''), start, end }
}

function normalizePunctuationLine(line: string): MappedLine {
  const text = line
    .replace(/[‐-―−]/gu, '-')
    .replace(/[‘-‛]/gu, "'")
    .replace(/[“-‟]/gu, '"')
    .replace(/[  -   　]/gu, ' ')
  return identityLine(text)
}

function rstripLines(source: MappedText): MappedText {
  return transformLines(source, line => identityLine(rstrip(line)))
}

function expandTabsAndRstrip(source: MappedText): MappedText {
  return transformLines(source, (line) => {
    const expanded = expandTabs(line)
    const text = rstrip(expanded.text)
    return { text, start: expanded.start.slice(0, text.length), end: expanded.end.slice(0, text.length) }
  })
}

function normalizePunctuationAndRstrip(source: MappedText): MappedText {
  return transformLines(source, (line) => {
    const normalized = normalizePunctuationLine(line)
    const text = rstrip(normalized.text)
    return { text, start: normalized.start.slice(0, text.length), end: normalized.end.slice(0, text.length) }
  })
}

/** Locate non-overlapping substring occurrences. */
function offsetsIn(text: string, needle: string): number[] {
  if (needle.length === 0) return []
  const offsets: number[] = []
  let offset = 0
  while (true) {
    const found = text.indexOf(needle, offset)
    if (found < 0) return offsets
    offsets.push(found)
    offset = found + needle.length
  }
}

/** Map a transformed range to the original string. */
function toMappedRange(source: MappedText, start: number, end: number): { start: number; end: number } {
  const originStart = source.start[start] ?? endPosition(source)
  const originEnd = end <= start ? originStart : (source.end[end - 1] ?? endPosition(source))
  return { start: originStart, end: originEnd }
}

/** Split into lines without inventing a trailing empty line for a final newline. */
function bodyLines(text: string): LineSpan[] {
  const lines: LineSpan[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      lines.push({ text: text.slice(start, index), start })
      start = index + 1
    }
  }
  if (start < text.length || lines.length === 0) lines.push({ text: text.slice(start), start })
  return lines
}

/** Split a search string; a trailing newline marks the range end rather than a line. */
function patternLines(search: string): string[] {
  if (search.endsWith('\n')) return search.slice(0, -1).split('\n')
  return search.split('\n')
}

function commonIndent(lines: readonly string[]): string {
  let prefix: string | undefined
  for (const line of lines) {
    if (rstrip(line).length === 0) continue
    const indent = LEADING.exec(line)?.[0] ?? ''
    if (prefix === undefined) prefix = indent
    else {
      let length = 0
      while (length < prefix.length && length < indent.length && prefix[length] === indent[length]) length++
      prefix = prefix.slice(0, length)
    }
    if (prefix.length === 0) return ''
  }
  return prefix ?? ''
}

function dedent(lines: readonly string[]): string[] {
  const indent = commonIndent(lines)
  return indent.length === 0
    ? [...lines]
    : lines.map(line => (line.startsWith(indent) ? line.slice(indent.length) : line))
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

function relativeIndentOffsets(text: string, search: string): Array<{ start: number; end: number }> | undefined {
  const pattern = patternLines(search)
  if (pattern.length < 2) return undefined
  const spans = bodyLines(text)
  if (pattern.length > spans.length) return undefined
  const requiresNewline = search.endsWith('\n')
  const expected = dedent(pattern).map(rstrip)
  const firstKey = rstrip(stripLeading(pattern[0] as string))
  const results: Array<{ start: number; end: number }> = []
  for (let index = 0; index + pattern.length <= spans.length; index++) {
    if (rstrip(stripLeading((spans[index] as LineSpan).text)) !== firstKey) continue
    const window = spans.slice(index, index + pattern.length).map(span => span.text)
    if (!sameLines(expected, dedent(window).map(rstrip))) continue
    const last = spans[index + pattern.length - 1] as LineSpan
    let end = last.start + last.text.length
    if (requiresNewline) {
      if (text[end] !== '\n') continue
      end += 1
    }
    results.push({ start: (spans[index] as LineSpan).start, end })
  }
  return results
}

interface CompressedSpan {
  text: string
  first: number
  last: number
}

function compressBlankRuns(spans: readonly LineSpan[]): CompressedSpan[] {
  const compressed: CompressedSpan[] = []
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index] as LineSpan
    if (rstrip(span.text).length > 0) {
      compressed.push({ text: span.text, first: index, last: index })
      continue
    }
    let last = index
    while (last + 1 < spans.length && rstrip((spans[last + 1] as LineSpan).text).length === 0) last++
    compressed.push({ text: '', first: index, last })
    index = last
  }
  return compressed
}

function blankRunOffsets(text: string, search: string): Array<{ start: number; end: number }> | undefined {
  const pattern = patternLines(search)
  if (!pattern.some(line => rstrip(line).length === 0)) return undefined
  const spans = bodyLines(text)
  const compressedPattern = compressBlankRuns(pattern.map((line, index) => ({ text: line, start: index })))
  const compressedContent = compressBlankRuns(spans)
  if (compressedPattern.length > compressedContent.length) return undefined
  const requiresNewline = search.endsWith('\n')
  const expected = dedent(compressedPattern.map(entry => entry.text)).map(rstrip)
  const firstKey = rstrip(stripLeading(pattern[0] as string))
  const results: Array<{ start: number; end: number }> = []
  for (let index = 0; index + compressedPattern.length <= compressedContent.length; index++) {
    if (rstrip(stripLeading((compressedContent[index] as CompressedSpan).text)) !== firstKey) continue
    const window = compressedContent.slice(index, index + compressedPattern.length).map(entry => entry.text)
    if (!sameLines(expected, dedent(window).map(rstrip))) continue
    const lastSpanIndex = (compressedContent[index + compressedPattern.length - 1] as CompressedSpan).last
    const last = spans[lastSpanIndex] as LineSpan
    let end = last.start + last.text.length
    if (requiresNewline) {
      if (text[end] !== '\n') continue
      end += 1
    }
    const firstSpan = spans[(compressedContent[index] as CompressedSpan).first] as LineSpan
    results.push({ start: firstSpan.start, end })
  }
  return results
}

/**
 * Extend tolerant matches over the trailing whitespace the matched line had, so a
 * replacement does not leave orphaned indentation behind. Line endings are kept.
 */
function extendTrailingWhitespace(content: string, matches: LiteralMatch[]): LiteralMatch[] {
  return matches.map((match) => {
    let end = match.end
    while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end += 1
    return end === match.end ? match : { ...match, end }
  })
}

function substringMatches(source: MappedText, needle: string, strategy: LiteralMatchStrategy): LiteralMatch[] | undefined {
  const offsets = offsetsIn(source.text, needle)
  if (offsets.length === 0) return undefined
  return offsets.map((offset) => {
    const range = toMappedRange(source, offset, offset + needle.length)
    return { ...range, strategy }
  })
}

/**
 * Find occurrences of `search` in `content` at the first tolerance level with a match.
 *
 * Passes, in order: exact substring; trailing whitespace per line; tabs expanded to
 * four spaces; a uniform indentation offset on multi-line searches; differing runs of
 * blank lines; typographic punctuation. Internal spaces and nonuniform indentation
 * are never ignored.
 * @param content - text to search, in any line-ending style.
 * @param search - non-empty literal text the caller wants to replace.
 * @returns every match at the successful pass, or an empty list with `strategy: 'exact'`.
 */
export function findLiteralMatches(content: string, search: string): LiteralMatchResult {
  const source = normalizeCrlf(content)
  const needle = normalizeCrlf(search).text
  if (needle.length === 0) return { matches: [], strategy: 'exact' }

  // Raw first: a search that spells out CRLF keeps its byte-exact meaning.
  const raw = offsetsIn(content, search)
  if (raw.length > 0) {
    return {
      matches: raw.map(offset => ({ start: offset, end: offset + search.length, strategy: 'exact' as const })),
      strategy: 'exact',
    }
  }

  const exact = substringMatches(source, needle, 'exact')
  if (exact !== undefined) return { matches: exact, strategy: 'exact' }

  const rstripped = rstripLines(source)
  const trailing = substringMatches(rstripped, rstripLines(normalizeCrlf(needle)).text, 'trailing-whitespace')
  if (trailing !== undefined) return { matches: extendTrailingWhitespace(content, trailing), strategy: 'trailing-whitespace' }

  const expanded = expandTabsAndRstrip(source)
  const tabs = substringMatches(expanded, expandTabsAndRstrip(normalizeCrlf(needle)).text, 'expanded-tabs')
  if (tabs !== undefined) return { matches: extendTrailingWhitespace(content, tabs), strategy: 'expanded-tabs' }

  const relative = relativeIndentOffsets(source.text, needle)
  if (relative !== undefined && relative.length > 0) {
    return {
      matches: extendTrailingWhitespace(content, relative.map(range => ({ ...toMappedRange(source, range.start, range.end), strategy: 'relative-indent' as const }))),
      strategy: 'relative-indent',
    }
  }

  const blankRuns = blankRunOffsets(source.text, needle)
  if (blankRuns !== undefined && blankRuns.length > 0) {
    return {
      matches: extendTrailingWhitespace(content, blankRuns.map(range => ({ ...toMappedRange(source, range.start, range.end), strategy: 'blank-line-runs' as const }))),
      strategy: 'blank-line-runs',
    }
  }

  const punctuated = normalizePunctuationAndRstrip(source)
  const punctuation = substringMatches(punctuated, normalizePunctuationAndRstrip(normalizeCrlf(needle)).text, 'punctuation')
  if (punctuation !== undefined) return { matches: extendTrailingWhitespace(content, punctuation), strategy: 'punctuation' }

  return { matches: [], strategy: 'exact' }
}

/**
 * Replace caller-selected matches, working from the end so earlier offsets stay valid.
 * @param content - the original string the matches index into.
 * @param matches - matches from {@link findLiteralMatches}, in ascending order.
 * @param replacement - literal replacement text.
 */
export function replaceLiteralMatches(content: string, matches: readonly LiteralMatch[], replacement: string): string {
  let result = content
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, match.start) + replacement + result.slice(match.end)
  }
  return result
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index++
  return index
}

function visible(snippet: string): string {
  let result = ''
  for (const character of snippet) {
    if (character === ' ') result += '·'
    else if (character === '\t') result += '→'
    else result += character
  }
  return result
}

function snippetAt(line: string, offset: number): string {
  const before = 24
  const after = 48
  const start = Math.max(0, offset - before)
  const end = Math.min(line.length, offset + after)
  const characters = Array.from(line.slice(start, end))
  const clipped = characters.length > after + before ? characters.slice(0, after + before) : characters
  return `${start > 0 ? '…' : ''}${visible(clipped.join(''))}${end < line.length ? '…' : ''}`
}

/**
 * Describe where a search string came closest to the content, for a failure message.
 *
 * The comparison is a line-local common prefix, enough to point a model at the
 * line and column that differ instead of reporting only "not found".
 * @param content - the file text that was searched.
 * @param search - the literal text that did not match.
 * @returns the nearest line and column, or undefined for empty content.
 */
export function locateLiteralMismatch(content: string, search: string): LiteralMismatch | undefined {
  const text = normalizeCrlf(content).text
  if (text.length === 0) return undefined
  const needle = normalizeCrlf(search).text
  const lines = text.split('\n')
  const expectedCandidates = needle.split('\n')
  const expectedLine = expectedCandidates.find(line => line.trim().length > 0) ?? expectedCandidates[0] ?? ''
  let bestLine = 0
  let bestDifference = 0
  let bestScore = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const difference = commonPrefixLength(line, expectedLine)
    const score = difference + (line.length === 0 && expectedLine.length === 0 ? 1 : 0)
    if (score > bestScore) {
      bestScore = score
      bestLine = index
      bestDifference = difference
    }
  }
  const actualLine = lines[bestLine] as string
  return {
    line: bestLine + 1,
    column: bestDifference + 1,
    expected: snippetAt(expectedLine, bestDifference),
    actual: snippetAt(actualLine, bestDifference),
  }
}

/** Render a mismatch as one model-facing clause. */
export function formatLiteralMismatch(mismatch: LiteralMismatch): string {
  return `nearest candidate is line ${mismatch.line}, column ${mismatch.column}: expected "${mismatch.expected}" but found "${mismatch.actual}"`
}
