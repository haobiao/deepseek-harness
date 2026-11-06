/**
 * Byte-level text conversion for the local backend: decode a detected encoding
 * into a JavaScript string, encode a string back under a file's own encoding,
 * and stream both without ever splitting a character across chunks.
 * @module @deepseek-ai/dsh-fs-local/encoding/codec
 */

import iconv from 'iconv-lite'
import { wholeCharsetLength } from './boundaries.ts'
import type { ByteView, LegacyCharset } from './boundaries.ts'
import { asBuffer } from './detect.ts'
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
function decodeStrictUtf8(data: ByteView): string {
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
export function decodeText(data: ByteView, encoding: TextEncoding): string {
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
  throw new UnencodableTextError(encoding, String.fromCodePoint(text.codePointAt(at) ?? 0), at)
}

/** One incrementally-fed decoder: `push` per byte chunk, `end` once at EOF. */
export interface StreamDecoder {
  /** Decode the next chunk, holding back a trailing partial character. */
  push(chunk: ByteView): string
  /** Decode whatever the last chunk held back; a truncated tail becomes U+FFFD. */
  end(): string
}

/** Decoder for a charset whose sequences are self-delimiting: hold back the partial tail. */
function legacyStreamDecoder(charset: LegacyCharset): StreamDecoder {
  let carry: ByteView = new Uint8Array(0)
  return {
    push(chunk: ByteView): string {
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
    push(chunk: ByteView): string {
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
