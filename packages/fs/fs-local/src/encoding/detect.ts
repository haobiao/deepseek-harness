/**
 * Encoding detection for a byte sample: BOM, then strict UTF-8, then the legacy
 * Chinese charsets by byte-for-byte round trip. Detection never guesses from
 * plausibility — a legacy decoder replaces bytes it cannot read with U+FFFD, so
 * only a decode-then-encode that restores the sample proves the charset.
 * @module @deepseek-ai/dsh-fs-local/encoding/detect
 */

import iconv from 'iconv-lite'
import { isValidUtf8, trimPartialUtf8, wholeCharsetLength } from './boundaries.ts'
import type { LegacyCharset } from './boundaries.ts'
import type { DetectedTextEncoding } from './types.ts'

/**
 * Legacy charsets in preference order. GB18030 first because it is a GBK
 * superset: it round-trips every GBK byte except CP936's own exceptions, such as
 * the single-byte 0x80 euro, which only GBK restores.
 */
const LEGACY_CHARSETS: readonly LegacyCharset[] = ['gb18030', 'gbk']

const UTF8_BOM_LENGTH = 3
const UTF8_BOM_FIRST = 0xef
const UTF8_BOM_SECOND = 0xbb
const UTF8_BOM_THIRD = 0xbf

/** Whether the sample opens with the UTF-8 BOM. */
export function startsWithUtf8Bom(data: Uint8Array): boolean {
  return data.length >= UTF8_BOM_LENGTH
    && data[0] === UTF8_BOM_FIRST
    && data[1] === UTF8_BOM_SECOND
    && data[2] === UTF8_BOM_THIRD
}

/** A view over `data` as a Buffer, without copying when it already is one. */
export function asBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Whether `data` decodes in `charset` and re-encodes to the same bytes.
 * A pure decode is no signal: the decoder turns an invalid sequence into U+FFFD,
 * which encodes back as different bytes.
 */
export function roundTrips(data: Uint8Array, charset: LegacyCharset): boolean {
  if (data.length === 0) return false
  const text = iconv.decode(asBuffer(data), charset)
  return bytesEqual(iconv.encode(text, charset), data)
}

/**
 * Detect the encoding of a byte sample.
 *
 * Ordering matters more than the checks themselves. UTF-8 comes before the
 * legacy charsets because ASCII and CJK UTF-8 are also valid GB18030 byte
 * strings, so a legacy-first order would mislabel every UTF-8 file. The BOM case
 * comes first because it is proof, not plausibility.
 * @param data - the bytes to classify; an empty sample is plain UTF-8.
 * @param options - `fragment` marks a bounded sample of a longer file, so a
 *   character cut at the tail is trimmed instead of read as proof against the
 *   encoding.
 * @returns the encoding and the length of the leading whole-character prefix
 *   the decision covers.
 */
export function detectEncoding(data: Uint8Array, options: { fragment?: boolean } = {}): DetectedTextEncoding {
  const fragment = options.fragment === true
  if (startsWithUtf8Bom(data)) {
    // The BOM is whole by construction; the content after it can still be cut.
    return { encoding: 'utf8-bom', wholeLength: fragment ? trimPartialUtf8(data).length : data.length }
  }
  const utf8Whole = fragment ? trimPartialUtf8(data) : data
  if (isValidUtf8(utf8Whole)) return { encoding: 'utf8', wholeLength: utf8Whole.length }
  for (const charset of LEGACY_CHARSETS) {
    const length = fragment ? wholeCharsetLength(data, charset) : data.length
    if (roundTrips(data.subarray(0, length), charset)) {
      return { encoding: charset, wholeLength: length }
    }
  }
  return { encoding: 'lossy-utf8', wholeLength: data.length }
}
