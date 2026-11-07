# dsh-publish-gate — 帮你发布 DSH 插件的一键三连门禁

> **这个插件是给插件作者用的**：你写完一个 DSH 插件，想发 GitHub + npm + 插件市场，它帮你把发布前该查的全部查一遍，再给你照抄的命令清单。
>
> 发布一个 DSH 插件有七步，每一步都有一个**直到你付出代价才说话的坑**：`files` 忘了 `lib/` 于是发出去一个空包、PowerShell 写下的 BOM 让 `JSON.parse` 报一个不提 BOM 的错、patch 的 insert 行缩进错了于是插件装上了但**永远不加载**、裸包名让 granular token 收到一个既不说 token 也不说 scope 的 403。这个插件把整条链路的每个静默坑变成一条确定性检查。

八个 agent 工具：全量门禁、运行时注册检查、发后校验、patch 专项、市场条目校验、版本推进、多插件体检、发布命令清单。

门禁分三层：**清单层**看 package.json / patch / 入口源码，**产物层**真的跑一遍 `npm pack --dry-run` 看 npm 到底会发出什么，**运行时层**在独立子进程里 `import()` 入口并 `apply(ctx)` 一遍，看它到底注册了什么。

### 自检：看不见的 finding

`severity` 不是 `error`/`warn`/`info` 的 finding 会被所有计数器忽略，等于规则从没触发过。`publish_gate` 现在会把这类 finding 提升成一条 `internal-bad-severity` 的 error，测试里还有一条源码扫描盯着 `F(...)` 的第二个参数。这条网加上当天就抓到了我自己的同一个错误。

### 测试层：门禁真的会跑一遍你的测试

`tests-fail` / `tests-timeout` / `tests-not-run` 三条规则会以 `node --test` 在插件目录里真跑一次（不经过 `npm test`，因为脚本内容由作者决定、可能 shell 出去）。子进程会去掉继承来的 `NODE_TEST_CONTEXT`——否则当门禁本身跑在 `node --test` 里时，子进程进入 test-child 模式、一个摘要都不打印，看起来像"没有测试"。

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
| `version-behind-latest` | 本地版本比 registry 上的 `latest` **旧**。npm 会照收，但 `latest` 继续指向新版本——包上传了，按名字装的人永远拿不到，且没有任何报错 |
| `registry-unreachable` | registry 回了 500/429 —— 版本检查**没跑**，所以别把它当干净 |
| `npm-not-logged-in` | 这台机器上 npm 没有可用登录（`npm whoami` 报 ENEEDAUTH）。`npm publish` 会在 tarball 打好之后才失败 |
| `readme-wrong-package` | README 的安装命令写的是**另一个包名**（从别的插件抄过来没改）。照着装的人装到别的插件上，而且不会报错——那个包真的存在 |

