/**
 * Character boundaries for a byte sample: where a bounded window stops holding
 * whole characters. Both detection and streaming need this, because a sample cut
 * inside a character otherwise reads as invalid text for the encoding it is
 * actually in.
 * @module @deepseek-ai/dsh-fs-local/encoding/boundaries
 */

/** Longest UTF-8 sequence a leading byte can declare. */
const UTF8_MAX_BYTES = 4

/** A dual-charset whose sequences `wholeCharsetLength` can measure. */
export type LegacyCharset = 'gb18030' | 'gbk'

const utf8Probe = new TextDecoder('utf-8', { fatal: true })

/**
 * One byte of the sample, or `-1` past its end. The sentinel keeps an absent
 * trail byte distinct from a real `0x00` and spares every read a bounds branch
 * of its own.
 */
function byteAt(data: Uint8Array, index: number): number {
  if (index >= data.length) return -1
  /* v8 ignore next -- the guard above proves the element exists; only `noUncheckedIndexedAccess` types the read as optional. */
  return data[index] ?? -1
}

/**
 * Whether `data` is valid UTF-8. Uses the strict decoder the read path also enforces.
 * @param data - the bytes to validate.
 * @returns whether the whole sample decodes as UTF-8.
 */
export function isValidUtf8(data: Uint8Array): boolean {
  try {
    utf8Probe.decode(data)
    return true
  } catch {
    return false
  }
}

/** The sequence length the leading byte of a UTF-8 character declares. */
function utf8SequenceLength(lead: number): number {
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 1
}

/**
 * Drop a trailing UTF-8 sequence a bounded sample cut in half.
 *
 * Without this the cut byte fails the strict check, and GB18030 — which accepts
 * almost any byte string — wins over CJK text, where most bytes are
 * continuation bytes, so a fixed window lands mid-character about two times in
 * three and the whole file decodes as the wrong charset.
 * @param data - the byte sample, possibly ending mid-character.
 * @returns the prefix that holds only whole UTF-8 characters.
 */
export function trimPartialUtf8(data: Uint8Array): Uint8Array {
  for (let index = data.length - 1; index >= 0 && data.length - index < UTF8_MAX_BYTES + 1; index -= 1) {
    const lead = byteAt(data, index)
    if ((lead & 0xc0) === 0x80) continue
    return utf8SequenceLength(lead) > data.length - index ? data.subarray(0, index) : data
  }
  return data
}

/**
 * Length of the prefix of `data` that holds whole charset sequences.
 *
 * GB18030 reuses the GBK two-byte space and adds a four-byte space, so the two
 * charsets disagree only on how many bytes a leading byte commits to: a lead
 * followed by `0x30`–`0x39` opens a four-byte sequence in GB18030 and an
 * ordinary two-byte sequence in GBK. Bytes the charset would reject are left in
 * the prefix, where the caller's round-trip check fails on them as intended.
 * @param data - the byte sample, possibly ending mid-character.
 * @param charset - the dual-charset whose sequence shapes decide the boundary.
 * @returns the length of the prefix that holds whole charset sequences.
 */
export function wholeCharsetLength(data: Uint8Array, charset: LegacyCharset): number {
  let index = 0
  while (index < data.length) {
    const lead = byteAt(data, index)
    // ASCII, the CP936 single-byte euro (0x80), and 0xFF are one byte each.
    if (lead < 0x81 || lead > 0xfe) {
      index += 1
      continue
    }
    const trail = byteAt(data, index + 1)
    if (charset === 'gb18030' && trail >= 0x30 && trail <= 0x39) {
      const third = byteAt(data, index + 2)
      const fourth = byteAt(data, index + 3)
      if (third >= 0x81 && third <= 0xfe && fourth >= 0x30 && fourth <= 0x39) {
        index += 4
        continue
      }
      // A four-byte lead without its full shape: stop so the prefix stays decodable.
      return index
    }
    if (trail < 0) return index
    index += 2
  }
  return data.length
}
