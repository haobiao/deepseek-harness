/**
 * Unit tests for model-facing guarded-mutation diagnostics: normalized unread
 * failures, the stale-version and encoding remedies, code preservation, and
 * passthrough.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { remediateFsError } from '../src/error.ts'

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original, 'x')
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('normalizes policy and provider FS_NOT_OBSERVED failures to one diagnostic', () => {
    const sources = [
      new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED'),
      new FsError('cannot overwrite existing "x" without reading it first', 'FS_NOT_OBSERVED'),
    ]
    const remedied = sources.map(error => remediateFsError(error, 'x'))
    expect(remedied.map(error => error.message)).toEqual([
      'cannot modify "x": file has not been read — read the file, then retry',
      'cannot modify "x": file has not been read — read the file, then retry',
    ])
    expect(remedied.map(error => error.code)).toEqual(['FS_NOT_OBSERVED', 'FS_NOT_OBSERVED'])
    expect(remedied.map(error => error.cause)).toEqual(sources)
  })

  it('appends the encoding remedy to FS_NOT_ENCODABLE, keeping the character the reason', () => {
    const original = new FsError(
      'cannot write "x": "😀" (U+1F600) at character offset 2 cannot be represented in GBK, the file\'s encoding',
      'FS_NOT_ENCODABLE',
    )
    const remedied = remediateFsError(original, 'x')
    expect(remedied.code).toBe('FS_NOT_ENCODABLE')
    expect(remedied.cause).toBe(original)
    expect(remedied.message).toBe(`${original.message} — this file's encoding cannot represent the text; write it to a new file, or convert the file's encoding first`)
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('no match anywhere', 'FS_EDIT_NOT_FOUND')
    expect(remediateFsError(original, 'x')).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original, 'x')).toBe(original)
  })
})
