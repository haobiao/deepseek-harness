/**
 * Text-encoding support shared by filesystem backends and text consumers:
 * detect what stored bytes are written in, decode them to text, and encode an
 * edit back into the same bytes. Kept free of `node:fs` so detection and
 * conversion stay testable on their own.
 * @module @deepseek-ai/dsh-text-encoding
 */

export { isValidUtf8, trimPartialUtf8, wholeCharsetLength } from './boundaries.ts'
export type { LegacyCharset } from './boundaries.ts'
export { asBuffer, detectEncoding, roundTrips, startsWithUtf8Bom } from './detect.ts'
export { createAutoStreamDecoder, createStreamDecoder, decodeText, encodeText } from './codec.ts'
export type { StreamDecoder } from './codec.ts'
export { decodeOutput, decodeOutputChunk } from './output.ts'
export type { Cut, DecodedOutputChunk } from './output.ts'
export { UndecodableTextError, UnencodableTextError } from './types.ts'
export type { DetectedTextEncoding, TextEncoding } from './types.ts'
