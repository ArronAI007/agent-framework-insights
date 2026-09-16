# 文件系统与 Buffer 二进制数据

> 上一篇讲完了模块怎么被找到，这一篇讲 Node 运行时最基础的能力之一：读写文件，以及处理二进制数据。文件系统 API 在 Node 里有三套并行的风格（同步/回调/Promise），选错一套在服务端场景下可能直接拖垮整个进程的吞吐；`Buffer` 是 Node 独有、专门用来装二进制数据的容器，理解它和字符串、和标准 `Uint8Array` 的关系，是后面 Stream、网络编程两篇的前置知识。

## 学习目标

- 理解 `fs` 模块的同步 API、回调 API、`fs/promises` 三套风格的取舍
- 掌握 `readFile`/`writeFile`/`mkdir`（含 `{ recursive: true }`）的用法
- 理解 `Buffer` 是 `Uint8Array` 的子类，掌握字符串与 `Buffer` 之间 `utf8`/`hex`/`base64` 编码的互转
- 能直接操作 `Buffer` 里的单个字节

## 同步 API vs 回调 API vs Promise API：三套风格的取舍

Node 的 `fs` 模块从诞生之初就提供了三套并行的接口风格，背后是同一套基于 libuv 线程池的实现，区别只在"暴露给调用方的接口形状"：

- **同步 API**（`fs.readFileSync`）：会**阻塞整个事件循环**，直到文件读写完成才返回——这期间任何其他请求、任何其他定时器都无法被处理。只适合脚本类场景（比如启动阶段读一次配置文件，此时还没有需要响应的其他请求），绝不应该出现在处理用户请求的路径上。
- **回调 API**（`fs.readFile(path, callback)`）：Node 最早提供的异步风格，`callback` 遵循"错误优先"（error-first）约定，第一个参数永远是 `Error | null`。多个异步操作需要顺序执行时容易写出层层嵌套的回调地狱，现在的代码基本不会再选这套风格作为起点。
- **Promise API**（`fs/promises` 模块，或 `fs.promises` 命名空间）：和 `async`/`await` 天然配合，是目前编写新代码时的推荐选择——既不阻塞事件循环，又能用同步风格的代码结构表达异步逻辑。

## `fs/promises`：`readFile`/`writeFile`/`mkdir`

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-node-course-"));
const filePath = path.join(tempDir, "note.txt");

