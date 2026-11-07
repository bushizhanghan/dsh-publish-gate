# dsh-publish-gate — 帮你发布 DSH 插件的一键三连门禁

> **这个插件是给插件作者用的**：你写完一个 DSH 插件，想发 GitHub + npm + 插件市场，它帮你把发布前该查的全部查一遍，再给你照抄的命令清单。
>
> 发布一个 DSH 插件有七步，每一步都有一个**直到你付出代价才说话的坑**：`files` 忘了 `lib/` 于是发出去一个空包、PowerShell 写下的 BOM 让 `JSON.parse` 报一个不提 BOM 的错、patch 的 insert 行缩进错了于是插件装上了但**永远不加载**、裸包名让 granular token 收到一个既不说 token 也不说 scope 的 403。这个插件把整条链路的每个静默坑变成一条确定性检查。

八个 agent 工具：全量门禁、运行时注册检查、发后校验、patch 专项、市场条目校验、版本推进、多插件体检、发布命令清单。

门禁分三层：**清单层**看 package.json / patch / 入口源码，**产物层**真的跑一遍 `npm pack --dry-run` 看 npm 到底会发出什么，**运行时层**在独立子进程里 `import()` 入口并 `apply(ctx)` 一遍，看它到底注册了什么。

## 典型用法（写完插件后）

