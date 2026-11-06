/**
 * Encoding vocabulary for the local backend's text reads and writes: which
 * encodings a stored file may use, what a bounded detection sample decided, and
 * the two failures that decide whether a read or a write may proceed.
 * @module @deepseek-ai/dsh-fs-local/encoding/types
 */

/**
 * A text encoding the local backend can read, and — excepting `lossy-utf8` —
 * write back without changing the file's bytes outside the edited region.
 *
 * A GBK file is reported as `gb18030` whenever the two charsets decode and
 * re-encode it identically, which is the common case: GBK is a subset of
 * GB18030 and they share one code assignment for CJK text. Only bytes GB18030
 * cannot reproduce keep `gbk` (CP936's single-byte `0x80` euro, for one).
 * Writing back under either name restores the same bytes, so the distinction
 * affects reporting, never fidelity.
 *
 * `lossy-utf8` is neither valid UTF-8 nor restorable by a supported charset. A
 * JavaScript string cannot carry those bytes the way a Go string can, so this
 * backend keeps such files read-refusing and write-replacing rather than
 * passing mangled text back to disk.
 */
export type TextEncoding = 'utf8' | 'utf8-bom' | 'gb18030' | 'gbk' | 'lossy-utf8'

/** The encoding chosen for a byte sample, plus the prefix the decision covers. */
export interface DetectedTextEncoding {
  /** The encoding the sample decodes and re-encodes from byte for byte. */
  encoding: TextEncoding
  /**
   * Length of the prefix holding whole characters. A bounded sample can end
   * inside a multi-byte character; the bytes after `wholeLength` belong to a
   * character whose remaining bytes lie beyond the sample, so the caller
   * decodes `[0, wholeLength)` and hands the rest to the following stream.
   */
  wholeLength: number
}

/**
 * A write whose text holds a character the file's encoding cannot represent.
 * The alternative — silently transcoding the file to UTF-8, or writing a
 * replacement byte — would corrupt a legacy file on an edit that only touched
 * one line, so the write is refused instead.
 */
export class UnencodableTextError extends Error {
  /** The charset that cannot represent {@link rune}. */
  readonly encoding: TextEncoding
  /** The first character the charset cannot represent. */
  readonly rune: string
  /** Offset of {@link rune} in the text, counted in UTF-16 code units. */
  readonly offset: number

  constructor(encoding: TextEncoding, rune: string, offset: number) {
    super(`"${rune}" (${formatCodePoint(rune)}) at character offset ${offset} cannot be represented in ${encoding.toUpperCase()}, the file's encoding`)
    this.name = 'UnencodableTextError'
    this.encoding = encoding
    this.rune = rune
    this.offset = offset
  }
}

/**
 * Bytes that are neither valid UTF-8 nor restorable by a supported charset, or
 * a truncated trailing sequence the caller asked to decode anyway.
 */
export class UndecodableTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UndecodableTextError'
  }
}

/** `U+XXXX` for the first code point of `rune`, for a diagnostic the model can act on. */
function formatCodePoint(rune: string): string {
  return `U+${(rune.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}
