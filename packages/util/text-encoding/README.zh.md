---
description: "检测并转换存储文本与捕获的进程输出在 UTF-8 与中文 GB18030/GBK 编码之间的表示，带往返证明与不切断字符的流式解码。"
kind: "package-library"
---

# dsh-text-encoding

[English](README.md) | 中文

## 概述

检测并转换存储文本与捕获的进程输出所用的编码：带或不带 BOM 的 UTF-8，以及中文传统字符集 GB18030 与 GBK。检测从不基于“看起来像”来猜测——只有解码再编码能逐字节还原原文时字符集才胜出，因此误判不会损坏一次编辑。本包还提供不切断字符的流式解码器、指出首个不可表示字符的拒绝错误，以及面向有界进程输出的仅显示解码。它不执行文件系统或进程 I/O。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

它是**库，不是服务也不是插件**：无 `ctx`、不注册任何东西、不持有状态。I/O 由调用方负责：本包只把字节变成文本、把文本变回字节。

```ts
import {
  createStreamDecoder,
  decodeOutput,
  decodeText,
  detectEncoding,
  encodeText,
} from '@deepseek-ai/dsh-text-encoding'

declare const reader: { read: () => Promise<Uint8Array> }
declare const captured: Uint8Array

const sample = new Uint8Array(await reader.read())
const detected = detectEncoding(sample, { fragment: true })
const text = decodeText(sample.subarray(0, detected.wholeLength), detected.encoding)
// Later, an edit goes back under the same encoding:
const bytes = encodeText(text, detected.encoding)
// Display-only: captured subprocess output, never written back.
const shown = decodeOutput(captured, { tail: true })
```

| 导出 | 角色 |
|---|---|
| `detectEncoding(data, { fragment? })` | 选择 `utf8`、`utf8-bom`、`gb18030`、`gbk` 或 `lossy-utf8`，并给出判定覆盖的整字符前缀。 |
| `decodeText(data, encoding)` | 严格解码；对非法 UTF-8 或无法还原的字节抛出 `UndecodableTextError`。 |
| `encodeText(text, encoding)` | 按文件自身编码编码；无法表示时抛出 `UnencodableTextError` 并指出首个字符。 |
| `createStreamDecoder(encoding)` | 分块解码器，`push`/`end` 永不切断字符。 |
| `decodeOutput(data, cut)` | 有界进程输出的仅显示解码；从不抛错。 |
| `trimPartialUtf8`、`wholeCharsetLength`、`isValidUtf8` | 有界样本的边界辅助函数。 |
| `asBuffer`、`startsWithUtf8Bom`、`roundTrips` | 检测原语。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

[boundaries](src/boundaries.ts) 模块度量有界字节样本在何处不再持有整字符；[detect](src/detect.ts) 在该前缀上执行 BOM、严格 UTF-8 与往返的级联判定；[codec](src/codec.ts) 负责解码、编码与流式处理；[output](src/output.ts) 解码仅用于显示的字节。[types](src/types.ts) 定义编码词汇与两种拒绝错误。

顺序本身就是设计。UTF-8 先于传统字符集检查，因为 ASCII 与中文 UTF-8 同样是合法的 GB18030 字节串；传统字符集优先会把每个 UTF-8 文件都标错。BOM 最先，因为它是证明而不是“看起来像”。随后只有 `iconv-lite` 解码再编码能逐字节还原样本时，传统字符集才胜出——解码器从不失败，只会替换成 U+FFFD，所以单纯解码不构成信号。

`decodeOutput` 与 `decodeText` 刻意不同：它的输入是两端可能被截断的缓冲区，且永远不写回。它裁掉截断留下的半个字符，在已出现多字节字符时保留写入方中途停下的 UTF-8 尾部，并对没有字符集能证明的字节回退到 GB18030——模型应当读到 Windows 控制台真正打印的内容，而不是 U+FFFD。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [工具包组](../README.zh.md)——其他宿主侧原语。
- [文件系统包组](../../fs/README.zh.md)——通过本模块读写文件的本地后端。
- [子进程包组](../../subprocess/README.zh.md)——由 `decodeOutput` 读取的捕获输出。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅 UTF-8 与中文传统字符集。** 带 BOM 的 UTF-16 及其他代码页既不检测也不转换。
- **每个缓冲区一种字符集。** 混用多种编码的捕获输出只按一种字符集解码；不逐行嗅探。
- **`lossy-utf8` 不能写回。** 既非 UTF-8、也无法被 GB18030/GBK 还原的存储字节会被拒绝读取；只有 `decodeOutput` 会为显示而回退 GB18030。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