### 值得在发布前知道的（warn / info）
`npm-scope-mismatch`（登录的账号不是包 scope 的所有者，PUT 会 403，而错误里既不说 token 也不说 scope——我为一个 403 花了一小时）、`unscoped-name`（granular token 的 403）、`repo-missing`、`patch-name-unresolvable`（junction 放错层级）、`inject-unused-service`（`inject` 里写了个拼错的服务名，cordis 一直等它，插件静默不激活）、`no-publish-config-access`（scoped 包没写 `publishConfig.access`，只是提醒，因为命令里本来就带 `--access public`）、`publish-config-registry`（`publishConfig.registry` 指到内网 registry，版本发到别人装不到的地方）、`no-readme` / `readme-no-install` / `readme-no-profile`、`license-mismatch`、`no-tests` / `no-test-files` / `no-test-script`、`no-engines`、`bad-repo-url`、`no-git` / `no-gitignore`、`readme-path-missing`（README 里写的 `test/xxx.mjs` 这类路径已经不存在了，照着敲就是 ENOENT）、`readme-tool-undocumented`（README 没提这个工具）/ `readme-test-count`（README 写的测试数和真实数不一致）、`changelog-missing-version`（要发的这个版本号在 CHANGELOG 里没有对应标题，npm 照样发，发布说明就永远落后一版）、`changelog-no-versions`（CHANGELOG 里没有版本标题，读者对不上自己装的那版）、`no-changelog`（只是提醒）、`changelog-not-shipped`（CHANGELOG 在本地但没进 tarball——npm 只强制带 README 和 LICENSE，你一直更新的那份文件在 registry 页面上看不见），以及市场条目的 `market-*` 全系列。

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
| `pack-ships-junk` | 包里带上了 `.bak-20261026` 这类备份或编辑器残留。`files: ["lib"]` 会把 `lib/` 里所有东西都打进去——包括你自己源码的上一版，而且发上去就永久公开 |
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
| `tool-no-description` | 工具没有 description。模型是靠 name + description + parameters 挑工具的，没有描述就只剩名字——工具发出去了，但基本选不中 |
| `tool-description-thin` | description 少于 30 字符，或者就是把工具名重复一遍。等于没写 |
| `tool-no-parameters` | execute 读 `args.x`，但整个 `parameters` 都没有。模型拿不到参数清单，不知道该传什么 |
| `tool-undeclared-param` | `execute` 读了 `args.x`，但 `parameters.properties` 里没有 `x`。模型只能传 schema 声明过的参数，所以这个值在真实调用里永远是 `undefined`——代码在，永远不跑，也不报错。`args.x`、`args['x']`、`const { x } = args` 三种写法都认 |
| `tool-output-invalid` | 工具返回的东西**自己的 output schema 不收**。宿主每个结果都拿 schema 校验，不匹配就抛 `ToolOutputError`——工具从第一次调用起就不可用，而报错只给一个 JSON 路径，不给是哪行代码返回的。只有点名 `call` 真的调了才检查。这个插件自己踩过：schema 收紧成 `additionalProperties: false`，但有一条错误分支还在返回 `{ ok, error }` |
| `tool-input-throws` | 把每个声明过的参数**塞一个错类型的值**去调，工具直接抛 `TypeError` 而不是回答。宿主从不拿 `parameters` 校验入参，所以这个值真的会到你的代码里——调用方拿到的是 `The "path" argument must be of type string`，插件日志里没有一行说是哪个工具。这条规则是在自己的工作区里跑出 **12 个真实崩溃** 之后才加的（`session`/`profile`/`casePath`/`workspace` 各一个入口），现在九个插件全绿。默认关：它会把每个工具都调一遍，用 `skip` 点名排除那些会开程序、写文件的 |

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
| `client-double-load` | 同一个 bundle 被注入了两次（它自己的 patch 一次，注入 `dsh-client-modules` 的侧边栏插件再一次）。loader 按 id 建工厂，第二次注册直接抛错，整个 Web 启动被中断——不是这个面板没了，是所有面板都没了。用 `if (window.__xLoaded) return; window.__xLoaded = true` 挡一下 |
| `client-parse-failed` | 文件有语法错误。**单独判**：`SyntaxError` 说明 bundle 本身是坏的，别的报错说明是沙箱不够真，两者别混为一谈 |
| `client-unavailable` | 子进程没跑起来（warn）——这一层没跑，别把它当干净 |

### 市场层：提交之前就能知道会不会被打回

本地全绿之后，发布还会在提交门禁那儿停一次。停的原因通常只有三种，而且三种都能提前查：

| 规则 | 抓什么 |
|---|---|
| `market-duplicate-entry` | 这个仓库**已经在目录里**。再提一个 PR 就是同一仓库的第二条条目，reviewer 会拒。版本升级根本不需要 PR——目录条目只存 `url` |
| `market-release-behind` | warn | 最新 GitHub release 比 package.json 旧（或新） | 目录里写着 1.2.7、release 资产还是 1.2.6 时，市场条目装的是旧代码，而描述是新版写的——维护者正是以「描述与 tarball 不符」驳回过一次提交 |
| `market-npm-name-collision` | 另一个条目也在发同一个 npm 包，安装路径会互相盖 |
| `market-repo-too-new` | 仓库创建不满 24 小时。门禁会报 `0.0 days old` 然后**自己重跑**，PR 不会丢，但在那之前什么都不会合 |
| `market-fork-of-listed` | 这个仓库是某个**已经在目录里**的仓库的 fork。两条条目装的代码抢同一批 id，两个都装就有一个被静默盖掉——而且 reviewer 会把"没写"当成"隐瞒 fork" |
| `market-fork-undisclosed` | 是 fork，但 README 和 package.json 里都没有上游的 `owner/repo` |
| `market-no-repo` | `package.json` 里没有 GitHub 地址，没东西可提交 |
| `market-unavailable` | 目录拉不到（warn）——这几条没跑，别把它当干净 |

### 代码卫生

`lib-debugger`（error）、`lib-console-log`、`lib-hardcoded-path`（`C:\Users\...` 硬编码）、`lib-url-pathname`（`new URL(...).pathname` 在中文路径上会百分号编码，得用 `fileURLToPath`）、`node-too-old`（`engines.node` 写着 `>=18`，`lib/` 里却用了 `Object.groupBy`（21）或 `Promise.withResolvers`（22）。npm 对 `engines` 只是警告，照样装上，然后在 import 那一刻抛——用户看到的是「插件坏了」，不是版本不匹配）。字符串和注释里的同名文字不算。

### 依赖真实性：`lib/` 里 import 的东西，消费者那边真的会装上吗

