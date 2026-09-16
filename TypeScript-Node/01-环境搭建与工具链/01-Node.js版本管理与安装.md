# Node.js 版本管理与安装

> 这门课默认你已经会一门别的语言，知道"装个运行时"是怎么回事。这一篇不讲"什么是 Node.js"，只讲你在多项目、多团队场景下必须搞清楚的版本管理问题。

## 学习目标

- 理解为什么 Node.js 项目普遍需要版本管理器，而不是"系统装一个就够了"
- 看懂 Node.js 的 LTS（长期支持）与 Current（当前）两条发布线的区别
- 能对比 `nvm`/`fnm`/`volta` 三种主流版本管理器，选出适合自己的一个
- 用 `node -v`/`npm -v` 验证安装结果
- 知道 Corepack 是什么、它在后续包管理器章节里会扮演什么角色

## 为什么 Node 版本管理很重要

如果你写过 Python，大概率已经踩过 `virtualenv`/`pyenv` 的坑；如果你写 Go，会习惯每个项目在 `go.mod` 里锁定 Go 版本。Node.js 生态里同样存在这个问题，但原因更具体：**Node.js 的原生模块依赖 ABI（Application Binary Interface，应用二进制接口）**。

像 `better-sqlite3`、`sharp`、`bcrypt` 这类带有 C++ 原生绑定的 npm 包，在安装时会针对当前 Node.js 版本编译出对应的二进制文件（`.node` 文件）。Node.js 的主版本号一旦变化（尤其是跨越偶数大版本，比如从 20 升到 22），底层的 V8 引擎版本和 N-API/ABI 层都会跟着变，之前编译好的原生模块可能直接加载失败，报出类似 `NODE_MODULE_VERSION` 不匹配的错误。这意味着：**同一台机器上，A 项目锁定 Node 18，B 项目要求 Node 22，是完全正常且常见的情况**，你不能只在系统里装一个全局 Node.js 就了事。

另外，Node.js 有自己的发布节奏，理解这个节奏才能知道该锁定哪个版本：

- **奇数版本**（如 19、21、23）：只维护约 6 个月，通常用于尝鲜新特性，**不建议**用在生产项目上。
- **偶数版本**（如 18、20、22、24）：发布后先进入 **Current** 阶段，6 个月后转为 **LTS（Long Term Support，长期支持）** 阶段，再往后是 Maintenance（维护）阶段，整个生命周期通常长达 30 个月。

也就是说，"LTS" 不是某一个固定版本号，而是一种**状态**——任何偶数大版本走到某个时间点，都会进入 LTS 状态。生产项目的默认选择应该是当前处于 Active LTS 状态的版本，而不是最新的 Current 版本。

## 三种版本管理器怎么选

三者都能做到"同一台机器管理多个 Node.js 版本、按项目自动切换"，核心差异在于实现方式和适用场景：

### nvm（Node Version Manager）

最老牌、社区最大、文档最全。它是一个 shell 脚本，通过修改 `PATH` 来切换版本：

```bash
# macOS / Linux 安装
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# 安装并切换到某个 LTS 版本
nvm install --lts
nvm use --lts
```

缺点也很明显：**每次开新终端都要重新 `nvm use` 一次**（除非配合 `.nvmrc` 文件和 shell hook 自动化），切换版本时有肉眼可见的延迟，且官方不支持 Windows（需要用社区维护的 `nvm-windows`，是完全不同的实现）。

### fnm（Fast Node Manager）

用 Rust 写的 nvm 替代品，命令基本兼容 nvm 的习惯用法，但启动和切换速度快一个数量级，跨平台（macOS/Linux/Windows 原生支持）也更省心：

```bash
# 安装（以 macOS 为例，也支持 Homebrew）
curl -fsSL https://fnm.vercel.app/install | bash

fnm install --lts
fnm use --lts
```

如果你在意 shell 启动速度、又想要 nvm 式的手动切换体验，fnm 是目前社区里性价比最高的选择。

### volta

三者中唯一自带 "**项目级版本锁定**" 心智模型的工具：装好之后，进入一个配置过 volta 的项目目录，Node.js/npm/pnpm/yarn 版本会**自动**切到项目要求的版本，不需要手动 `use`：

```bash
curl https://get.volta.sh | bash

# 把当前 Node 版本"钉"进这个项目的 package.json
volta pin node@22
```

`volta pin` 会在 `package.json` 里写入一个 `volta` 字段，团队成员只要也装了 volta，克隆仓库后无需任何额外操作就能拿到一致的运行时版本。这对团队协作项目很有价值，缺点是学习曲线比 nvm 略陡，生态也比 nvm 年轻。

**选择建议**：个人练习、临时切换版本，`fnm` 体验最好；团队协作、需要把版本要求"焊死"进仓库，优先 `volta`；如果团队已经在用 nvm 且没有痛点，没必要强行迁移。这门课的后续内容不依赖任何特定的版本管理器，你可以按自己的习惯选择。

## 验证安装

无论用哪种方式装好 Node.js，第一步永远是验证：

```bash
node -v
npm -v
```

在编写这门课程的环境里，实际输出是：

```text
$ node -v
v26.5.0
$ npm -v
11.17.0
```

npm 是随 Node.js 一起分发的，不需要单独安装；如果 `npm -v` 报错但 `node -v` 正常，通常说明你的 Node.js 安装被裁剪过（比如某些精简版 Docker 镜像），需要单独处理。

## Corepack：为后续包管理器铺路

如果你只用过 npm，可能没听过 Corepack。它是 Node.js 官方提供的一个"包管理器启动垫"（shim）：**不直接安装 pnpm/Yarn 本体，而是根据项目 `package.json` 里的 `packageManager` 字段，按需下载并调用对应版本的包管理器**，从而让"用哪个包管理器、用哪个版本"这件事也能像 Node 版本一样被项目锁定，而不是依赖开发者本地环境里装了什么。

```bash
corepack enable      # 让 pnpm/yarn 命令通过 Corepack 接管
corepack use pnpm@9  # 在当前项目里声明使用 pnpm 9.x
```

需要注意的是，Corepack 的分发策略这几年一直在变化：它从 Node.js 16.9 开始作为**实验性功能**内置，但从较新的 Node.js 大版本开始，官方已经不再于 Node.js 安装包中默认预装 Corepack，需要显式执行 `npm install -g corepack` 单独安装。所以第一次用之前，建议先跑一下 `corepack --version` 确认它是否可用——这门课编写时所用的 Node.js 26 环境里，Corepack 就**没有**被默认预装。

Corepack 具体怎么和 pnpm/Yarn 配合、`packageManager` 字段的写法细节，会在下一章《包管理器与 NPM 生态》里展开。这里只需要建立一个印象：**版本管理器管 Node.js 本身的版本，Corepack 管包管理器的版本**，两者分工不同，但目标一致——让"在我机器上能跑"变成"在任何人机器上都能跑一样的版本"。

## 小结

Node.js 的原生模块依赖 ABI，这是版本管理器在这个生态里几乎成为标配的根本原因，而不只是"图个方便"。LTS 是一种发布状态而非固定版本号，生产项目应默认锁定当前的 Active LTS。`nvm`/`fnm`/`volta` 在实现方式和使用心智上各有侧重：nvm 生态最成熟，fnm 速度最快，volta 提供项目级自动锁定。装好之后用 `node -v`/`npm -v` 做基本验证。Corepack 是 Node.js 官方提供的包管理器启动垫，为下一章要讲的 npm/pnpm/Yarn 版本一致性问题打下基础——注意它在较新的 Node.js 版本里可能需要手动安装。
