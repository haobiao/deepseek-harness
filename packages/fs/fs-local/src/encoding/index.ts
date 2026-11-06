/**
 * Text-encoding support for the local backend: detect what a stored file is
 * written in, decode it to text, and encode an edit back into the same bytes.
 * Kept free of `node:fs` so detection and conversion stay testable on their own.
 * @module @deepseek-ai/dsh-fs-local/encoding
 */

export { isValidUtf8, trimPartialUtf8, wholeCharsetLength } from './boundaries.ts'
export type { ByteView, LegacyCharset } from './boundaries.ts'
export { asBuffer, detectEncoding, roundTrips, startsWithUtf8Bom } from './detect.ts'
export { createStreamDecoder, decodeText, encodeText } from './codec.ts'
export type { StreamDecoder } from './codec.ts'
export { UndecodableTextError, UnencodableTextError } from './types.ts'
export type { DetectedTextEncoding, TextEncoding } from './types.ts'
