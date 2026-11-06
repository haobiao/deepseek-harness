/**
 * Legacy-encoding behaviour of the local backend's file operations: reading a
 * GBK file as text, keeping its bytes across an edit or overwrite, refusing a
 * character the charset cannot hold, and the strict-UTF-8 switch that restores
 * the previous behaviour. Fixtures are encoded in memory so no legacy file has
 * to be committed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import {
  readFileEncoding,
  readForEdit,
  readTextForDiff,
  readWholeText,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from '../src/fsio.ts'
import type { LocalTarget, TextEncodingOptions } from '../src/fsio.ts'

const STRICT_UTF8: TextEncodingOptions = { detectLegacy: false, sampleBytes: 0 }

let dir: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-encoding-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

function gbk(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, 'gbk'))
}

const localTarget = (path: string): LocalTarget => ({ displayPath: path, targetKey: FsTargetKey(path) })

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of chunks) text += chunk
  return text
}

describe('readWholeText', () => {
  it('decodes a GBK file into the text a UTF-8 file would hold', async () => {
    const path = join(dir, 'gbk.txt')
    await writeFile(path, gbk('第一行\n第二行'))
    expect(await readWholeText(localTarget(path))).toBe('第一行\n第二行')
  })

  it('refuses a GBK file when legacy detection is off', async () => {
    const path = join(dir, 'gbk.txt')
    await writeFile(path, gbk('中文'))
    await expect(readWholeText(localTarget(path), undefined, STRICT_UTF8))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('retries detection over the whole file when the head sample is ASCII', async () => {
    const path = join(dir, 'late-gbk.txt')
    await writeFile(path, Buffer.concat([Buffer.from('a'.repeat(64), 'ascii'), Buffer.from(gbk('中文'))]))
    const options: TextEncodingOptions = { detectLegacy: true, sampleBytes: 16 }
    expect(await readWholeText(localTarget(path), undefined, options)).toBe(`${'a'.repeat(64)}中文`)
  })

  it('still rejects a file no charset restores', async () => {
    const path = join(dir, 'broken.txt')
    await writeFile(path, Buffer.from([0x68, 0xff, 0x69]))
    await expect(readWholeText(localTarget(path))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects a file whose ASCII head hides an undecodable tail', async () => {
    const path = join(dir, 'late-broken.txt')
    await writeFile(path, Buffer.concat([Buffer.from('a'.repeat(64), 'ascii'), Buffer.from([0xff, 0xff])]))
    const options: TextEncodingOptions = { detectLegacy: true, sampleBytes: 16 }
    await expect(readWholeText(localTarget(path), undefined, options))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })
})

describe('streamWholeText', () => {
  it('streams a GBK file across the head sample boundary', async () => {
    const path = join(dir, 'gbk.txt')
    const text = '中文测试\n'.repeat(2000)
    await writeFile(path, gbk(text))
    const options: TextEncodingOptions = { detectLegacy: true, sampleBytes: 64 }
    expect(await collect(streamWholeText(localTarget(path), undefined, options))).toBe(text)
  })

  it('decodes a GBK file that fits inside the sample', async () => {
    const path = join(dir, 'small.txt')
    const text = '中文测试'
    await writeFile(path, gbk(text))
    expect(await collect(streamWholeText(localTarget(path)))).toBe(text)
  })

  it('refuses a GBK file when legacy detection is off', async () => {
    const path = join(dir, 'gbk.txt')
    await writeFile(path, gbk('中文'))
    await expect(collect(streamWholeText(localTarget(path), undefined, STRICT_UTF8)))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })
})

describe('edit write-back', () => {
  it('reports the encoding and restores the original GBK bytes after an edit', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, gbk('第一行\r\n第二行'))
    const original = await readForEdit(path, path)
    expect(original.encoding).toBe('gb18030')
    expect(original.lineEndings).toBe('CRLF')
    expect(original.content).toBe('第一行\n第二行')

    const edited = original.content.replace('第二行', '改后')
    await writeFileAtomic(path, restoreLineEndings(edited, original.lineEndings), 0o644, undefined, {},
      { encoding: original.encoding })
    expect(new Uint8Array(await readFile(path))).toEqual(gbk('第一行\r\n改后'))
  })

  it('refuses a character the charset cannot hold and leaves the file untouched', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, gbk('原文'))
    await expect(writeFileAtomic(path, '表情😀', 0o644, undefined, {}, { encoding: 'gbk' }))
      .rejects.toMatchObject({ code: 'FS_NOT_ENCODABLE' })
    expect(new Uint8Array(await readFile(path))).toEqual(gbk('原文'))
  })
})

describe('readTextForDiff', () => {
  it('decodes a GBK prior file instead of declining the diff basis', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, gbk('第一行\r\n第二行'))
    expect(await readTextForDiff(path, 4096)).toBe('第一行\n第二行')
  })

  it('declines a legacy prior file when detection is off', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, gbk('中文'))
    expect(await readTextForDiff(path, 4096, undefined, STRICT_UTF8)).toBeNull()
  })
})

describe('readFileEncoding', () => {
  it('reads the encoding of an existing file without decoding it', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, gbk('中文'))
    expect(await readFileEncoding(path)).toBe('gb18030')
  })

  it('decides from a bounded sample of a file larger than the sample', async () => {
    const path = join(dir, 'big.txt')
    await writeFile(path, gbk('中文测试'.repeat(200)))
    expect(await readFileEncoding(path, { detectLegacy: true, sampleBytes: 32 })).toBe('gb18030')
  })

  it('keeps UTF-8 for a file no charset restores, which a write replaces wholesale', async () => {
    const path = join(dir, 'broken.txt')
    await writeFile(path, Buffer.from([0x68, 0xff, 0x69]))
    expect(await readFileEncoding(path)).toBe('utf8')
  })

  it('falls back to UTF-8 when the file cannot be sampled', async () => {
    expect(await readFileEncoding(join(dir, 'missing.txt'))).toBe('utf8')
  })
})

describe('LocalFileSystem encoding plumbing', () => {
  it('keeps a GBK file in GBK when write replaces it, and reports the prior text', async () => {
    await writeFile(join(dir, 'a.txt'), gbk('旧内容\n第二行'))
    const target = await fs.resolve('a.txt')
    const outcome = await fs.writeText(target, '新内容\n第二行')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBe('旧内容\n第二行')
    expect(new Uint8Array(await readFile(join(dir, 'a.txt')))).toEqual(gbk('新内容\n第二行'))
  })

  it('keeps a GBK file in GBK when edit replaces literal text', async () => {
    await writeFile(join(dir, 'a.txt'), gbk('第一行\r\n第二行'))
    const target = await fs.resolve('a.txt')
    const info = await fs.stat(target)
    if (info === undefined) throw new Error('expected target to exist')
    const outcome = await fs.editText(
      target,
      { oldString: '第二行', newString: '改后', replaceAll: false },
      { version: info.version },
    )
    expect(outcome.after).toBe('第一行\n改后')
    expect(new Uint8Array(await readFile(join(dir, 'a.txt')))).toEqual(gbk('第一行\r\n改后'))
  })

  it('writes a new file as UTF-8', async () => {
    const target = await fs.resolve('new.txt')
    await fs.writeText(target, '新内容')
    expect(new Uint8Array(await readFile(join(dir, 'new.txt')))).toEqual(new Uint8Array(Buffer.from('新内容', 'utf8')))
  })

  it('refuses a GBK file for every read when legacyEncodings is off', async () => {
    await fiber.dispose()
    fiber = await ctx.plugin(LocalFileSystem, { cwd: dir, legacyEncodings: false })
    fs = ctx.fs as LocalFileSystem
    await writeFile(join(dir, 'a.txt'), gbk('中文'))
    await expect(fs.readText(await fs.resolve('a.txt'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('rejects an out-of-range encoding sample', async () => {
    const bare = new Context()
    const mount = async (): Promise<void> => { await bare.plugin(LocalFileSystem, { encodingSampleBytes: 0 }) }
    await expect(mount()).rejects.toThrow(/encodingSampleBytes/u)
  })
})
