/**
 * Display decoding for bytes that are only shown, never written back: a
 * subprocess's stdout/stderr captured into a bounded buffer. The buffer bound
 * can drop bytes from either end, so a character cut there must be trimmed
 * before the sample is judged, and bytes no charset proves are still read as
 * GB18030 rather than replaced with U+FFFD.
 * @module @deepseek-ai/dsh-text-encoding/output
 */

import iconv from 'iconv-lite'
import { isValidUtf8, trimPartialUtf8 } from './boundaries.ts'
import { asBuffer, detectEncoding } from './detect.ts'
import type { DetectedTextEncoding } from './types.ts'

/**
 * Which ends of a bounded buffer lost bytes to its bound. Only a cut end can
 * hold part of a character; an uncut end is where the output began or ended, so
 * a byte there belongs to it, such as half of a GBK pair.
 */
export interface Cut {
  /** Bytes before the buffer were dropped. */
  head?: boolean
  /** Bytes after the buffer were dropped. */
  tail?: boolean
}

/** One decoded display sample and the stream bytes it consumed. */
export interface DecodedOutputChunk {
  /** Decoded display text. */
  text: string
  /**
   * Stream bytes from the start of the supplied sample through the last one the
   * text covers. A cut tail that split a character leaves that character's
   * trailing bytes out, so a streaming caller can resume reading from here
   * instead of losing them.
   */
  consumedBytes: number
}

/** The count of leading continuation bytes a head cut left in the sample. */
function headTrimLength(data: Uint8Array, cut: Cut): number {
  if (cut.head !== true) return 0
  let start = 0
  // At most three continuation bytes fit in one UTF-8 sequence's tail.
  while (start < 3 && start < data.length) {
    if (((data[start] as number) & 0xc0) !== 0x80) break
    start += 1
  }
  return start
}

/** Whether `data` holds a non-ASCII byte, so a valid decode proves a multi-byte character appeared. */
function hasMultiByteUtf8(data: Uint8Array): boolean {
  return data.some(byte => byte >= 0x80)
}

/** A Buffer view over `data`, sharing its backing store. */
function utf8Text(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
}

/** Decode a detected sample under its charset, honoring the detected whole-character length. */
function decodeDetected(body: Uint8Array, start: number, detected: DetectedTextEncoding): DecodedOutputChunk {
  const whole = body.subarray(0, detected.wholeLength)
  switch (detected.encoding) {
    /* v8 ignore next 2 -- valid UTF-8 returned above, before detection; the switch still needs it to be exhaustive. */
    case 'utf8':
      return { text: utf8Text(whole), consumedBytes: start + whole.length }
    /* v8 ignore next 2 -- a BOM-prefixed sample returned above, before detection; the switch still needs it to be exhaustive. */
    case 'utf8-bom':
      return { text: utf8Text(whole.subarray(3)), consumedBytes: start + whole.length }
    case 'gb18030':
    case 'gbk':
      return { text: iconv.decode(asBuffer(whole), detected.encoding), consumedBytes: start + whole.length }
    case 'lossy-utf8':
      // A cut can split a code-page character anywhere, so a sample no charset
      // proves is still most likely a Windows code page, not arbitrary bytes.
      // Nothing can be held back for a next read when the charset is unknown.
      return { text: iconv.decode(asBuffer(body), 'gb18030'), consumedBytes: start + body.length }
  }
}

/**
 * Read bytes that are only displayed, never written back — process output, a
 * listing captured through a pipe — as text, reporting how much of the sample
 * the text consumed.
 *
 * Unlike {@link decodeText}, this never throws: it must produce something a
 * model can read even for bytes no charset proves, because the only alternative
 * is U+FFFD where the child actually said something. A cut end is trimmed first,
 * so a bounded window that ends inside a character is not mistaken for a legacy
 * charset (over CJK UTF-8 text a fixed window lands mid-character about two
 * times in three).
 * @param data - the captured bytes.
 * @param cut - which ends of `data` the buffer bound cut.
 * @returns the display text and the number of leading bytes it consumed.
 */
export function decodeOutputChunk(data: Uint8Array, cut: Cut = {}): DecodedOutputChunk {
  const start = headTrimLength(data, cut)
  const body = data.subarray(start)
  // A process stopped mid-write ends inside a character no bound cut. That is
  // still UTF-8 when it is the only invalid part and a multi-byte character
  // already appeared; ASCII alone proves nothing.
  const whole = trimPartialUtf8(body)
  if (whole.length === body.length && isValidUtf8(body)) {
    return { text: utf8Text(body), consumedBytes: start + body.length }
  }
  if (whole.length < body.length && isValidUtf8(whole) && hasMultiByteUtf8(whole)) {
    return { text: utf8Text(whole), consumedBytes: start + whole.length }
  }
  let detected = detectEncoding(body, { fragment: cut.tail === true })
  if (detected.encoding === 'utf8') {
    // Every valid-UTF-8 shape that proves the charset returned above, so only an
    // ASCII-only prefix reaches here. Trimming back to ASCII alone is not UTF-8
    // proof: the bytes past it are judged on their own charset instead of being
    // dropped.
    detected = detectEncoding(body)
  }
  return decodeDetected(body, start, detected)
}

/**
 * Read bytes that are only displayed, never written back as text.
 * @param data - the captured bytes.
 * @param cut - which ends of `data` the buffer bound cut.
 * @returns the display text.
 */
export function decodeOutput(data: Uint8Array, cut: Cut = {}): string {
  return decodeOutputChunk(data, cut).text
}