```
我写好了一个新插件 X，帮我发出去
→ agent 先调 publish_gate(X) 查所有静默坑（清单 + 产物 + 运行时三层）
→ 有 blocker 就修，修完再跑
→ 全绿后调 publish_gate_commands(X, {version}) 拿 GitHub/npm/市场三步的命令，照抄执行
→ 发完调 publish_gate_verify(X) 确认 registry 上那包的 shasum 和你本地这份一致
```

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-publish-gate
```
重启 DSH 后生效。**只读**：这个插件从不写你的插件目录。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `publish_gate` | 全量门禁：清单 + 产物 + 运行时 + 浏览器半边 + 网络，返回 `safeToPublish`（`skipPack` / `skipTools` / `skipClient` / `skipNetwork` 可逐层跳过） |
| `publish_gate_tools` | 只跑运行时层：在子进程里 `apply(ctx)`，看注册了哪些工具、有没有缺 `execute`、重名、`presentCall` 抛错、`card` 用了宿主不认识的值 | 传 `call: ["工具名"]` 可以**真的调一次**（空参数）：注册永远不会执行 `execute`，所以「一调就抛 ReferenceError」这类 bug 只有这一条能看见。默认不调——有些工具会开程序或写文件，你点名才算同意。超时单独算 `tool-call-slow`（warn），不跟「真的抛了」混在一起：`of_env` 这种要起 WSL 的工具本来就慢。 |
| `publish_gate_client` | 只跑浏览器半边：在子进程里假造 `window.__ModuleLoader__`，看 bundle 会不会加载、`apply` 会不会抛、到底往哪个服务注册了东西、`inject` 有没有漏 |
| `publish_gate_verify` | 发后校验：`npm pack --dry-run` 的 shasum 和 registry 上的 `dist.shasum` 逐字节比，比版本号猜准 |
| `publish_gate_patch` | 只查 `cordis.patch.yml`——「插件装了但工具没出现」的第一个怀疑对象 |
| `publish_gate_market` | 校验市场条目 YAML（url/name/category/description 双语）；传 `dir` 则改查只有线上才能回答的三件事：这个仓库**已经在目录里**（再开 PR 就是重复条目）、另一个条目也在发同一个 npm 包、仓库还**不满 24 小时**（提交门禁会失败并自己重跑） |
| `publish_gate_next_version` | 当前版本、是否已被 registry 占用、建议 bump 到多少（本地比 npm 旧时从 npm 的 latest 往上加，不会推荐一个已被占用的版本） |
| `publish_gate_doctor` | 扫整个目录，按 blocker 数排序，附带每个插件的真实包体积，看哪个还不能发 |
| `publish_gate_commands` | 按顺序列出发布命令，并标出这台机器已经走到哪一步。命令是**这台机器上真能跑的形式**：Windows 下 `npm publish` 走 `cmd /c`（PowerShell 的 `npm.ps1` 常被执行策略拦掉），`npm publish` 后面紧跟一条 `publish_gate_verify` |

## 检查清单

### 会真的挡住发布的（error）
| 规则 | 抓什么 |
|---|---|
| `utf8-bom` | BOM 让 JSON.parse 抛「Unexpected token」，错误信息里没有 BOM 三个字 |
| `json-parse` | package.json 语法错误 |
| `missing-field` | name/version/description/main/license/repository/author 缺失 |
| `invalid-name` / `invalid-version` | npm 拒绝的形状 |
| `files-omits-lib` | 发出去是空包——**npm 不警告** |
| `files-omits-patch` | `dsh.bundle.patch` 指的文件不在 files 里，装上不挂载 |
| `no-exports` | 缺 `exports["."]`，宿主解析不到入口 |
| `private-field-set` | 还留着脚手架模板的 `"private": true`，npm 直接 EPRIVATE 拒发 |
| `client-without-export` | 声明了 client 平台却没导出 `./client`，宿主半边在、侧栏永不出现 |
| `client-without-platform` | 反过来：导出了 `./client` 却没写 `dsh.client.platform`。文件发出去了，宿主不知道要加载它——装上后一个字节都不执行，而且没有任何报错 |
| `not-esm` | 没 `"type": "module"`，`import` 在加载时炸 |
| `no-insert-row` | patch 里只有 override，永远不挂载（页面报的仍然是这条——顶层 `- id:` 是 patch 不是挂载） |
| `bundle-patch-not-declared` | 有 `cordis.patch.yml` 但清单里没有 `dsh.bundle.patch`——patch 是死的，装了不挂载 |
| `entry-path-missing` | `main` / `exports["."]` / `exports["./client"]` 指的文件不存在，宿主解析到空 |
| `inject-missing-*` | 用了 `ctx.tools` / `ctx.web` / `ctx.webServer` / `ctx.setInterval` 却没在 `inject` 里声明，cordis 永远不激活 |
| `patch-not-mount` | info：这些顶层 `- id:` 是在覆盖已有条目，合法，但**不是**挂载 |
| `insert-missing-name` / `insert-name-mismatch` | 挂载名缺失或与 package.json 不一致 |
| `no-patch-file` | 有 `lib/index.js` 但没有 `cordis.patch.yml` |
| `no-name-export` / `no-apply-export` | 入口协议不完整 |
| `require-in-esm` | ESM 里 `require()` → `ERR_AMBIGUOUS_MODULE_SYNTAX`，报错不带行号 |
| `no-license` | 缺 LICENSE |
| `version-taken` | 这个版本已经在 registry 上，再发是 403 |
| `registry-unreachable` | registry 回了 500/429 —— 版本检查**没跑**，所以别把它当干净 |

### 值得在发布前知道的（warn / info）
`unscoped-name`（granular token 的 403）、`repo-missing`、`patch-name-unresolvable`（junction 放错层级）、`inject-unused-service`（`inject` 里写了个拼错的服务名，cordis 一直等它，插件静默不激活）、`no-publish-config-access`（scoped 包没写 `publishConfig.access`，只是提醒，因为命令里本来就带 `--access public`）、`publish-config-registry`（`publishConfig.registry` 指到内网 registry，版本发到别人装不到的地方）、`no-readme` / `readme-no-install` / `readme-no-profile`、`license-mismatch`、`no-tests` / `no-test-files` / `no-test-script`、`no-engines`、`bad-repo-url`、`no-git` / `no-gitignore`、`readme-tool-undocumented`（README 没提这个工具）/ `readme-test-count`（README 写的测试数和真实数不一致），以及市场条目的 `market-*` 全系列。

### 产物层：npm 到底会发出什么

清单层只看 `files` 字段，而 npm 有它自己的规矩（`main` / `exports` 指向的文件强制入包、README/LICENSE/package.json 强制入包）。所以这一层真的跑一遍 `npm pack --dry-run --json --ignore-scripts`，读它返回的文件清单和体积。

| 规则 | 抓什么 |
|---|---|
| `pack-omits-lib` | tarball 里没有 `lib/`——发出去是空包，**npm 不警告** |
| `pack-omits-patch` | `dsh.bundle.patch` 指的文件没进 tarball，装上不挂载 |
| `pack-omits-client` | `exports["./client"]` 指的文件没进 tarball。npm **不会**因为它在 `exports` 里就强制入包（只强制 `main`），所以 `files` 里没写它就会静默丢掉——本地能跑、装了没侧栏 |
| `pack-omits-readme` / `pack-omits-license` | README / LICENSE 没进包 |
| `pack-oversize` | 解包 >5 MB 是 error、>1 MB 是 warn，并点名最大的三个文件。测试 fixture 是常见元凶——我的一个插件曾把 20 MB 的算例目录发上去，装了它的人每次都要下 20 MB |
| `pack-ships-secret` | tarball 里有 `.env` / `.npmrc` / `*.pem` / `*.key` / `id_rsa`。没写 `files` 字段时 npm 会把 `.gitignore` 没排除的一切都打包，而包一发布就是公开的、npm 不会帮你撤回 |
| `pack-unexpected-dir` | `fixtures` / `test` / `tests` / `src` 被打进包里 |
| `pack-script-build` | 有 `prepack` / `prepare`：dry run 用了 `--ignore-scripts`，这次清单**不代表**真正发布时的产物 |
| `pack-unavailable` | npm 跑不起来（warn）——产物层没跑，别把它当干净 |

### 运行时层：`apply` 之后到底注册了什么

前两层都是读文件，读不出「装上能不能用」。这一层在独立子进程里 `import()` 入口、用假 ctx 调一次 `apply(ctx)`，把 `ctx.tools.register` 收到的每一条拿回来检查。20 秒超时，你的插件代码不在宿主进程里跑。

| 规则 | 抓什么 |
|---|---|
| `entry-import-failed` | `import()` 入口就抛——装上必定不加载 |
| `apply-threw` | `apply(ctx)` 抛 |
| `tool-none-registered` | 入口能加载，但一个工具都没注册 |
| `tool-missing-execute` / `tool-missing-output-schema` | 注册项缺 `execute` / `output.schema`（宿主用 schema 校验返回值，缺了等于没校验） |
| `tool-duplicate-name` | 两个工具同名，后者静默覆盖前者 |
| `tool-present-call-throws` | `presentCall` 抛——调用记录渲染时炸 |
| `tool-bad-card-kind` | `card: 'generic'` 的 `kind` 不在宿主认识的那一组里（`other` / `execute` / `search` / `read` / `edit` / `delete` / `fetch`）。注册不报错，卡片渲染坏掉——我五个插件一起踩过 |
| `tool-bad-parameter-type` | `parameters` 里某个 `type` 写错（`"strin"`）。宿主把 `parameters` 渲染进 prompt、但**从不校验**调用值，所以这个 typo 只是悄悄把类型提示弄丢 |

### 浏览器半边：侧栏面板到底会不会出现

清单层只检查「声明了 client 平台就得有 `exports["./client"]`」，可这一步过了之后还能坏很多次。而且它坏得很安静：宿主半边照样跑、工具照样能用，只是侧栏里什么都没有——看起来像 UI bug，其实是打包/注册 bug。

所以这一层真的把那个 bundle 在一个子进程里跑一遍：造一个假的 `window.__ModuleLoader__`、假的 `require('react')`，再给一个 `ctx`——`effect` / `inject` 会立刻执行回调，其余服务（`sidebarRightTabs`、`slots`…）每被调用一次就记一条。

| 规则 | 抓什么 |
|---|---|
| `client-file-missing` | `exports["./client"]` 指的文件不存在 |
| `client-no-module-loader` | bundle 里没有 `window.__ModuleLoader__.load`——宿主根本不会执行它 |
| `client-load-not-called` | 文件能解析，但跑完没调用 `load`（常见：包在 `if (typeof window !== 'undefined')` 里，判断写错了） |
| `client-factory-throws` | `factory(require)` 抛 |
| `client-no-apply` | `factory` 返回的对象里没有 `apply` |
| `client-apply-throws` | `apply(ctx)` 抛 |
| `client-no-registration` | `apply` 跑完一次服务都没调用——面板不会出现 |
| `client-inject-missing-<service>` | `apply` 用了 `ctx.sidebarRightTabs` 但 `inject` 数组里没写它。cordis 不会把没声明的服务给你，于是 `ctx.sidebarRightTabs` 是 `undefined`，`apply` 一碰就抛（或静默什么都没注册） |
| `client-parse-failed` | 文件有语法错误。**单独判**：`SyntaxError` 说明 bundle 本身是坏的，别的报错说明是沙箱不够真，两者别混为一谈 |
| `client-unavailable` | 子进程没跑起来（warn）——这一层没跑，别把它当干净 |

### 市场层：提交之前就能知道会不会被打回

本地全绿之后，发布还会在提交门禁那儿停一次。停的原因通常只有三种，而且三种都能提前查：

| 规则 | 抓什么 |
|---|---|
| `market-duplicate-entry` | 这个仓库**已经在目录里**。再提一个 PR 就是同一仓库的第二条条目，reviewer 会拒。版本升级根本不需要 PR——目录条目只存 `url` |
| `market-npm-name-collision` | 另一个条目也在发同一个 npm 包，安装路径会互相盖 |
| `market-repo-too-new` | 仓库创建不满 24 小时。门禁会报 `0.0 days old` 然后**自己重跑**，PR 不会丢，但在那之前什么都不会合 |
| `market-no-repo` | `package.json` 里没有 GitHub 地址，没东西可提交 |
| `market-unavailable` | 目录拉不到（warn）——这几条没跑，别把它当干净 |

### 代码卫生

`lib-debugger`（error）、`lib-console-log`、`lib-hardcoded-path`（`C:\Users\...` 硬编码）、`lib-url-pathname`（`new URL(...).pathname` 在中文路径上会百分号编码，得用 `fileURLToPath`）、`node-too-old`（`engines.node` 写着 `>=18`，`lib/` 里却用了 `Object.groupBy`（21）或 `Promise.withResolvers`（22）。npm 对 `engines` 只是警告，照样装上，然后在 import 那一刻抛——用户看到的是「插件坏了」，不是版本不匹配）。字符串和注释里的同名文字不算。

### 构建产物：`src/` 和 `lib/` 谁更新

有 `src/` 的插件（TypeScript 源码 + 构建出来的 `lib/`）最容易在这件事上翻车，而且两种翻车的表现一模一样——**发出去的字节没人跑过**：

| 规则 | 抓什么 |
|---|---|
| `stale-build` | `src/` 比 `lib/` 新：构建没跑就发布了，tarball 里是上一次的产物 |
| `hand-edited-build` | `lib/` 比 `src/` 新：有人直接改了构建产物。下一次干净的构建会**静默丢掉**这些改动，所以发布的字节没法从 `src/` 复现出来 |

两条都只是 warn：有可能你就是要发手改的产物（我干过）。但发之前你得知道自己在发什么。

## 一个真实的例子

对一个刚从别人那儿接手、准备发布的插件跑 `publish_gate`：

```
✗ package.json starts with a UTF-8 BOM  [utf8-bom]
    A byte-order mark makes JSON.parse throw `Unexpected token` and npm publish
    fail with a parse error that never names the BOM.
