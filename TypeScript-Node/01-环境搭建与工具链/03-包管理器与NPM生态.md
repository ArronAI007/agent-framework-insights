# 包管理器与 NPM 生态

> 装好 Node.js 和 TypeScript 之后，接下来要打交道最频繁的就是包管理器。这一篇讲 `package.json` 的核心字段、几种主流包管理器的差异，以及 semver 和 lockfile 这两个经常被想当然理解、实际却容易踩坑的机制。

## 学习目标

- 看懂 `package.json` 里 `dependencies`/`devDependencies`/`scripts`/`exports`/`type` 各自的职责
- 理解 `npm`/`pnpm`/`yarn` 的核心差异，以及 lockfile 存在的意义
- 掌握 semver 版本号里 `^`/`~`/精确版本的含义区别
- 分清 `npm ci` 和 `npm install` 该在什么场景下用

## `package.json` 核心字段

这门课的脚手架本身就是一个最小可用示例，完整内容如下：

```json
{
  "name": "typescript-node-course",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.20.3",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "vitest": "^5.0.1"
  }
}
```

### `dependencies` vs `devDependencies`

`dependencies` 是**运行时**需要的包——你的代码在生产环境实际 `import`/`require` 的东西（比如一个 Web 框架、一个 HTTP 客户端）。`devDependencies` 是**开发/构建期**才需要的包——类型定义（`@types/*`）、测试框架、构建工具、linter，这些包不会被最终用户的运行时用到。这门课程本身只有 `devDependencies`，没有 `dependencies`，因为它是一套教学脚手架，不对外发布运行时产物。

区分这两者不是学院派的洁癖，而是有实际后果：`npm install --production`（或 `npm install --omit=dev`）只会安装 `dependencies`，容器镜像、Serverless 部署包体积能因此显著变小；如果你把构建工具误放进 `dependencies`，生产依赖树会被不必要地拖大。

### `scripts`

`scripts` 字段定义了一组可以用 `npm run <name>` 触发的命令别名。本课程用到的两个：

```bash
npm run typecheck   # 等价于执行 tsc --noEmit
npm run test         # 等价于执行 vitest run
```

`scripts` 里的命令名可以随意起，但社区有一批**约定俗成**的名字，值得遵守：`build`（构建产物）、`test`（跑测试）、`lint`（跑 linter）、`dev`（本地开发模式）、`start`（启动服务）。遵守约定的好处是，CI 配置、其他协作者、甚至一些自动化工具都能"猜"到怎么跑你的项目，不需要额外文档。

### `type`

`"type": "module"` 决定了这个包里的 `.js` 文件默认按 **ESM**（ECMAScript Modules，也就是 `import`/`export` 语法）解析，而不是 Node.js 传统的 **CommonJS**（`require`/`module.exports`）。如果省略这个字段或者设成 `"commonjs"`，`.js` 文件默认走 CommonJS 解析。这个字段只影响 `.js` 后缀的文件——`.mjs` 永远是 ESM、`.cjs` 永远是 CommonJS，不受 `type` 字段影响。下一章《模块系统 ESM 与 CommonJS》会专门展开这一整套规则。

### `exports`

