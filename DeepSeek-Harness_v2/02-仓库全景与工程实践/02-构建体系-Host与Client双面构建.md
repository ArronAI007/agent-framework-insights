# DeepSeek Harness 的构建体系：为什么类型检查要拆成两个永不合并的程序

这一篇要回答的问题是：dsh 为什么把整个仓库的 TypeScript 类型检查硬拆成 Host 和 Client 两个 `ts.Program`，产物构建又为什么分成两条流水线，以及一个新包应该走哪一条。

结论先说。第一，根因是 Cordis 的 `Context` 接口靠 `declare module` 做全局声明合并，Node 端和浏览器端往同一个接口上挂了不同的服务键，甚至同名键、不同类型，放进一个编译单元就会得到一张失真的能力表。第二，仓库用 `tsconfig.json`（`files: []` 的纯引用清单）分出 `tsconfig.host.json` 和 `tsconfig.client.json`，再用环境变量 `DSH_BUILD_FACE` 驱动两条 tsdown 打包管线。第三，浏览器 bundle 的产出权下放给每个客户端包自己的配置，构建期还有一个 purity 插件把"跨插件只能走 Cordis 服务"变成硬门禁。

## 合并到一起会出什么问题

TypeScript 的声明合并是全局生效的：只要某个文件被编译单元加载过，它对 `declare module '@deepseek-ai/cordis'` 里 `Context` 所做的扩展，就会并进整个程序里唯一的一份 `Context`。Node 端插件声明的 `ctx.fs`、`ctx.sandbox`，会和浏览器端插件声明的 `ctx.theme`、`ctx.modules` 合成同一张服务表。后果是本该在编译期拦住的错误被放过：浏览器代码误用了只在 Node 里存在的 `ctx.fs`，类型系统"看得见"这个键，编译通过，直到打包时找不到对应实现才崩溃，或者更糟，悄悄把不该出现在浏览器的 Node 依赖打进产物。

更麻烦的是同名键、不同类型。`tsconfig.client.json` 的注释直接点出：两侧在 `sessions` 和 `loader` 这两个键下合并了不同的服务。Host 侧，`packages/core/session/src/index.ts` 给 `Context` 挂了 `sessions: SessionStore`，vendored 的 Cordis Loader 插件挂了 `loader: Loader`；浏览器侧的等价能力另有所指，例如主题运行时在 `packages/client/ui-theme/src/client/index.ts` 里挂的是 `theme: ThemeRuntime`。同名同结构的字段会合并，冲突的签名要么报错要么产生难以理解的联合类型，合并结果既不是 Host 想要的，也不是 Client 想要的。拆成两个 `ts.Program` 之后，Host 编译只加载 Host 侧那组声明，Client 编译只加载 Client 侧那组，两份 `Context` 永远互相看不见。

## 一个不含程序的根配置

根 `tsconfig.json` 的核心是 `"files": []` 加两个 `references`，分别指向 `tsconfig.host.json` 和 `tsconfig.client.json`。在 Project References 模式下，一个自己不声明 `files` 或 `include` 的 solution 文件不会被实例化成真正的程序，它只是给 `tsc -b` 和 tsserver 一张"这里有两个独立子工程"的路标。文件里的注释写得很直白：永远不要往这里加 `include` 或 `files`，永远不要把它压平成单一 `ts.Program`。它同时 `extends` 了 `tsconfig.base.json`，这样 `tsx` 运行 `scripts/` 下的脚本时找不到更近的 tsconfig，也能通过这份基础路径映射解析到工作区内的包。

Host 聚合工程 `tsconfig.host.json` 覆盖 Node 端源码、脚本和测试，用 `exclude` 显式排除 `packages/client/*/src/**` 以及文件名带 `.client.` 后缀的测试。它的 `references` 列出上百个叶子包路径，这是 Project References 的硬性要求，引用必须显式列出，不支持通配。`references` 管的是编译顺序和增量缓存边界，`tsconfig.base.json` 里的 `paths` 映射管的是裸模块名怎么解析到源码，两者分工不同。一个 client 包如果同时有 Node 半区和浏览器半区，测试文件靠文件名后缀声明归属：`*.client.*` 归 Client 聚合，`*.host.spec.ts` 归 Host 聚合，两边互相 `exclude` 对方的后缀，公共的测试 glob 就不需要逐文件配置。

Client 聚合工程继承 `tsconfig.base.client.json`，它划清"这是浏览器代码"的方式是：`lib` 换成包含 `DOM`、`DOM.Iterable`、`ESNext.Disposable` 的一组，开 `jsx: "react-jsx"`，并且不引入完整的 Node 类型，而是把 `types` 设成 `["client-build-environment"]`，指向仓库自维护的 `scripts/types/client-build-environment`。这个环境声明只写打包器构建期真的会替换的几个 `process.env.*` 字段（`NODE_ENV` 和形如 `DSH_CLIENT_*` 的自定义变量），浏览器代码里少量的 `process.env.xxx` 判断因此也能过类型检查，同时不会误用 Node 的 ambient 类型。

有一个刻意错开的细节：`tsconfig.client.json` 自己把 `types` 设回 `["node"]`。原因是这份聚合工程编译的是测试文件，跑在 vitest 上，e2e 甚至会 spawn 子进程，测试需要 Node 类型。"包源码是否保持浏览器纯净"由另一套机制保证：每个客户端包自己的 tsconfig（继承 base.client，`types: []`）加上 `scripts/client-bundle-purity.spec.ts` 这个构建期校验。测试环境和被测源码的类型环境是故意分开的。

