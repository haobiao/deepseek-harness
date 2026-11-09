/**
 * Encoding detection and conversion for the local backend: the round-trip proof
 * that keeps a mis-detection from corrupting a file, the BOM, and the
 * cut-character trimming a bounded sample depends on. Fixtures are built in
 * memory so no encoded file has to be committed.
 */

import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import {
  createStreamDecoder,
  decodeText,
  detectEncoding,
  encodeText,
  UndecodableTextError,
  UnencodableTextError,
  trimPartialUtf8,
  wholeCharsetLength,
} from '../src/encoding/index.ts'

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

function gbk(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, 'gbk'))
}

function gb18030(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, 'gb18030'))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
}

describe('detectEncoding', () => {
  it('classifies empty, ASCII, and UTF-8 CJK samples as UTF-8', () => {
    expect(detectEncoding(new Uint8Array(0))).toEqual({ encoding: 'utf8', wholeLength: 0 })
    expect(detectEncoding(utf8('plain ascii'))).toEqual({ encoding: 'utf8', wholeLength: 11 })
    expect(detectEncoding(utf8('中文内容'))).toEqual({ encoding: 'utf8', wholeLength: 12 })
  })

  it('reports a UTF-8 BOM before checking the content', () => {
    const sample = concat(UTF8_BOM, utf8('中文'))
    expect(detectEncoding(sample)).toEqual({ encoding: 'utf8-bom', wholeLength: sample.length })
  })

  it('classifies GBK bytes as GB18030, which restores them identically', () => {
    const sample = gbk('国标中文 GBK')
    expect(detectEncoding(sample)).toEqual({ encoding: 'gb18030', wholeLength: sample.length })
  })

  it('classifies a four-byte GB18030 character that GBK cannot hold', () => {
    const sample = gb18030('扩展 𠀀 汉字')
    expect(detectEncoding(sample)).toEqual({ encoding: 'gb18030', wholeLength: sample.length })
  })

  it('falls back to lossy for bytes no charset restores', () => {
    const sample = new Uint8Array([0xff, 0xff, 0xff])
    expect(detectEncoding(sample)).toEqual({ encoding: 'lossy-utf8', wholeLength: 3 })
  })

  it('trims a UTF-8 character the sample cut in half', () => {
    const full = utf8('中文测试'.repeat(64))
    const detected = detectEncoding(full.subarray(0, full.length - 1), { fragment: true })
    expect(detected).toEqual({ encoding: 'utf8', wholeLength: full.length - 3 })
  })

  it('trims a GBK pair the sample cut in half', () => {
    const full = gbk('中文测试'.repeat(64))
    const detected = detectEncoding(full.subarray(0, full.length - 1), { fragment: true })
    expect(detected).toEqual({ encoding: 'gb18030', wholeLength: full.length - 2 })
  })

  it('trims a GB18030 four-byte character the sample cut in half', () => {
    const full = gb18030(`${'中文测试'.repeat(64)}𠀀`)
    const detected = detectEncoding(full.subarray(0, full.length - 2), { fragment: true })
    expect(detected).toEqual({ encoding: 'gb18030', wholeLength: full.length - 4 })
  })

  it('trims the content after a BOM but never the BOM itself', () => {
    const sample = concat(UTF8_BOM, utf8('中文').subarray(0, 2))
    expect(detectEncoding(sample, { fragment: true })).toEqual({ encoding: 'utf8-bom', wholeLength: 3 })
  })

  it('treats an unterminated four-byte lead as holding no whole character', () => {
    const sample = gb18030('𠀀').subarray(0, 3)
    expect(wholeCharsetLength(sample, 'gb18030')).toBe(0)
  })

  it('stops at a four-byte lead whose third byte closes no sequence', () => {
    expect(wholeCharsetLength(new Uint8Array([0x81, 0x30, 0x20, 0x30]), 'gb18030')).toBe(0)
  })

  it('stops at a four-byte lead whose fourth byte is not a digit', () => {
    expect(wholeCharsetLength(new Uint8Array([0x81, 0x30, 0x81, 0x40]), 'gb18030')).toBe(0)
  })

  it('counts a whole four-byte sequence before a two-byte one', () => {
    const sample = gb18030('𠀀中')
    expect(wholeCharsetLength(sample, 'gb18030')).toBe(sample.length)
  })

  it('treats a sample holding no whole character as lossy', () => {
    const sample = gb18030('𠀀').subarray(0, 3)
    expect(detectEncoding(sample, { fragment: true })).toEqual({ encoding: 'lossy-utf8', wholeLength: 3 })
  })

  it('trims a four-byte lead the sample cut in half', () => {
    expect(trimPartialUtf8(utf8('😀').subarray(0, 2))).toHaveLength(0)
  })

  it('measures a whole sample of ASCII and of two-byte sequences', () => {
    expect(wholeCharsetLength(utf8('abc'), 'gb18030')).toBe(3)
    expect(wholeCharsetLength(gbk('中文'), 'gbk')).toBe(4)
  })

  it('leaves a run of continuation bytes for the strict check to reject', () => {
    const continuation = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])
    expect(Array.from(trimPartialUtf8(continuation))).toEqual(Array.from(continuation))
  })
})