`exports` 字段用于**精确控制一个包对外暴露哪些入口**，是相对较新的字段（早期 Node.js/npm 生态只看 `main` 字段）。一个简单例子：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./utils": "./dist/utils.js"
  }
}
```

这意味着 `import x from "your-package"` 能拿到 `./dist/index.js` 的导出，`import y from "your-package/utils"` 能拿到 `./dist/utils.js` 的导出，但其他任何没有在 `exports` 里声明的子路径（比如 `your-package/internal/foo`）都会被**拒绝访问**，即使物理文件确实存在。这是 Node.js 官方推荐的"包边界"收紧手段——之前任何人都能 `require("your-package/lib/internal-helper")` 直接访问包的实现细节，`exports` 字段出现后，包作者第一次有能力明确区分"公开 API"和"内部实现"。这门课程作为一个教学项目、不对外发布，因此没有配置 `exports`；如果你以后要发布一个 npm 包（第 06 章会讲到），这个字段值得认真设计。

## `npm`/`pnpm`/`yarn`：差异与 lockfile 机制

三者都能完成"读取 `package.json`、下载依赖、解析版本冲突"这件事，但底层存储策略和产出的 lockfile 完全不同：

| | npm | pnpm | yarn (Berry) |
|---|---|---|---|
| 依赖存储方式 | `node_modules` 扁平化拷贝 | 全局内容寻址存储 + 硬链接/符号链接 | 可选 `node_modules` 或 Plug'n'Play |
| lockfile | `package-lock.json` | `pnpm-lock.yaml` | `yarn.lock` |
| 磁盘占用 | 每个项目独立一份完整拷贝 | 同一版本的包全局只存一份物理文件 | 视模式而定 |
| 幽灵依赖问题 | 存在（扁平化导致能访问未声明的依赖） | 默认严格隔离，不存在 | 视模式而定 |

**幽灵依赖（phantom dependency）** 是 npm 扁平化存储的一个经典副作用：因为所有依赖（包括依赖的依赖）最终都被拍平进同一个 `node_modules` 顶层，你的代码可能在没有把某个包写进自己 `package.json` 的情况下，仍然能 `import` 到它——只是因为它恰好被另一个依赖也用到了、被提升到了顶层。这种代码一旦那个"顺带"依赖被上游移除或降级，就会毫无征兆地崩溃。pnpm 用符号链接强制每个包只能访问自己声明过的依赖，从根源上避免了这个问题，这也是它近几年在 monorepo 场景里迅速流行的原因之一。

**lockfile 的核心作用是锁定"依赖树的精确解析结果"**，而不只是版本号。`package.json` 里的 `"typescript": "^7.0.2"` 只表达了一个版本范围，真正安装时具体拿到 `7.0.2` 还是 `7.3.1`，以及每一层传递依赖具体解析到哪个精确版本，都记录在 lockfile 里。**lockfile 必须提交到版本库**——这是团队协作和 CI 复现构建结果的基本前提，没有它，"在我机器上是好的"这类问题会大量出现。

## semver 语义：`^`、`~`、精确版本

npm 生态遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/) 规范，版本号格式是 `主版本.次版本.修订号`（`MAJOR.MINOR.PATCH`），约定：

- **修订号（PATCH）**递增：只包含向后兼容的 bug 修复
- **次版本号（MINOR）**递增：新增向后兼容的功能
- **主版本号（MAJOR）**递增：包含不兼容的破坏性变更

`package.json` 里版本号前的符号决定了 `npm install`/`npm update` 时允许升级的范围：

- **`^7.0.2`**（脱字符）：允许升级到不改变**最左侧非零数字**的任意版本，实践中通常理解为"允许次版本号和修订号自由升级，但不允许主版本号变化"。`^7.0.2` 允许升到 `7.9.9`，不允许升到 `8.0.0`。这是 `npm install <pkg>` 不加任何标志时的**默认**前缀。
- **`~4.23.13`**（波浪号）：只允许修订号升级，不允许次版本号变化。`~4.23.13` 允许升到 `4.23.99`，不允许升到 `4.24.0`。语义更保守，适合对次版本升级也不完全信任的依赖。
- **精确版本**（如 `7.0.2`，不带任何前缀）：完全锁死，`npm update` 不会动它，只有手动修改 `package.json` 或显式 `npm install pkg@版本号` 才会变化。

需要强调的是：`^`/`~` 这类范围符号约束的是 `npm install`/`npm update` **重新解析依赖树**时的行为；一旦 lockfile 存在且没有理由重新解析（比如运行 `npm ci`），实际安装的版本以 lockfile 为准，`package.json` 里的范围符号只在"需要决定新装/升级到哪个版本"时才生效。

## `npm ci` vs `npm install`：场景区别

这是一个新手常年混用、老手绝不混用的对比：

**`npm install`**（可简写 `npm i`）：会读取 `package.json`，如果发现 lockfile 里的解析结果和 `package.json` 的版本范围有出入（比如你手动改了某个包的版本号约束），会**重新解析并更新 lockfile**。适合日常开发中新增/修改依赖的场景。

**`npm ci`**（clean install 的缩写）：要求 `package-lock.json` 必须存在且与 `package.json` 完全匹配，**严格按照 lockfile 里记录的精确版本安装，不做任何重新解析，也不会修改 lockfile**。执行前会先删除已有的 `node_modules` 再重新安装，保证结果干净、可复现。如果 lockfile 缺失或和 `package.json` 对不上，`npm ci` 会直接报错退出,而不是像 `npm install` 那样"帮你修好"。

实践中的分工很清晰：**本地开发用 `npm install`**（需要新增依赖、调整版本范围时），**CI 流水线和生产构建一律用 `npm ci`**——CI 环境需要的是"完全复现 lockfile 记录的依赖树"这种确定性，而不是"帮我顺便再解析一遍、可能悄悄换个版本"这种灵活性。用错方向的典型症状是：CI 里跑出来的依赖版本和本地不一致，排查半天才发现 CI 脚本里写的是 `npm install` 而不是 `npm ci`。

## 小结

`package.json` 里 `dependencies`/`devDependencies` 按运行时/开发期区分依赖，`scripts` 提供命令别名并遵循社区约定命名，`type` 决定 `.js` 文件默认按 ESM 还是 CommonJS 解析，`exports` 精确控制包对外暴露的入口、收紧包边界。npm/pnpm/yarn 的核心差异在依赖存储策略：npm 扁平化拷贝会引入幽灵依赖问题，pnpm 的内容寻址 + 符号链接从根源上避免了它。lockfile 锁定的是整棵依赖树的精确解析结果，必须提交到版本库。semver 的 `^`/`~`/精确版本三种写法分别对应"锁主版本"、"锁次版本"、"完全锁死"三种升级策略。日常开发用 `npm install`，CI 和生产构建用 `npm ci`——这不是风格偏好，而是两者行为本质不同导致的场景区分。
