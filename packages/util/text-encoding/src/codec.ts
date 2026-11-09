/**
 * Byte-level text conversion for the local backend: decode a detected encoding
 * into a JavaScript string, encode a string back under a file's own encoding,
 * and stream both without ever splitting a character across chunks.
 * @module @deepseek-ai/dsh-text-encoding/codec
 */

import iconv from 'iconv-lite'
import { wholeCharsetLength } from './boundaries.ts'
import type { LegacyCharset } from './boundaries.ts'
import { asBuffer, detectEncoding } from './detect.ts'
import { UndecodableTextError, UnencodableTextError } from './types.ts'
import type { TextEncoding } from './types.ts'

const UTF8_BOM_BYTES: readonly number[] = [0xef, 0xbb, 0xbf]
const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function isLegacy(encoding: TextEncoding): encoding is LegacyCharset {
  return encoding === 'gb18030' || encoding === 'gbk'
}

/**
 * Strict UTF-8 decode: invalid bytes fail instead of becoming U+FFFD, so a
 * sample that read as UTF-8 only because its head was ASCII refuses the file
 * rather than returning mangled text the caller would write back.
 */
function decodeStrictUtf8(data: Uint8Array): string {
  try {
    return utf8Strict.decode(data)
  } catch {
    throw new UndecodableTextError('bytes are not valid UTF-8')
  }
}

/**
 * Convert stored bytes to a JavaScript string.
 * @param data - the file bytes, BOM included when the encoding says so.
 * @param encoding - the encoding {@link detectEncoding} chose for these bytes.
 * @returns the decoded text, without a BOM.
 * @throws UndecodableTextError when the bytes do not decode: invalid UTF-8, or a
 *   file no charset restores.
 */
export function decodeText(data: Uint8Array, encoding: TextEncoding): string {
  switch (encoding) {
    case 'utf8':
      return decodeStrictUtf8(data)
    case 'utf8-bom':
      return decodeStrictUtf8(data.subarray(Math.min(UTF8_BOM_BYTES.length, data.length)))
    case 'gb18030':
    case 'gbk':
      return iconv.decode(asBuffer(data), encoding)
    case 'lossy-utf8':
      throw new UndecodableTextError('bytes are neither valid UTF-8 nor restorable by a supported charset')
  }
}

/**
 * Convert text back to stored bytes under a file's own encoding.
 * @param text - the text to store, already in its final line-ending style.
 * @param encoding - the encoding the file was read under.
 * @returns the encoded bytes, with a BOM when the encoding carries one.
 * @throws UnencodableTextError when a legacy charset cannot represent a
 *   character; the write must fail rather than change the file's encoding.
 */
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8':
    case 'lossy-utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8-bom':
      return Buffer.concat([Buffer.from(UTF8_BOM_BYTES), Buffer.from(text, 'utf8')])
    case 'gb18030':
    case 'gbk':
      return encodeLegacy(text, encoding)
  }
}

/**
 * Encode under a legacy charset, proving the result by decoding it back.
 * `iconv-lite` encodes an unrepresentable character as a substitute byte instead
 * of failing, so the round trip is the only way to tell a faithful write from a
 * corrupting one.
 */
function encodeLegacy(text: string, encoding: LegacyCharset): Buffer {
  const bytes = iconv.encode(text, encoding)
  const restored = iconv.decode(bytes, encoding)
  if (restored === text) return bytes
  let offset = 0
  while (offset < text.length && text.charCodeAt(offset) === restored.charCodeAt(offset)) offset += 1
  const at = Math.min(offset, Math.max(0, text.length - 1))
  /* v8 ignore next -- `at` indexes a character that exists; only `noUncheckedIndexedAccess` types the read as optional. */
  const codePoint = text.codePointAt(at) ?? 0
  throw new UnencodableTextError(encoding, String.fromCodePoint(codePoint), at)
}

/** One incrementally-fed decoder: `push` per byte chunk, `end` once at EOF. */
export interface StreamDecoder {
  /** Decode the next chunk, holding back a trailing partial character. */
  push(chunk: Uint8Array): string
  /** Decode whatever the last chunk held back; a truncated tail becomes U+FFFD. */
  end(): string
}

