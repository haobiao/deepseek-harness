/**
 * Display decoding of bounded process output: a cut character at either end
 * must be trimmed before detection, and bytes no charset proves must still come
 * back as readable GB18030 text instead of U+FFFD.
 */

import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { decodeOutput, decodeOutputChunk, trimPartialUtf8 } from '../src/index.ts'

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

function gbk(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, 'gbk'))
}

describe('decodeOutput', () => {
  it('reads plain ASCII and UTF-8 output as itself', () => {
    expect(decodeOutput(utf8('build ok'))).toBe('build ok')
    expect(decodeOutput(utf8('中文输出'))).toBe('中文输出')
  })

  it('reads a Windows code-page message as GBK rather than U+FFFD', () => {
    expect(decodeOutput(gbk('FIND: 参数格式不正确'))).toBe('FIND: 参数格式不正确')
  })

  it('keeps a large CJK UTF-8 buffer from being misdetected as GB18030', () => {
    const text = '美术给的那包图 '.repeat(700)
    expect(decodeOutput(utf8(text))).toBe(text)
  })

  it('trims a UTF-8 character a tail cut split', () => {
    const text = '中文测试'.repeat(64)
    const data = utf8(text)
    expect(decodeOutput(data.subarray(0, data.length - 1), { tail: true })).toBe(text.slice(0, -1))
  })

  it('trims the continuation bytes a head cut left', () => {
    const data = utf8('中文字符')
    const cutAt = 4 // inside the second character, after its lead byte
    expect(decodeOutput(data.subarray(cutAt), { head: true })).toBe('字符')
  })

  it('keeps a UTF-8 tail a writer stopped inside, when a multi-byte character proves the charset', () => {
    const text = '中文输出到此结束'
    const data = utf8(text)
    expect(decodeOutput(data.subarray(0, data.length - 2))).toBe(text.slice(0, -1))
  })

  it('does not trim an ASCII-only tail into UTF-8 proof', () => {
    // The cut leaves a valid-looking three-byte lead, but no multi-byte
    // character appeared, so the bytes are judged by their charset instead.
    expect(decodeOutput(new Uint8Array([0x61, 0x62, 0xef, 0xbb]))).not.toBe('ab')
  })

  it('judges the bytes after an ASCII-only prefix instead of dropping them', () => {
    // A cut tail leaves a partial UTF-8 lead after ASCII. Trimming back to the
    // ASCII prefix proves nothing, so the whole sample is detected again.
    const data = new Uint8Array([0x61, 0x62, 0x63, 0xe4])
    const chunk = decodeOutputChunk(data, { tail: true })
    expect(chunk.text.startsWith('abc')).toBe(true)
    expect(chunk.consumedBytes).toBe(4)
  })

  it('never throws for bytes no charset restores', () => {
    expect(() => decodeOutput(new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow()
  })

  it('reports the bytes a split tail left for the next read', () => {
    const data = utf8('中文输出')
    const split = decodeOutputChunk(data.subarray(0, 5), { tail: true })
    expect(split.text).toBe('中')
    // The second character's lead byte was not consumed.
    expect(split.consumedBytes).toBe(3)
    expect(decodeOutputChunk(data.subarray(3)).text).toBe('文输出')
    expect(decodeOutputChunk(data.subarray(3)).consumedBytes).toBe(data.length - 3)
  })

  it('counts head-trimmed bytes as consumed', () => {
    const data = utf8('中文字符')
    const chunk = decodeOutputChunk(data.subarray(4), { head: true })
    expect(chunk.text).toBe('字符')
    expect(chunk.consumedBytes).toBe(data.length - 4)
  })

  it('reports the whole-character prefix it shared with detection', () => {
    const data = utf8('中文')
    expect(trimPartialUtf8(data.subarray(0, data.length - 1)).length).toBe(data.length - 3)
  })
})