Host 和 Client 的 `references` 里会出现重叠的叶子包，比如 `packages/compaction/compaction`。这些共享叶子（`session`、`llm`、`tools` 一类）不依赖 Cordis `Context` 的类型合并，只导出纯类型或不含跨插件运行时身份的内容，所以只构建一次，被两个程序各自引用，不违反"两侧合并互不可见"的约束。

## 打包：DSH_BUILD_FACE 驱动的两条通路

类型检查分两半，产物构建也分两条。根 `package.json` 里 `build:lib` 顺序执行 `build:lib:host` 和 `build:lib:client`，每一面都是先用对应的 `tsc -b` 把 TypeScript 降级成 JavaScript，再用 tsdown 打包成发布产物，区别在传给 tsdown 的 `--env.DSH_BUILD_FACE`（`host` 或 `client`）。Host 侧的 `tsc -b` 还多包了一层 `node --max-old-space-size=4096`，这说明 Host 聚合工程的类型检查图在叶子包增长到 307 个之后已经大到要手动调高 V8 堆上限才能稳定跑完。

分流的入口是根 `tsdown.config.ts`。它只接受 `host` 或 `client` 两种取值（不传视为 host），其他值直接抛错。

```typescript
workspace: client
  ? ['vendor/*', 'packages/*/*', 'apps/cli']
  : ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop', 'apps/desktop-host'],
entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
```

Host Pass 对每一个 workspace 包统一打包 `lib/types/{index,invariant,startup}.js` 三个标准入口，并顺手运行 Typert 产物生成器。Client Pass 把 `entry` 清空，对绝大多数包什么都不做，真正要产出浏览器 bundle 的包必须自带一份包级 `tsdown.config.ts` 去覆盖根配置。另外，桌面应用 `apps/desktop` 和 `apps/desktop-host` 只出现在 Host Pass 的包列表里：它们本质上是 Electron 壳套一个 Node 宿主进程，只需要 Node 端的标准入口打包，不需要浏览器 bundle 流程。

包级覆盖的公共实现是 `packages/client/tsdown.client.ts` 导出的 `clientBundle()`。它的默认行为是：一个客户端插件包在 Host Pass 里整个跳过（返回 `SKIP_WORKSPACE_BUILD`，也就是 `{ entry: '' }`），Node 半区和浏览器半区都留给 Client Pass 一起产出，这样浏览器 bundle 打包时 Rolldown 能直接看到刚生成的 `lib/types/client/index.js`，不需要跨阶段协调。只有显式设置 `hostPhase: true` 的包，才会在 Host Pass 里先产出 Node 半区。

## 构建期的 purity 门禁

`clientConfig()` 生成的浏览器打包配置里，最值得理解的是 externals 和 purity 检查。哪些模块可以外部化，现在是一个包级的许可集合 `clientExternals(id)`，由三部分拼成：仓库统一的平台模块基线 `PLATFORM_MODULES`，预置的常用外部依赖 `PRELOADED_CLIENT_EXTERNALS`，以及这个包自己 `package.json` 里 `dsh.client.external` 字段声明的额外请求项。打包时 `deps.neverBundle` 命中集合内的模块，`deps.alwaysBundle` 则内联其余模块。这比早期"一份全局写死的 `CLIENT_EXTERNALS` 数组"更细：每个客户端包必须在自己的清单里显式声明还需要哪些外部依赖。

在这之上，名为 `dsh-client-bundle-purity` 的插件在 `resolveId` 阶段拦截每一个 `@deepseek-ai/*` 导入，只放行四类：已声明的外部模块、vendored 库（内联，没有共享身份）、显式标记为"内联安全"的线路层包、生成的 `/remote` 贡献。其余任何跨插件的值导入都在构建期直接抛错，报错信息会提示你要么声明一个非默认的模块请求，要么改用 Cordis 服务来协作，类型导入会被擦除，不受影响。输出方面，bundle 用 `window.__ModuleLoader__.load({ id, factory })` 包一层，交给浏览器端的模块加载器。这一套把"插件之间只能通过服务通信"从架构约定变成了打不出包的硬约束。

## 边界与常见踩坑

这套体系的代价体现在几个易错点上。`tsconfig.host.json` 检查不到 `packages/client/*/src`，如果在 Host 侧没看到某个客户端包的类型错误，先确认入口选对了。新增一个客户端叶子包时，必须在 `tsconfig.client.json` 的 `references` 里手动补路径，Project References 不支持通配，漏加会导致 tsserver 报找不到模块或增量顺序错乱，即使 `paths` 映射已经写对。给客户端包写 `tsdown.config.ts` 时，如果没有正确调用 `clientBundle()` 之类的帮助函数，Client Pass 因为根配置的 `entry` 是空的，很容易什么都没产出。

判断新包走哪一面，可以按这个顺序想：纯 Node 端能力，只需要进 Host 聚合和 Host Pass；只在浏览器运行的 UI 包，进 Client 聚合，用 `clientBundle()`；像 `packages/client/*` 里既有 Node loader 入口又有浏览器产物的包，两面都要参与，默认由 Client Pass 统一产出。

## 小结

- Cordis `Context` 的全局声明合并使得两侧不能共处一个 `ts.Program`，因此用 `files: []` 的根 solution 文件拆出 Host 和 Client 两个聚合工程。
- `DSH_BUILD_FACE` 决定 tsdown 走哪条管线：Host 统一产出标准入口并运行 Typert，Client 把浏览器 bundle 的产出交给各包的 `clientBundle()` 配置。
- 每个客户端包按 `dsh.client.external` 声明自己的外部依赖，purity 插件在构建期禁止跨插件的值导入，双面约束因此有类型检查和打包两道防线。

对应原课程篇目：`02-仓库全景与工程实践/02-构建体系-Host与Client双面构建`。