describe('decodeText', () => {
  it('decodes GBK and GB18030 text', () => {
    expect(decodeText(gbk('中文内容'), 'gbk')).toBe('中文内容')
    expect(decodeText(gb18030('扩展 𠀀'), 'gb18030')).toBe('扩展 𠀀')
  })

  it('strips the BOM it was told about', () => {
    expect(decodeText(concat(UTF8_BOM, utf8('中文')), 'utf8-bom')).toBe('中文')
  })

  it('rejects UTF-8 bytes that are invalid under a strict decoder', () => {
    expect(() => decodeText(gbk('中文'), 'utf8')).toThrow(UndecodableTextError)
  })

  it('rejects a lossy sample rather than returning replacement characters', () => {
    expect(() => decodeText(new Uint8Array([0xff]), 'lossy-utf8')).toThrow(UndecodableTextError)
  })
})

describe('encodeText', () => {
  it('encodes UTF-8 with and without a BOM', () => {
    expect(Array.from(encodeText('中文', 'utf8'))).toEqual(Array.from(utf8('中文')))
    expect(Array.from(encodeText('中文', 'utf8-bom'))).toEqual(Array.from(concat(UTF8_BOM, utf8('中文'))))
  })

  it('restores the legacy bytes it was read from', () => {
    expect(Array.from(encodeText('国标中文', 'gbk'))).toEqual(Array.from(gbk('国标中文')))
    expect(Array.from(encodeText('扩展 𠀀', 'gb18030'))).toEqual(Array.from(gb18030('扩展 𠀀')))
  })

  it('refuses a character the charset cannot represent instead of substituting it', () => {
    const failure = (() => {
      try {
        encodeText('中文😀', 'gbk')
        return undefined
      } catch (error: unknown) {
        return error
      }
    })()
    expect(failure).toBeInstanceOf(UnencodableTextError)
    expect((failure as UnencodableTextError).rune).toBe('😀')
    expect((failure as UnencodableTextError).offset).toBe(2)
    expect((failure as UnencodableTextError).encoding).toBe('gbk')
  })
})

describe('createStreamDecoder', () => {
  it('rejoins a GBK character split across chunks', () => {
    const text = '中文测试 GBK'
    const bytes = gbk(text)
    const decoder = createStreamDecoder('gb18030')
    let decoded = ''
    for (let index = 0; index < bytes.length; index += 3) {
      decoded += decoder.push(bytes.subarray(index, index + 3))
    }
    expect(decoded + decoder.end()).toBe(text)
  })

  it('rejoins a UTF-8 character split across chunks', () => {
    const text = '中文测试 UTF-8'
    const bytes = utf8(text)
    const decoder = createStreamDecoder('utf8')
    let decoded = ''
    for (let index = 0; index < bytes.length; index += 2) {
      decoded += decoder.push(bytes.subarray(index, index + 2))
    }
    expect(decoded + decoder.end()).toBe(text)
  })

  it('flushes a truncated legacy tail as a replacement character', () => {
    const decoder = createStreamDecoder('gb18030')
    const pushed = decoder.push(gbk('中文').subarray(0, 3))
    expect(pushed).toBe('中')
    expect(decoder.end()).toBe('\uFFFD')
  })

  it('rejects invalid UTF-8 mid-stream', () => {
    const decoder = createStreamDecoder('utf8')
    expect(() => decoder.push(gbk('中文'))).toThrow(UndecodableTextError)
  })

  it('refuses to stream a lossy sample', () => {
    expect(() => createStreamDecoder('lossy-utf8')).toThrow(UndecodableTextError)
  })

  it('rejects a truncated UTF-8 tail when the stream ends', () => {
    const decoder = createStreamDecoder('utf8')
    expect(decoder.push(new Uint8Array([0xe4, 0xb8]))).toBe('')
    expect(() => decoder.end()).toThrow(UndecodableTextError)
  })
})

describe('round trip', () => {
  it('re-encodes every detected sample byte for byte', () => {
    const samples = [
      utf8('plain ascii'),
      utf8('中文 UTF-8'),
      concat(UTF8_BOM, utf8('bom 中文')),
      gbk('国标 GBK 中文'),
      gb18030('扩展 𠀀 汉字'),
    ]
    for (const sample of samples) {
      const { encoding } = detectEncoding(sample)
      const restored = encodeText(decodeText(sample, encoding), encoding)
      expect({ encoding, bytes: Array.from(restored) }).toEqual({ encoding, bytes: Array.from(sample) })
    }
  })
})
