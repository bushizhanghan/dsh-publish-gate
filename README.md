# dsh-publish-gate — 帮你发布 DSH 插件的一键三连门禁

> **这个插件是给插件作者用的**：你写完一个 DSH 插件，想发 GitHub + npm + 插件市场，它帮你把发布前该查的全部查一遍，再给你照抄的命令清单。
>
> 发布一个 DSH 插件有七步，每一步都有一个**直到你付出代价才说话的坑**：`files` 忘了 `lib/` 于是发出去一个空包、PowerShell 写下的 BOM 让 `JSON.parse` 报一个不提 BOM 的错、patch 的 insert 行缩进错了于是插件装上了但**永远不加载**、裸包名让 granular token 收到一个既不说 token 也不说 scope 的 403。这个插件把整条链路的每个静默坑变成一条确定性检查。

六个 agent 工具：全量门禁、patch 专项、市场条目校验、版本推进、多插件体检、发布命令清单。

## 典型用法（写完插件后）

```
我写好了一个新插件 X，帮我发出去
→ agent 先调 publish_gate(X) 查所有静默坑
→ 有 blocker 就修，修完再跑
→ 全绿后调 publish_gate_commands(X, {version}) 拿 GitHub/npm/市场三步的命令，照抄执行
```

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-publish-gate
```
重启 DSH 后生效。**只读**：这个插件从不写你的插件目录。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `publish_gate` | 全量门禁：静态检查 + 网络检查，返回 `safeToPublish` |
| `publish_gate_patch` | 只查 `cordis.patch.yml`——「插件装了但工具没出现」的第一个怀疑对象 |
| `publish_gate_market` | 校验市场条目 YAML（url/name/category/description 双语） |
| `publish_gate_next_version` | 当前版本、是否已被 registry 占用、建议 bump 到多少 |
| `publish_gate_doctor` | 扫整个目录，按 blocker 数排序，看哪个插件还不能发 |
| `publish_gate_commands` | 按顺序列出发布命令，并标出这台机器已经走到哪一步 |

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
| `client-without-export` | 声明了 client 平台却没导出 `./client`，宿主半边在、侧栏永不出现 |
| `not-esm` | 没 `"type": "module"`，`import` 在加载时炸 |
| `insert-wrong-indent` | **insert 行没在 `- insert:` 底下**——顶层 `- id:` 是对已有条目的 patch，不是挂载 |
| `insert-missing-name` / `insert-name-mismatch` | 挂载名缺失或与 package.json 不一致 |
| `no-insert-row` | patch 里只有 override，永远不挂载 |
| `no-patch-file` | 有 `lib/index.js` 但没有 `cordis.patch.yml` |
| `no-name-export` / `no-apply-export` | 入口协议不完整 |
| `require-in-esm` | ESM 里 `require()` → `ERR_AMBIGUOUS_MODULE_SYNTAX`，报错不带行号 |
| `no-license` | 缺 LICENSE |
| `version-taken` | 这个版本已经在 registry 上，再发是 403 |

### 值得在发布前知道的（warn / info）
`unscoped-name`（granular token 的 403）、`repo-missing`、`patch-name-unresolvable`（junction 放错层级）、`no-readme` / `readme-no-install` / `readme-no-profile`、`license-mismatch`、`no-tests` / `no-test-files` / `no-test-script`、`no-engines`、`bad-repo-url`、`no-git` / `no-gitignore`，以及市场条目的 `market-*` 全系列。

## 一个真实的例子

对一个刚从别人那儿接手、准备发布的插件跑 `publish_gate`：

```
✗ package.json starts with a UTF-8 BOM  [utf8-bom]
    A byte-order mark makes JSON.parse throw `Unexpected token` and npm publish
    fail with a parse error that never names the BOM.
✗ files does not include "lib"  [files-omits-lib]
    The published tarball will contain no code.
✗ insert row "page-monitor" (line 173) is not inside an "- insert:" sequence  [insert-wrong-indent]
    A top-level `- id:` row is a patch on an existing entry, not a mount. The
    loader reports one stderr warning and boots without your plugin.
✗ lib/index.js calls require() inside an ESM module  [require-in-esm]
4 blocker(s) — fix before publishing
```

这四条里有两条是发布四个插件时真实踩到的。

## 设计取舍

- **静态检查不需要网络**：`publish_gate` 默认带网络检查（版本占用、repo 存在），但 `skipNetwork` 让它在离线和 CI 里同样可用；网络失败一律降级成「未知」，不让门禁本身变成障碍。
- **只读**：修不修由你定，每条 finding 都带 `fix` 文案。门禁的职责是把话说清楚，不是替你做决定。
- **确定性**：全部规则是文件内容或 registry/GitHub API 检查，没有 LLM 调用——一条规则答错，你可以直接看规则。
- **自举**：这个插件的测试把四个已发布插件当 fixture，断言它们在门禁下零 blocker；规则如果有任何误报倾向，测试先炸。

## 开发

```sh
node --test test/    # 18 个单测（含 4 个真实插件作 fixture）+ 16 项集成测试
```

## License

MIT
