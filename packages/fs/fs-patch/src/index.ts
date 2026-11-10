/** Pure patch parsing and text application, independent of filesystem providers. */

export { parsePatch, PatchParseError } from './parse.ts'
export { applyHunks } from './apply.ts'
export {
  findLiteralMatches,
  formatLiteralMismatch,
  locateLiteralMismatch,
  replaceLiteralMatches,
} from './fuzzy.ts'
export type {
  LiteralMatch,
  LiteralMatchResult,
  LiteralMatchStrategy,
  LiteralMismatch,
} from './fuzzy.ts'
export type { ApplyHunksResult, HunkApplyFailure, PatchHunk, PatchOperation } from './types.ts'