✗ files does not include "lib"  [files-omits-lib]
    The published tarball will contain no code.
✗ cordis.patch.yml has no insert row  [no-insert-row]
    A patch with only overrides never mounts your plugin. This file has 1
    top-level `- id:` row — those patch entries that already exist in the tree,
    they do not add one.
✗ lib/index.js calls require() inside an ESM module  [require-in-esm]
4 blocker(s) — fix before publishing
```

这四条里有两条是发布四个插件时真实踩到的。

## 设计取舍

- **三层，按代价排序**：清单层最便宜、先跑；产物层要起一个 npm（约 1–2 秒）；运行时层要起一个 node 子进程。前一层没过的错误通常值得先修，但三层都会跑完——一次给全，比来回问好。
- **浏览器半边单独一层，不并进运行时层**：宿主半边的失败会抛错、会有日志；浏览器半边的失败是「什么都没发生」。两者的排查路径完全不同，所以各起一个子进程、各有一组规则、各自能单独跳过（`skipTools` / `skipClient`）。
- **产物层用 `npm pack --dry-run`，不用自己推 `files` 规则**：npm 的入包规则（`main` / `exports` 强制入包、README/LICENSE 强制入包、`.npmignore` 优先级）比自己实现的准。唯一的代价是它需要这台机器上有 npm，所以跑不起来时降级成 `pack-unavailable` 而不是报错。
- **运行时层真的执行插件代码**：这是唯一能回答「装上能不能用」的办法。代价是 `apply()` 会跑，所以：假 ctx 是 Proxy 不落盘、20 秒硬超时、`skipTools` 一键跳过。
- **`--ignore-scripts`**：dry run 不跑 `prepack`，否则检查会触发一次构建。代价是清单可能和真实产物不同，所以有 `pack-script-build` 把这件事说出来。
- **`publish_gate_verify` 比 shasum，不比版本号**：版本号相同而字节不同（发了又改、或本地根本没发）是最常见的自欺。`npm pack --dry-run` 的 shasum 和 registry 的 `dist.shasum` 是同一套算法，所以这个比较是精确的。
- **只读**：修不修由你定，每条 finding 都带 `fix` 文案。门禁的职责是把话说清楚，不是替你做决定——所以没有 `--fix`。
- **确定性**：全部规则是文件内容、子进程或 registry/GitHub API 检查，没有 LLM 调用——一条规则答错，你可以直接看规则。
- **自举**：这个插件的测试把九个已发布插件当 fixture，断言它们在门禁下零 blocker；规则如果有任何误报倾向，测试先炸。

## 开发

```sh
node --test                      # 67 个引擎单测
node test/integration.test.mjs   # 26 条集成断言（9 个真实插件作 fixture）
```

## License

MIT
