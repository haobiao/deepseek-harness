---
description: "Detect and convert stored text and captured process output between UTF-8 and the Chinese GB18030/GBK charsets, with round-trip proof and split-character-safe streaming."
kind: "package-library"
---

# dsh-text-encoding

English | [中文](README.zh.md)

## Summary

Detect and convert the encodings stored text and captured process output arrive in: UTF-8 with or without a BOM, and the Chinese legacy charsets GB18030 and GBK. Detection never guesses from plausibility — a charset wins only when decoding and re-encoding restores the original bytes, so a mis-detection cannot corrupt an edit. The package also provides streaming decoders that hold back split characters, refusal errors naming the first unencodable character, and a display-only decode for bounded subprocess output. It performs no filesystem or process I/O.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state. Callers own the I/O: this package only turns bytes into text and text back into bytes.

```ts
import {
  createStreamDecoder,
  decodeOutput,
  decodeText,
  detectEncoding,
  encodeText,
} from '@deepseek-ai/dsh-text-encoding'

const sample = new Uint8Array(await reader.read())
const detected = detectEncoding(sample, { fragment: true })
const text = decodeText(sample.subarray(0, detected.wholeLength), detected.encoding)
// Later, an edit goes back under the same encoding:
const bytes = encodeText(text, detected.encoding)
// Display-only: captured subprocess output, never written back.
const shown = decodeOutput(captured, { tail: true })
```

| Export | Role |
|---|---|
| `detectEncoding(data, { fragment? })` | Choose `utf8`, `utf8-bom`, `gb18030`, `gbk`, or `lossy-utf8`, plus the whole-character prefix the decision covers. |
| `decodeText(data, encoding)` | Strict decode; throws `UndecodableTextError` for invalid UTF-8 or unrestorable bytes. |
| `encodeText(text, encoding)` | Encode under the file's own encoding; throws `UnencodableTextError` naming the first character it cannot represent. |
| `createStreamDecoder(encoding)` | Chunk decoder whose `push`/`end` never split a character. |
| `decodeOutput(data, cut)` | Display-only decode of bounded process output; never throws. |
| `trimPartialUtf8`, `wholeCharsetLength`, `isValidUtf8` | Boundary helpers for bounded samples. |
| `asBuffer`, `startsWithUtf8Bom`, `roundTrips` | Detection primitives. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [boundaries](src/boundaries.ts) module measures where a bounded byte sample stops holding whole characters; [detect](src/detect.ts) applies the BOM, strict-UTF-8, and round-trip cascade over that prefix; [codec](src/codec.ts) decodes, encodes, and streams; [output](src/output.ts) decodes bytes that are only displayed. The [types](src/types.ts) define the encoding vocabulary and the two refusal errors.

The ordering is the design. UTF-8 is checked before the legacy charsets because ASCII and CJK UTF-8 are also valid GB18030 byte strings; a legacy-first order would mislabel every UTF-8 file. The BOM comes first because it is proof rather than plausibility. A legacy charset then wins only when `iconv-lite` decoding followed by encoding restores the sample byte for byte — the decoders never fail, they substitute U+FFFD, so decoding alone is no signal.

`decodeOutput` is deliberately different from `decodeText`: its input is a buffer bound cut at either end and is never written back. It trims the partial character a cut left, keeps a UTF-8 tail a writer stopped inside when a multi-byte character already appeared, and falls back to GB18030 for bytes no charset proves — a model should read what a Windows console actually printed instead of U+FFFD.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Utility package group](../README.md) — the other host-side primitives.
- [Filesystem package group](../../fs/README.md) — the local backend that reads and writes through this module.
- [Subprocess package group](../../subprocess/README.md) — captured output that `decodeOutput` reads.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **UTF-8 and Chinese legacy charsets only.** UTF-16 with a BOM and other code pages are not detected or converted.
- **One charset per buffer.** A captured output that mixes encodings is decoded as one charset; no per-line sniffing.
- **`lossy-utf8` cannot be written back.** Stored text in bytes neither UTF-8 nor GB18030/GBK restores is read-refusing; only `decodeOutput` substitutes GB18030 for display.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