/** Decoder for a charset whose sequences are self-delimiting: hold back the partial tail. */
function legacyStreamDecoder(charset: LegacyCharset): StreamDecoder {
  let carry: Uint8Array = new Uint8Array(0)
  return {
    push(chunk: Uint8Array): string {
      const data = carry.length === 0 ? chunk : Buffer.concat([asBuffer(carry), asBuffer(chunk)])
      const whole = wholeCharsetLength(data, charset)
      carry = data.subarray(whole)
      return whole === 0 ? '' : iconv.decode(asBuffer(data.subarray(0, whole)), charset)
    },
    end(): string {
      const rest = carry
      carry = new Uint8Array(0)
      return rest.length === 0 ? '' : iconv.decode(asBuffer(rest), charset)
    },
  }
}

/**
 * Create a decoder safe to feed in arbitrary byte chunks.
 *
 * A UTF-8 BOM is the caller's to strip: the read path detects the BOM on the
 * head sample and decodes that head through {@link decodeText}, so the stream
 * that follows never starts with one.
 * @param encoding - the encoding {@link detectEncoding} chose for the file.
 * @returns the chunk decoder; `end()` flushes a held-back partial character.
 * @throws UndecodableTextError for `lossy-utf8`, which cannot be streamed.
 */
export function createStreamDecoder(encoding: TextEncoding): StreamDecoder {
  if (isLegacy(encoding)) return legacyStreamDecoder(encoding)
  if (encoding === 'lossy-utf8') {
    throw new UndecodableTextError('bytes are neither valid UTF-8 nor restorable by a supported charset')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return {
    push(chunk: Uint8Array): string {
      try {
        return decoder.decode(chunk, { stream: true })
      } catch {
        throw new UndecodableTextError('bytes are not valid UTF-8')
      }
    },
    end(): string {
      try {
        return decoder.decode()
      } catch {
        throw new UndecodableTextError('bytes are not valid UTF-8')
      }
    },
  }
}

/** Bytes that may accumulate while the charset is still unproven. */
const AUTO_SNIFF_LIMIT_BYTES = 4096

/** Whether `data` holds a non-ASCII byte, so its decode proves the charset rather than ASCII passing through. */
function hasNonAscii(data: Uint8Array): boolean {
  return data.some(byte => byte >= 0x80)
}

/**
 * Create a decoder for a live byte stream whose charset is not known in
 * advance — a Windows console's stdout, which answers in the machine's code
 * page rather than UTF-8.
 *
 * ASCII is emitted immediately: it reads the same under every supported
 * charset, so waiting for proof would only delay a prompt. The first
 * multi-byte character decides the charset: a valid UTF-8 sequence selects
 * UTF-8, otherwise the bytes are read as GB18030, the superset a Chinese
 * Windows console emits. Bytes held back from an inconclusive tail are fed to
 * the chosen decoder, so no character is lost at the switch.
 * @returns the sniffing chunk decoder; `end()` flushes what is still held.
 */
export function createAutoStreamDecoder(): StreamDecoder {
  let pending: Buffer = Buffer.alloc(0)
  let inner: StreamDecoder | undefined

  const adopt = (encoding: TextEncoding): string => {
    if (encoding === 'utf8-bom') {
      // A display stream keeps its BOM visible; the strict UTF-8 decoder would
      // swallow it as a byte-order mark.
      inner = createStreamDecoder('utf8')
      const body = pending.subarray(UTF8_BOM_BYTES.length)
      pending = Buffer.alloc(0)
      return '\uFEFF' + inner.push(body)
    }
    const normalized: TextEncoding = encoding === 'lossy-utf8' ? 'gb18030' : encoding
    inner = createStreamDecoder(normalized)
    const text = inner.push(pending)
    pending = Buffer.alloc(0)
    return text
  }

  return {
    push(chunk: Uint8Array): string {
      if (inner !== undefined) return inner.push(chunk)
      pending = pending.length === 0 ? asBuffer(chunk) : Buffer.concat([pending, asBuffer(chunk)])
      const detected = detectEncoding(pending, { fragment: true })
      if (detected.encoding === 'utf8') {
        if (!hasNonAscii(pending.subarray(0, detected.wholeLength)) && pending.length <= AUTO_SNIFF_LIMIT_BYTES) {
          // The whole-character prefix is ASCII, so the non-ASCII tail is a
          // character still arriving: emit the proof and keep the rest.
          const whole = pending.subarray(0, detected.wholeLength)
          pending = pending.subarray(detected.wholeLength)
          return whole.toString('utf8')
        }
        return adopt('utf8')
      }
      return adopt(detected.encoding)
    },
    end(): string {
      if (inner !== undefined) return inner.end()
      const rest = pending.toString('utf8')
      pending = Buffer.alloc(0)
      return rest
    },
  }
}