`npm install` 装一个包时只装它的 `dependencies`，**永远不装 `devDependencies`**。所以在你自己仓库里 `import 'x'` 能跑（依赖树是完整的），到了用户那边 `ERR_MODULE_NOT_FOUND`——插件装上了，然后加载失败，用户看到的是「这个插件坏了」。

| 规则 | 抓什么 |
|---|---|
| `undeclared-import` | `lib/` 里 import 了某个包，`package.json` 三个依赖字段里都没有。它在你机器上能解析，只是因为别的包把它提升（hoist）到了 `node_modules` |
| `dep-in-dev-only` | 只在 `devDependencies` 里声明。这是最常见的一种：写代码时 `npm i -D` 装上了，测试也全绿 |
| `unused-dependency` | `dependencies` 里声明了，`lib/` 里从没 import。每个装你的人都白下一份（info，因为有些包是运行时动态加载的） |

内置模块（`node:fs`、`fs/promises`）、相对路径、以及浏览器半边从宿主 `require` 拿到的 `react` 都不算。工具描述里那句 `require("react")` 是散文，也不是依赖——这条规则最早就是被它自己误报出来的。

### 构建产物：`src/` 和 `lib/` 谁更新

有 `src/` 的插件（TypeScript 源码 + 构建出来的 `lib/`）最容易在这件事上翻车，而且两种翻车的表现一模一样——**发出去的字节没人跑过**：

| 规则 | 抓什么 |
|---|---|
| `stale-build` | `src/` 比 `lib/` 新：构建没跑就发布了，tarball 里是上一次的产物 |
| `hand-edited-build` | `lib/` 比 `src/` 新：有人直接改了构建产物。下一次干净的构建会**静默丢掉**这些改动，所以发布的字节没法从 `src/` 复现出来 |

两条都只是 warn：有可能你就是要发手改的产物（我干过）。但发之前你得知道自己在发什么。

### 可追溯性：一周后你还能指出线上那包是哪份代码吗

发布是字节唯一一次离开你机器的时刻。如果这些字节既不在任何 commit 里、也没有 tag，那么一周后——包括你自己在内——没人说得清 registry 上那包是从哪份源码来的。

这不是假想：我发过一版 `1.2.7` 到 npm，仓库的 GitHub release 还停在 `1.2.6`，市场条目指向旧 tarball，维护者直接打回。

| 规则 | 抓什么 |
|---|---|
| `git-uncommitted` | 会进 tarball 的文件有未提交改动。发出去的字节不在任何 commit 里，以后复现不出来、也没法 bisect |
| `git-tag-missing` | HEAD 上没有 `v<version>` tag。发完之后这些字节的唯一记录就是 registry，GitHub release、changelog、市场条目都没法指向一个从没打过 tag 的 commit |
| `git-tag-elsewhere` | tag 存在但不在 HEAD 上：tag 和 tarball 是两份不同的字节，从那个 tag 构建出来的东西不是你刚发的东西 |
| `git-tag-unverified` | 读不到 `origin`（断网、私有仓库、没配 remote）。这是 **info**，不是 warn：提交是用 GitHub API 推的时候本地 HEAD 不是发出去的那个 commit，本地 tag 列表证明不了任何事。断网那天我有六个插件被误报「没有 tag」，六个都打了 |

都是 warn：本地试发、私有包、发完再补 tag 都合理。但「发完之后指不出是哪份代码」这件事，事后补不回来。

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
- **发完那几十秒不算失败**：npm 收下包会先回 202，然后六十秒到几分钟里这个版本在 registry 上根本不存在。这个插件自己的 0.8.1 实测是**四分钟**才出现。所以 `publish_gate_verify` 加了 `waitMs` 轮询；一轮等不到就返回 `pending: true`——那是「还没轮到」，不是「没发成功」。单次最多等 90 秒，因为宿主 120 秒就掐掉工具调用，剩下的只能再跑一次。
- **`publish_gate_verify` 比 shasum，不比版本号**：版本号相同而字节不同（发了又改、或本地根本没发）是最常见的自欺。`npm pack --dry-run` 的 shasum 和 registry 的 `dist.shasum` 是同一套算法，所以这个比较是精确的。
- **只读**：修不修由你定，每条 finding 都带 `fix` 文案。门禁的职责是把话说清楚，不是替你做决定——所以没有 `--fix`。
- **确定性**：全部规则是文件内容、子进程或 registry/GitHub API 检查，没有 LLM 调用——一条规则答错，你可以直接看规则。
- **自举**：这个插件的测试把九个已发布插件当 fixture，断言它们在门禁下零 blocker；规则如果有任何误报倾向，测试先炸。

## 开发

```sh
node --test                      # 118 个引擎单测
node test/integration.test.mjs   # 27 条集成断言（9 个真实插件作 fixture）
```

## License

MIT