try {
	await writeFile(filePath, "先写入这一行文本\n第二行文本", "utf8");
	const content = await readFile(filePath, "utf8");
	console.log(`[fs/promises] 写入后读回的内容 -> ${JSON.stringify(content)}`);
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
```

真实输出：

```text
[fs/promises] 写入后读回的内容 -> "先写入这一行文本\n第二行文本"
[fs/promises] 已清理临时目录 -> /var/folders/8y/qz1__jtj18374f9tsnvh0jcc0000gn/T/ts-node-course-2WlPGB
```

这里有几个值得留意的工程细节：用 `os.tmpdir()`（返回操作系统标准的临时目录，macOS/Linux 下通常是 `/tmp` 或类似路径）而不是项目目录，避免示例代码污染仓库；`mkdtemp` 会在传入的前缀后面拼接一段随机字符，创建一个不会和其他并发运行的进程/测试冲突的独立目录；`try`/`finally` 保证不管 `writeFile`/`readFile` 是否抛错，临时目录最终都会被 `rm` 清理掉，不留垃圾。

`mkdir` 的 `{ recursive: true }` 选项能一次性创建多级不存在的目录（等价于 shell 里的 `mkdir -p`），不需要先判断父目录是否存在再逐级创建：

```ts
await mkdir(nestedDir, { recursive: true }); // nestedDir 形如 .../a/b/c，a、b 都还不存在
```

真实输出：

```text
[mkdir recursive] 一次性创建了多级目录 -> /var/folders/8y/qz1__jtj18374f9tsnvh0jcc0000gn/T/ts-node-course-nested-JM9OYz/a/b/c
```

## `Buffer` 是什么：`Uint8Array` 的子类

`Buffer` 是 Node 特有的二进制数据容器，出现得比 JS 标准的 `TypedArray`（包括 `Uint8Array`）还要早——但现代 Node 里 `Buffer` 的实现已经调整成了 `Uint8Array` 的子类，这意味着所有 `Uint8Array` 支持的操作（按数字下标读写单个字节、`.length`、`.slice()` 等）`Buffer` 全部支持，`Buffer` 在此基础上额外提供了大量和字符串编码互转相关的便利方法（这是标准 `Uint8Array` 不具备的）：

```ts
const buf = Buffer.from("hi");
console.log(`buf instanceof Uint8Array -> ${buf instanceof Uint8Array}`);
console.log(`buf instanceof Buffer -> ${buf instanceof Buffer}`);
```

真实输出：

```text
[Buffer] buf instanceof Uint8Array -> true
[Buffer] buf instanceof Buffer -> true
```

这个继承关系带来一个实际好处：任何声明参数类型为 `Uint8Array` 的通用 API（比如 Web 标准的 `crypto.subtle`、某些跨运行时通用的库），都能直接传一个 `Buffer` 进去，不需要额外转换。

## 编码转换：`utf8`/`hex`/`base64`

字符串和 `Buffer` 之间的互转，核心是指定一个**编码**——编码决定了"字符串里的每个字符应该被翻译成哪几个字节"，以及反过来"这些字节应该被解读成什么字符"。`utf8` 是最常见的文本编码；`hex`（十六进制）把每个字节表示成两个十六进制字符，常用于打印/记录二进制数据的可读形式；`base64` 把每 3 个字节编码成 4 个可打印字符，常用于在只支持文本的通道（比如某些 HTTP 头、JSON 字段）里传输二进制数据。

```ts
const original = "TypeScript + Node.js 教程";
const buf = Buffer.from(original, "utf8");
const hexEncoded = buf.toString("hex");
const base64Encoded = buf.toString("base64");
```

真实输出：

```text
[编码转换] 原始字符串 -> TypeScript + Node.js 教程
[编码转换] utf8 -> hex    -> 54797065536372697074202b204e6f64652e6a7320e69599e7a88b
[编码转换] utf8 -> base64 -> VHlwZVNjcmlwdCArIE5vZGUuanMg5pWZ56iL
[编码转换] hex -> utf8 还原    -> TypeScript + Node.js 教程
[编码转换] base64 -> utf8 还原 -> TypeScript + Node.js 教程
```

注意 `hex` 编码结果的长度是原字符串字节数的 2 倍（每字节对应 2 个十六进制字符），而这个字符串包含中文字符（每个中文在 UTF-8 下占 3 字节），所以 `hex` 字符串明显比"看起来的字符数"要长得多——这是一个容易被忽视的细节：**字符串的"字符个数"和它编码成字节之后的"字节数"，对非 ASCII 文本来说完全不是一回事**。反向转换（`hex`/`base64` 还原回 `utf8`）验证了这个过程是无损的。

## 直接操作 `Buffer` 字节

`Buffer`（继承自 `Uint8Array`）支持像数组一样用数字下标读写单个字节，每个字节的取值范围是 0-255：

```ts
const buf = Buffer.alloc(5, "?"); // 分配 5 字节，初始值全部填充为 "?" 的字符码
buf[0] = 0x41; // 'A'
buf[1] = 0x42; // 'B'
buf[2] = 0x43; // 'C'
buf[3] = 0x44; // 'D'
buf[4] = 0x45; // 'E'
```

真实输出：

```text
[字节操作] 初始内容 -> ?????
[字节操作] 逐字节写入后 -> ABCDE
[字节操作] 第 0 个字节的十进制值 -> 65
```

`0x41` 是十六进制的 `65`，对应 ASCII 表里的大写字母 `A`——这种"按字节精确控制内容"的能力，在实现二进制协议（比如下一篇要讲的 WebSocket 握手、或者自定义的二进制文件格式）时是必需的，字符串 API 做不到这个精度。

## 小结

`fs` 模块的同步 API 会阻塞整个事件循环，只适合启动阶段的脚本类场景；回调 API 是历史遗留风格；`fs/promises` 配合 `async`/`await` 是目前编写新代码的推荐选择。`readFile`/`writeFile` 处理文件内容读写，`mkdir` 配合 `{ recursive: true }` 能一次性创建多级目录。`Buffer` 是 `Uint8Array` 的子类，继承了下标访问、`.length` 等能力，额外提供了字符串编码互转的便利方法——`utf8`/`hex`/`base64` 是最常用的三种编码，其中要注意非 ASCII 字符（比如中文）编码后的字节数和字符数不是一回事。`Buffer` 支持像数组一样按下标直接读写单个字节，这是实现二进制协议时的基础能力。下一篇进入 Stream 流式处理，会讲清楚为什么处理大文件、大数据量时应该用 Stream 而不是一次性 `readFile` 整个文件到内存。
