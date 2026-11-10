# Changelog

## 0.43.0

- `ship` 的 npm 步不再只看退出码：发完立刻用本地 tarball 的 shasum 去轮询 registry，确认线上就是这份字节才报 `verified: true`；等不到就报 `verified: false` 并让你跑 `publish_gate_verify`。这个插件自己每发一版都要手动轮询 35–250 秒，全链路一直缺最后一公里。
- 新增 `waitMs` 参数（默认 45000，上限 60000，因为单次工具调用只有 120 秒）。
- 单测 188 个，集成断言 40 条。

## 0.42.0

- `ship` 的 repo 步现在会把 `repository` 写进 package.json（仅当这次真的要建仓库/推代码，即 `confirm: true`）。没有它，npm 上没有源码链接，`publish_gate_status` 会永远回答「还没上 GitHub」——这条是本机真跑 `ship` 时发现的，之前所有发布都是我手写脚本补的。
- `publish_gate_ship` 的 `skipPack` / `skipTools` / `skipClient` 三个开关现在真的写在参数表里：它们一直在代码里读，却从没声明过——宿主只会把声明的参数交给模型，所以那三条分支永远走不到。
- 两个市场测试不再真连 api.github.com：它们让整套测试从 110 秒降到 50 秒，也不再吃 GitHub 的未认证配额。
- 单测 187 → 188。

## 0.41.0

**The push step could never have worked on a brand-new repository.**

Found by running the chain against real GitHub for the first time (a throwaway repo, since deleted by hand — this
token has no `delete_repo` scope): `repo` created the repository and set the topics, then `push` died with
`blob cordis.patch.yml → 409`.

The reason is GitHub's own rule: on a repository with no commits, every git-data endpoint answers 409
"Git Repository is empty". `POST /git/blobs` was the first call, so the first publish of any new plugin — the
common case — always failed one step before npm.

`pushWorktree` now treats 409 from the blob call as "this repository has no first commit yet" and hands off to
`pushByContents`, which writes the tree one file at a time through `PUT /contents` (the only API allowed to make
the first commit) and reports `method: 'contents'`. From the second push on, the blob/tree/commit path is used again.

Verified live against GitHub: first push into an empty repo returned `ok, method: contents, 3 files`; the second
push used the normal path; the file was then read back through the API. Unit test covers the 409 hand-off.
## 0.40.0

The market step was the one part of the chain I had never run through the plugin.

- **The `dsh-plugin` topic is now set for you.** The pull request template requires the repository to carry it;
  without it the entry is rejected even when everything else is right (that is how arg-guard came back). Creating
  or reusing a repository now also PUTs `/topics` with `dsh` and `dsh-plugin`, and the repo step says so.
- **The fork is synced before branching.** A fork that is behind upstream made the pull request carry every commit
  we were missing. It now calls `merge-upstream` first; 409 (conflict) and 404 (older forks) are not fatal.
- **Re-running no longer 422s.** A fresh fork has no branch to write to, and an existing entry needs its `sha` to
  be replaced. The step now creates the branch from the fork tip when missing, and sends `sha` when the file is
  already there.

Both are things I had done by hand in shell scripts for three earlier releases, which is exactly the evidence that
the plugin was not doing them.
## 0.39.0

Two errors that were not errors.

- `no-exports` was an error claiming that with only `main` "the plugin silently does not load". That is false:
  Node's ESM resolver falls back to `main` (verified with a bare `import '@me/mainonly'` against a package
  that has no `exports`). It is now a warning about pinning the public entry, and the text no longer claims
  a failure that does not happen.
- `no-license` was an error. npm publishes anyway and the code runs; what is missing is the licence itself.
  Now a warning.
- The `check` step said "the gate has no errors" when a dozen warnings were waiting. It now says
  "the gate has no errors (12 warnings left)" or "(no warnings either)".

A minimal but genuinely valid plugin — `main` + `type: module` + a patch — used to fail the gate and now passes
with warnings only, which is what it deserves.
## 0.38.0

Five arguments that used to be quietly reinterpreted.

- `publish_gate_next_version({ bump: 123 })` bumped `patch` and reported success. A wrong bump is now refused.
- `publish_gate_commands({ owner: 123 })` interpolated the number into GitHub URLs. It must be a non-empty string.
- `publish_gate_setup({ npmToken: 123 })` stored nothing, refused nothing and answered `ok: true`. Tokens and `npmUser`
  must be non-empty strings, and `forget` must be an array.
- `publish_gate_tools({ fuzz: "yes" })` fell through to `false`, so the report looked like "nothing throws" when
  nothing had been called. `fuzz` must be a real boolean.
- `publish_gate_doctor({ skipPack: "false" })` skipped the tarball because the check was truthy — the same class of bug
  that made `skipPack: "false"` skip every check in 0.24.0. It now requires `=== true`.

Found by driving all 19 tools with wrong-typed arguments (119 cases); the remaining acceptances are documented
fallbacks (a non-numeric `timeoutMs` uses the default), not silent reinterpretations.
## 0.37.0

Two places where the chain said something it had not checked.

- The `check` step ran `runStaticChecks` only — package.json and patch shape. A package whose
  tarball ships no entry file, or whose tools throw on registration, came back as "the gate has no
  errors". It now runs the artifact layer too (pack contents, tool registration, client probe), which
  is the same set `publish_gate` reports, so the two cannot disagree. Measured 3.6 s on this plugin.
- Creating a repository ignored the owner in `owner/name`: `/user/repos` always creates under the
  authenticated account, so `someorg/pkg` landed in the wrong place and the push that followed 404'd.
  It now asks `/user` and uses `/orgs/{owner}/repos` when the owner is somebody else.
## 0.36.1

- The market step is idempotent: it asks the catalogue for
  `data/plugins/<owner>__<repo>.yml` first. An entry carries only a url, so a new version needs no
  second pull request — and re-running ship no longer tries to recreate a branch that already exists.
  A 500 from GitHub is "could not tell", not "not listed".
- A repo with no `user.name`/`user.email` fails the git step with git's own sentence; it now says
  which two commands fix it.
## 0.36.0

`publish_gate_ship` defaulted to running the first four steps, then treated a *planned* npm step as
a passing one: `ok: true` on a run that published nothing. The two things that leaves wrong are
"did it actually publish" and "what does it still need from me".

- `confirm: true` now gates **everything that leaves your machine** — repo, push, npm, market — not
  just npm and market. Pushing code into a public repository is the same class of act.
- The default is all six steps; without `confirm` the outward five are listed as `planned` and
  `published` stays false. `ok` still means "nothing failed", so planning is not an error.
- Missing credentials come back as `needs: [{key, why, ask}]` instead of only a sentence buried in
  a step detail, and a missing npm token is caught before npm sees it.
- `~/.dsh/dsh-publish-gate/state.json` remembers what was shipped (version, repo, pull request),
  so `publish_gate_status` can say "you already shipped 0.35.1". No tokens are stored there.

## 0.35.1

0.35.0 read `ctx.credentials` but never declared it. Cordis resolves services off the context, so
on a host that registers the store while plugins are loading, the three new tools would have reported
"no credential store" and asked for the tokens again — the one thing this feature exists to avoid.
The plugin now declares `credentials` in `inject`, and a test asserts it stays declared.

## 0.35.0

The gate could tell you a package was fine; it could not get one published. That gap needed a
person with a terminal and a memory for which token went where.

- `publish_gate_setup` takes the npm and GitHub tokens **once** and puts them in the host's own
  credential store, so every later run reads them instead of asking again. It answers with which
  references are configured, never with a value.
- `publish_gate_status` says where this plugin is on the chain: entry file, repository and its age,
  whether the market gate is open, whether npm already has this version.
- `publish_gate_ship` runs the chain step by step — check, git, repo, push, npm, market — and stops
  at the first failure instead of reporting a partial run as success. `npm` and `market` need
  `confirm: true`; without it they are planned, not executed.
- The result carries `eta`: the catalogue refuses repositories younger than a day, so "when can this
  be listed" has an exact answer that is not "whenever".
- A push bug found by its own test: the branch was moved to `commit.sha` (the response object)
  instead of `commit.data.sha`, which would have failed on every real upload.

## 0.34.0

Every release of this plugin (and the nine around it) opened with the same hand-written script:
bump `package.json`, splice a heading into `CHANGELOG.md`. Those scripts are where CRLF turned
into LF, where a section got duplicated, and where a heading landed three blank lines away from the
previous one. `publish_gate_release` does that part, and shows the plan first.

- `bump` (patch/minor/major) or an explicit `version`; refuses anything not newer than the current
  one, because "release 1.0.0" on a 1.2.3 package is a typo, not an intention.
- Writes `CHANGELOG.md` in whatever line ending the file already used, collapses a naive splice's
  three blank lines, and does nothing when the section already exists.
- `apply` defaults to false. It does not write prose for you, does not tag, and does not publish.

## 0.33.0

A plugin does not fail loudly when its mount id is already taken. The host inserts both rows,
keeps one, silently drops the other, and the loser looks installed and does nothing. That is the
exact objection a market reviewer raised against a fork - and nothing in the gate could see it.

- `mount-id-collision` (error): reads the ids this package claims through its own `insert:` rows
  and compares them with every other package installed in the profile. Only `insert:` rows count -
  `patch:` rows address an id that already exists and must not be treated as claiming one.
- Runs offline against whatever is installed, so it answers "will this collide on *this* machine",
  which is the only place the answer exists.
- Found a live one on the first run: `@bushizhanghan/dsh-workmate` and `dsh-workbuddy` both insert
  `llm-workbuddy`.
- Two tests were also making live GitHub calls and only passed when the API happened to answer;
  they now inject `releaseInfo: {}` like the rest. A test that needs the network is a test that
  fails on a plane.

## 0.32.0

`readme-tool-undocumented` caught a tool that exists but is never mentioned. The other direction
was unchecked: a README that keeps advertising a tool you renamed or deleted, so a reader follows
the docs into "unknown tool".

- Extracts every identifier under the package's own tool prefix (the longest shared prefix ending
  in `_`, so `publish_gate_`) and reports the ones that are not registered.
- Only runs when at least two tools share a prefix - one tool means no prefix, and guessing one
  from a single name would match unrelated words.
- Severity `warn`: a stale README is not a broken package, but it is a broken promise.

## 0.31.0

`publish_gate_drift` compared file **sizes**. That misses the most common silent rebuild: a
change that keeps every file the same length. It now compares **sha256** of each file (16 hex
characters, enough that two builds of the same file never collide).

- Local side: hashed from `npm pack --dry-run --json`'s own file list, so only files that would
  actually ship are compared - never `test/` or `.git`.
- Live side: hashed while the tarball is already extracted, so this costs one `readFileSync` per
  file, no second download.
- Falls back to size when only one side is hashed, and says nothing it cannot prove.

Verified on a real plugin: a clean checkout of `dsh-page-monitor` against its published 0.1.5 is
`same: true`; the same checkout with one character changed - same byte length - is reported as
`~1 changed`.

## 0.30.0

Before this, the gate could tell you whether a publish was *allowed*; it could not tell you what
that publish would *change*. `publish_gate_drift` compares the tarball you have now with the
tarball that is live: added files, removed files, and files whose size changed.

- Answers the question you actually ask before shipping a version bump — did the build run, is the
  debug file in there, did `files` start including something new.
- `against` picks the version; default is the latest published one.
- An unreadable registry is `drift-unavailable` (warn) and says in the detail that this is **not**
  the same as "no changes" — the whole point of the last few releases.
- Sizes come from extracting and stat-ing, not from `tar -tvzf`: the bsdtar that ships with Windows
  prints a localised date (`10月 26  1985`) and the only number nearby is the year, which silently
  turned every file into "added".

## 0.29.0

- **`bin-target-missing`** (error): a command in `bin` pointing at a file that does not exist.
  npm still links it, so the installed package puts a command on PATH that dies on the first run.
- **`bin-no-shebang`** (warn): the target exists but has no `#!` line. Windows runs it anyway; on
  unix the shell executes the file itself and the error you see is a shell syntax error.
- **`no-patch-file` no longer fires for libraries.** It used to report any package with
  `lib/index.js` and no `cordis.patch.yml`, which made `@deepseek-ai/dsh-atomic-write` and
  `dsh-tui` look broken. A package with no `dsh` field is not a bundle and is mounted by nothing;
  only a package that declares itself one owes the host a patch.
- No `pack-omits-bin` rule on purpose: npm force-includes `bin` targets, so a tarball cannot lose
  one. A test now asserts that, so nobody adds the rule back after a bad reflex.

## 0.28.0

Two ways a subpath export can be a promise with nothing behind it. Both used to pass the gate,
because only `exports["."]` and `exports["./client"]` were ever looked at.

- **`exports-target-missing`** (error): a key like `"./engine"` pointing at a file nobody wrote.
  `exportTargets()` now walks the whole map, conditions and arrays included, and skips patterns
  (`*`) because those resolve at runtime.
- **`pack-omits-export`** (error): the file exists in the checkout but `files` never packs it, so
  the failure only appears after install. npm force-includes `main` and whatever `exports["."]`
  names — it does not extend that courtesy to other subpaths.
- `"."` and `"./client"` stay with `entry-path-missing` and `client-file-missing`, so one broken
  path is still one finding, not two.
- 33 real published plugins: neither rule fires once, so the new checks are not trading false
  positives for coverage.

## 0.27.0

A workspace root is not a flat list of directories, and the sweep used to treat it as one.

- **`publish_gate_doctor` now reads the workspace manifest.** `pnpm-workspace.yaml` (`packages:`) and
  `package.json` (`workspaces`, array or `{packages}`) are expanded one level, so a monorepo that
  keeps its plugins under `packages/*` or `plugins/*` no longer reports "no plugin checkout found".
  Direct children are still scanned, and a root with nothing at all now says so instead of
  returning an empty success.
- Quoted globs (`- 'packages/*'`) are unwrapped; a stray quote used to send the expansion at a
  directory literally named `'packages`.
- `**` patterns are skipped rather than half-expanded, because a guess there would silently miss
  packages.

## 0.26.1

Three places where "could not check" was printed as "nothing to report". All three are the same
mistake the gate exists to catch, so they get the same treatment: say what did not run.

- **A blocked GitHub API silently removed three market checks.** The repo-age check and both fork
  checks read `GET /repos/:slug`, and a 403 (unauthenticated GitHub allows 60 requests an hour), a
  5xx or a timeout all landed in an empty `catch`. A fork submission then reached a reviewer with
  its upstream undisclosed, and the gate had said nothing. Now a warn says *three market checks did
  not run*, because that is what happened.
- **An unreadable `releases/latest` looked like a release that matches.** 404 is a real answer
  (this repository has no release) and stays quiet; every other outcome is now
  `market-release-unverified` (info) instead of silence.
- **A `package.json` that does not parse was reported as "no package.json".** `publish_gate_commands`,
  `publish_gate_next_version` and `publish_gate_verify` now return the parser's own sentence, file
  and position included, instead of sending the caller to look for a file that is right there.
- README: the `market-release-behind` row had four cells in a two-column table; both new rules are
  now documented.

## 0.26.0

Nothing new to detect. This release makes the gate answerable — where to argue with it, and what
it can repair without being asked to think.

- **A feedback section at the top of the README**, because a gate whose false positives are never
  reported stays wrong forever. It asks for the two things that are actually useful: the markdown
  output of a rule you think is wrong, and the original error from a publish that broke in a way
  the gate did not mention. Every reported shape becomes a fixed case in `test/corpus.test.mjs`.
- **`publish_gate_fix`**: the mechanical half, and only that half. It sets `publishConfig.access`
  for a scoped name (npm publishes it as restricted otherwise, and the error names neither the
  setting nor the scope) and adds the missing entry directory or mount patch to an **existing**
  `files` list. Dry run by default. It never creates a `files` list, never touches code, versions
  or dependencies: every other finding stays a finding.
- **`git-uncommitted` was blind inside a monorepo.** `git status --porcelain` prints paths
  relative to the *repository* root even when git runs in a subdirectory, so a plugin that lives in
  a monorepo compared its tarball paths against names it never contained and reported nothing. The
  output is now rebased on `git rev-parse --show-prefix`.
- `renderMarkdown` ended without a newline when there was nothing to report.

## 0.25.1

An independent review of 0.25.0 found six real defects. All fixed; no rule was added.

- **`publish_gate_smoke` said `ok: true` after verifying nothing.** Every download, extraction
  or unsafe-tarball failure becomes a `candidate-unavailable` warning, so "no errors" was true on
  an empty result — a 404 from the registry looked like a pass. `ok` now also requires that
  something was actually unpacked, and the result carries `verified`. `publish_gate_update` had
  the same hole and got the same treatment.
- **The generated CI started with `npm ci`**, which exits 1 unless the repository carries a
  lockfile — this repository and all nine siblings do not. It now runs `npm install --ignore-scripts`.
- **The generated CI's `node --test` was red on a fresh clone**, because this package's own
  integration suite points the gate at sibling plugin checkouts that only exist on the author's
  machine. That suite now skips with a clear message instead of failing.
- **A tarball link was still a way out of the extraction directory.** `tar -tzf` lists names but
  not link targets; a second pass with `tar -tvzf` refuses any member whose type flag is `l` or
  `h`. npm tarballs never carry links.
- **No size limit on a downloaded tarball.** Now capped at 64 MB (`maxBytes`), because a registry
  is not a trusted place and an unbounded read is a memory bomb on the checker's machine.
- **`unsafeTarEntry` refused legal filenames.** It tested `p.includes('..')`, so `a..b.js` was
  rejected; it now only refuses a whole `..` path segment.
- **Metadata fields were errors in the docs and warnings in the code.**
  `description`/`license`/`repository`/`author` stay warnings (19 of 29 real plugins are
  missing at least one and load fine), and the README table now says so.
- **`publish_gate_doctor` skipped every plugin whose entry was not under `lib/`** — it used a
  hardcoded path while the rest of the gate resolves `exports['.']`/`main`. It now uses
  `entryFile()`.
- **`profile` in the smoke tool was an unvalidated path segment**, so `../../..` could point the
  unpack outside `~/.dsh/profiles`. Now restricted to `[\w.-]+`.
- CI's entry probe now resolves nested conditional exports the same way `entryFile()` does, so
  `exports['.'] = { default: { import: … } }` no longer reads as `[object Object]`.

## 0.25.0

Everything the 0.24.0 audit suggested, built. Two new tools, one generated file, one
regression corpus, and one manifest field that was being asked for in a note instead of
being shown as JSON.

- **`publish_gate_smoke`** — the strongest pre-install check short of installing. It downloads
  the exact tarball the registry would hand an installer, unpacks it **inside the profile's own
  node_modules** so the plugin's bare imports resolve against what is really installed, imports
  the entry and runs `apply(ctx)`. `publish_gate_update` does the same work in a system temp
  directory, where a plugin with a normal dependency fails with ERR_MODULE_NOT_FOUND and looks
  broken. Verified against a real published plugin: 0.8 s, five tools registered, temp dir gone.
- **`publish_gate_ci`** — emits `.github/workflows/publish-gate.yml`. It keeps only the two
  checks a runner can honestly make: `node --test`, and "is the resolved entry file (plus the
  declared `cordis.patch.yml`) inside the tarball npm would publish". It does not pretend to run
  the full gate — a runner has no profile, no host to import into, and no access to your scope.
- **`format: "markdown"`** on `publish_gate` and `publish_gate_doctor` — the same findings as a
  table you can paste into an issue or a PR comment. `renderMarkdown()` is a twin of
  `renderReport()`, not a second implementation of the checks.
- **Regression corpus** (`test/corpus.test.mjs`) — one fixture per real plugin shape that the gate
  used to call broken: `@liustack/modlens` (entry in `dsh/`), `@michengai/dsh-codex-ui` (object
  `exports["./client"]`), `@tt-a1i/archify-dsh` (patch-only library), the multi-line
  `export { apply, inject }` form, `dsh-workbuddy`'s TypeScript specs, and an org scope. Every case
  names the package it came from, so a future rule change that reintroduces the false positive
  fails here instead of on someone else's plugin.
- **`publish_gate_commands` now returns `manifestFix`** for a scoped package without
  `publishConfig.access`: the exact JSON to merge into package.json, instead of a sentence telling
  you to write it. This package now declares it too, which is why its own gate is silent.
- Tests: 147 (was 139).

## 0.24.0

One full audit pass over the gate itself: read-only reviews of both source files plus a sweep
against 27 real third-party plugins already installed in this profile. Everything below is a
defect the gate had, not a feature it lacked.

Fixed — the gate was wrong on real packages:

- `pack-omits-lib` judged "does the tarball carry code" by looking for `lib/`, so every package
  whose entry is `dsh/index.js`, `index.mjs` or `dist/` (`@liustack/modlens`, `@liustack/pptwise`,
  `@feng0531/dsh-code-review`) was reported as shipping nothing. It now resolves the entry with
  `entryFile()` and asks whether *that* file made it into the tarball.
- `pack-omits-client` only understood the string form of `exports["./client"]`; the object form
  (`{ types, default }`) is the common one, so four of five packages with a panel were never checked.
- `clientTarget` returned the raw object, so `String(...)` produced `[object Object]` and the whole
  client layer silently skipped. It now picks the string out recursively.
- `checkEntrySource`, `checkInjectCoverage` and `publish_gate_doctor` all assumed `lib/index.js`.
- `hand-edited-build` deleted: a normal build reads `src` then writes `lib`, so the rule fired after
  every healthy build. A rule that cannot tell those apart trains people to ignore it.
- `publish-served` claimed "matches" when either shasum was missing. Missing evidence is now
  `publish-served-unverified` (warn).
- `license-mismatch` looked for the SPDX id as a literal in the LICENSE body, so Apache-2.0,
  BSD-3-Clause and MPL-2.0 were always reported and only MIT passed by luck. It now probes each
  licence for its actual wording.
- `version-behind-latest` flagged legitimate backports published under `--tag legacy` as errors.
- `market-duplicate-entry` compared URLs by substring, so `me/pkg` matched `me/pkg-extra`.
- `checkMarketEntry` threw `text.trim is not a function` for any non-string.
- `insert-missing-name` demanded `name:` on the very next line; `patch` treated a column-0 comment
  as the end of the `- insert:` block, so later rows were read as top-level overrides.
- `no-test-files` was not recursive and ignored `.spec.ts` (dsh-workbuddy's whole `tests/` directory).
- `test-script-dir-arg` fired on `node --test test/engine.test.mjs`, a legal single file.
- `npm-scope-mismatch` compared `npm whoami` (a user) against the scope (an org) — downgraded to info.
- `inject-missing-*` matched string literals, so prose about `ctx.webServer` counted as a use.
- A patch-only package that mounts someone else's service and never itself
  (`@tt-a1i/archify-dsh` inserts `dsh-skill-filesystem`) was told it forgot `export function apply`.
  New `mountsSelf()` ends that: a library owes the host nothing.
- `checkVersionTaken` lost its `dir` parameter in one edit and the resulting ReferenceError was
  swallowed by the function's own `catch {}` — the rule went silent instead of failing loudly.
- Duplicate rules collapsed: `files-omits-lib` / `files-omits-patch` became info because the
  artifact layer already reports the same gap as an error.

Fixed — the tools lied to callers:

- Every `skip*` flag was read for truthiness, so `skipPack: "false"` skipped the checks and returned
  `safeToPublish: true`. All of them are now `=== true`.
- `publish_gate_tools` accepted `skip: "name"` as a string, dropped it to `[]`, and then fuzzed every
  tool including the ones that open applications. Non-array is now refused.
- `publish_gate_market` passed unvalidated `text` straight into the parser.
- `publish_gate_verify` with a non-string `version` reported "not published" instead of refusing.
- Tool timeouts are declared as 120 s, which is the host's own ceiling; the previous 240 s was a
  promise nothing could keep.
- Dead `staticGate`, dead `SCOPED`, and `cfg.testTimeoutMs` (undefined at every call) are gone.

## 0.23.0

- New tool `publish_gate_update` (the eleventh): answer "should I take this update?" BEFORE
  installing it. Every updater in the market rolls back after the new build fails to boot; this
  downloads the exact tarball the registry would hand an installer, unpacks it into a temp
  directory and runs the gate's artifact and runtime layers on it — does the entry import, does
  apply() register, does the tarball carry code, does a tool throw on a wrong-typed argument.
  Checkout-only rules (git, market, tests, links, pack size) are filtered out, because an
  extracted tarball has none of those and they would bury the verdict.
- `candidate-same-version` (info), `candidate-older` (warn: dist-tags.latest can move backwards
  after an unpublish, and following it swaps a working install for an older build),
  `candidate-unavailable` (warn, and its detail says this is NOT a clean verdict).
- Fixed three false positives found by running the gate on 31 real third-party plugins:
  `files-omits-lib` no longer demands a lib/ from a package whose entry lives elsewhere
  (@liustack/modlens ships dsh/index.js and has no lib/ at all); `tool-input-throws` no longer
  reports a deliberate guard that names its own tool — only a raw Node error that leaves the
  caller with no idea which tool threw; and the client probe now runs ctx.inject(deps, fn)
  callbacks with a scoped ctx instead of fn() with no argument, so registrations behind an
  optional service are seen (modlens mounts its whole settings card that way).
- `client-no-registration` is suppressed when the source clearly reaches a registration through
  a promise, generator or inject callback the synchronous probe cannot follow.

## 0.22.0

- New tool `publish_gate_link` (the tenth): the local-development layer. It answers "is the code the
  host loads the code I just edited?" from the profile's own files — `<profile>/node_modules`,
  `<profile>/node_modules/.modules.yaml`, `<profile>/cordis.patch.yml` — with no network and no
  package manager. Every failure on this path is silent: the plugin simply never appears.
- `link-not-installed` (info): the profile has no entry for this package. Normal before the first
  local install, so it does not raise the blocker count.
- `link-target-missing` (error): the entry is a link whose target is gone, or whose target has no
  parseable `package.json`. A dead junction makes the host resolve the package to nothing — this is
  what broke this machine's Web UI once, with no error anywhere.
- `link-stale-copy` (warn): the entry is a plain directory, not a link, and its version differs from
  the checkout. Edits to `lib/` never reach the profile while the checkout's own tests stay green.
- `pnpm-store-conflict` (warn): the profile's pnpm store major differs from the bundled pnpm's (11).
  `dsh plugin add link:` then fails with `ERR_PNPM_UNEXPECTED_STORE` before installing anything, and
  the message names neither the profile nor the major to match. Read from `storeDir` in
  `.modules.yaml`; measured on this profile: `...\AppData\Local\pnpm\store\v11`, so v11 vs v11 is
  clean and only a v10 store is flagged.
- `patch-entry-top-level` (error): the package's row in the profile patch is a top-level `- id:`
  entry. A top-level row overrides an entry that already exists; it does not add one, so the plugin
  installs, loads, and never appears. This profile currently has **zero** `insert:` blocks and every
  row is top-level — exactly the shape the rule exists to catch.
- The link kind is reported as `junction` / `symlink` / `copy` / `missing`: Node reports a junction
  and a directory symlink identically (`lstat().isSymbolicLink()`), so the junction is identified by
  `realpathSync(p) !== p`, the check that distinguishes the form `mklink /J` creates without admin
  rights from the one that needs them.
- Tests: 131 engine tests (six new, one per rule, each against a temp profile — the real profile is
  never read or written) and 32 integration assertions.

## 0.21.0

- The runtime layer no longer assumes the entry is `lib/index.js`. It resolves `exports["."]` →
  `main` → `lib/index.js`. Measured against the thirty-one plugins installed in this profile, the
  old guess produced **twenty false "entry throws when imported" errors**; two of those plugins ship
  `index.mjs` with no `lib/` at all.
- `entry-missing` (error): the manifest names no file that exists, so there is nothing to import.
- `entry-import-unresolved` (warn): the entry imports a bare package that is not installed beside
  it and is a host-provided peer (`@deepseek-ai/*` or a declared `peerDependencies` entry). That is
  not a defect — but a bare import of something the host does *not* provide fails identically.
- `lib-console-log` reports **once per file with a count**, and never for the client bundle. One
  bundled plugin carried 459 `console.log` calls and produced 459 warnings, which is how a gate gets
  ignored; in a browser bundle `console.log` is the debug channel, not host-log residue.
- `unused-dependency` is skipped for packages that ship a client bundle: the bundler inlines those
  dependencies, so the code is in the bundle and "lib/ never imports it" is true but not actionable.

## 0.20.0

- `publish_gate_commands` now agrees with the rules: a prerelease version gets `npm publish --tag next`
  instead of a bare publish that would move `latest`.
- New step `tag the shipped commit` (`git tag v<version> && git push origin v<version>`). The gate has
  warned about a missing tag since 0.5.0 and the command list never mentioned tagging — I wrote a
  separate script to do it because the instructions never said to.

## 0.19.0

- `prerelease-published-as-latest` (warn): a `-beta` / `-rc` version with no `publishConfig.tag`.
  npm publishes to `latest` whatever the suffix says, so `npm i <name>` starts handing everyone an
  unfinished build and nothing warns.
- `publish-tag-not-latest` (warn): the version is on the registry but `dist-tags.latest` points at an
  older one. That is what `--tag next` does when you meant to release: the release looks shipped and
  is not what anyone installs.
- README: dropped a made-up `test/…` example path — `readme-path-missing` caught my own prose.

## 0.18.0

- `readme-path-missing` (warn): a README that names `test/…`, `lib/…`, `scripts/…` files that no longer
  exist. Rename a file and the README keeps telling people to run something that returns ENOENT;
  nothing else in the repo notices. Only repo-relative paths under directories a plugin owns, so a
  tutorial example is not a finding.
- Verified over all nine plugins in this workspace: no false positives, all nine still `e0 w0`.

## 0.17.0

- `changelog-not-shipped` (warn): a CHANGELOG.md that exists on disk but is not in the tarball. npm
  force-includes README and LICENSE and nothing else, so the file you keep updating never reaches the
  registry page. Hit it the first time I added a changelog and had to add it to `files` by hand.
- `git-tag-unverified` (info): origin could not be read, so the tag was not checked. Previously this
  fell back to the local tag list and claimed a missing tag — six of my nine plugins were flagged on a
  day GitHub was unreachable, and all six were tagged. The local list proves nothing when the commit
  was pushed through the API and local HEAD is not the shipped commit.
- First end-to-end run of the gate with the test layer over all nine plugins in this workspace: every
  suite passed, and the tag rule was the only false positive.

- `changelog-not-shipped` (warn): a CHANGELOG.md that exists on disk but is not in the tarball. npm
  force-includes README and LICENSE and nothing else, so the file you keep updating never reaches the
  registry page. Hit it the first time I added a changelog and had to add it to `files` by hand.
- First end-to-end run of the gate with the test layer over all nine plugins in this workspace.

## 0.16.0

- `market-release-behind` (warn): the newest GitHub release is older (or newer) than package.json. A
  catalogue entry may install `releases/latest/download/<asset>`, so a lagging release serves code the
  description no longer describes — a reviewer blocked a submission for exactly that.
- `straySeverities` + `internal-bad-severity`: a finding whose severity is not error/warn/info is counted
  by nothing and reported nowhere, so the rule looks like it never fires. `publish_gate` now turns any such
  finding into a loud error instead of dropping it.
- The source scan added in 0.15.0 caught the same mistake again while building this version: a string
  replace aimed at RULE_ORDER matched an earlier `F(...)` call and wrote the new rule name into a severity
  slot. Fixed, and the fix now goes through the RULE_ORDER slice instead of a global replace.

## 0.15.0

- Three rules shipped with a *rule name* in their severity slot: `market-repo-too-new`,
  `test-script-dir-arg` and `tool-missing-output-schema` were built as
  `F(rule, "some-other-rule", "a-third-rule", "warn", title, ...)`, because a string replace aimed at
  RULE_ORDER matched an earlier `F(...)` call instead and pushed the new names into its arguments.
  Nothing failed: a finding whose severity is not error/warn/info falls out of every counter and never
  reaches the report, so the rules looked like they simply never fired. Fixed all three, added the six
  rule names that never made it into RULE_ORDER, and added a source scan that fails when any `F(...)`
  call passes something other than an error/warn/info literal (or a ternary of two of them).

## 0.14.0

- New test layer: `checkTestRun` runs `node --test` in the plugin directory and reports `tests-fail`
  (error), `tests-timeout` (warn) and `tests-not-run` (warn). Every other layer reads the paperwork —
  the manifest, the tarball, the registry — while nine of my own plugins shipped
  `"test": "node --test test/"`, which throws MODULE_NOT_FOUND on Node 22+ and would have been caught
  by simply running it. The child drops the inherited NODE_TEST_CONTEXT, because a gate that runs
  inside `node --test` would otherwise start the suite in test-child mode and see no summary at all.

## 0.13.1

- The tag check now asks `git ls-remote origin` instead of `git tag --points-at HEAD`. When the commit is pushed
  through the GitHub API the local HEAD is not the remote one, so the local form reported `git-tag-missing` on
  seven of my nine plugins whose tag existed all along. It now compares the tag against the shipped branch
  head and stays silent when the remote cannot be reached — a check that cannot see the truth must not claim
  a defect.
## 0.13.0

- `market-fork-of-listed` / `market-fork-undisclosed` (warn): the repo is a GitHub fork whose parent is
  already in the catalogue, and nothing says so. A submission was blocked for exactly this: the entry
  described the fork as if it were original work, and both plugins claim the same provider id, so installing
  both silently shadows one of them. The check uses the `fork` and `parent.full_name` fields of the repo
  metadata the market layer already fetches.
## 0.12.0

- `pack-ships-junk` (warn): the tarball carries `.bak-*`, `.orig`, `.swp`, `.log`, `~` or `.DS_Store` debris.
  Naming a directory in `files` takes everything inside it, so a `lib/client.js.bak-20261026` left behind
  during a fix ships to every consumer and stays on npm permanently. Both weapp-loop and page-monitor had
  exactly that file during this session; both were deleted by hand before this rule existed.
## 0.11.0

- `tool-no-description` (error), `tool-description-thin` (warn), `tool-no-parameters` (error): the host
  renders name + description + parameters into the prompt and nothing else, so those three fields are the
  tool's entire specification. A tool with no description is a name in a list; a tool that reads args with no
  schema never receives them. All nine of my plugins were clean, so this guards the shape rather than a
  specific crash — the first two fixtures that had `description: 'd'` did fail, which is the point.
## 0.10.0

- `client-double-load` (warn): the client probe now evaluates the bundle a second time against the same
  `window`, with a loader that throws on a repeated registration. A bundle inserted by two patches (its own,
  plus any sidebar plugin that injects `dsh-client-modules`) aborted web boot this way. A window-level guard
  makes it a no-op, which is what the recommended bundle shape now shows.
## 0.9.0

- `checkChangelog()`: `changelog-missing-version` (warn), `changelog-no-versions` (warn), `no-changelog` (info).
  The changelog is the only place a user can learn what a version changed; a bump without an entry is silent
  drift, because npm publishes it anyway and the release notes stay one version behind. Headings accept
  `## 1.2.3`, `### [v1.2.3]` and `# v1.2.3`.
- An `engines-missing` rule was written and then deleted: `no-engines` already existed. Two rules for one
  condition would have reported the same gap twice.
## 0.8.2

- `publish_gate_verify` now returns `pending: true` when the wait runs out with the version still invisible.
  Measured on 0.8.1 itself: the version appeared **four minutes** after `npm publish`, so one call cannot
  outwait it — the cap is 90 s because the host kills a tool call at 120 s. `pending` says "run it again",
  which is a different answer from "the registry holds different bytes".
## 0.8.1

- `publish_gate_verify` gained `waitMs` (capped at 90 s) and reports `waitedMs`. npm answers 202 and keeps
  the version invisible for 60–180 s after a publish, so the single-shot check reported "not on the registry"
  for releases that had already succeeded — it happened on this plugin own 0.8.0 publish, which stayed
  invisible for over three minutes. `waitForPublished()` polls until the shasum appears; `waitMs: 0` keeps
  the old single-shot behaviour, and a real mismatch stops the poll immediately.
## 0.8.0

- `tool-input-throws` (error): `publish_gate_tools` gained `fuzz` and `skip`. With `fuzz: true` it drives
  every declared parameter with a wrong-typed value and reports the tools that throw instead of answering.
  The host never validates a call against `parameters`, so those values really arrive — this rule exists
  because the same sweep found 12 real crashes across this workspace's own plugins (a number reaching
  `path.join` via `session`, `profile`, `casePath` and `workspace`), all of which handed the caller a raw
  Node TypeError. Only a throw counts: a filter that ignores a number and returns the unfiltered list still
  answers, and every optional boolean treats any truthy value the same way.
- One finding per tool+parameter, not one per wrong value.
## 0.7.1

- Fixed: a non-string `dir` made every path tool throw a raw Node `TypeError`
  (`The "path" argument must be of type string. Received type number (123)`).
  The host never validates tool input against `parameters`, so a number or an
  object really does reach `path.join`. A wrong type is now refused with a
  message, and it deliberately does NOT fall back to the cwd — that would gate a
  different plugin than the one that was asked for.
- Integration test added: every tool that takes `dir` is driven with `123`,
  `true`, `{}` and `[]` and must answer with `ok: false`, never throw.

## 0.7.0

- `tool-output-invalid` (error): a tool result its own `output.schema` rejects. The host validates every
  result and throws `ToolOutputError`, so the tool is unusable from the first call. Only checked when the
  caller names the tool in `call`, because calling a tool can launch applications or write files.
- `npm-not-logged-in` (error) / `npm-scope-mismatch` (warn): ask npm who it is before spending a publish.
  ENEEDAUTH and the 403 that names neither the token nor the scope both become a message instead of a loss.
- `readme-wrong-package` (error): the README install line names a different package — a README copied from
  another plugin. Whoever follows it installs something else, and nothing fails because that package exists.
## 0.6.0

- New rule `tool-undeclared-param`: a tool whose `execute` reads `args.x` that
  `parameters.properties` never declares. The host renders `parameters` into the
  prompt and passes the model nothing else, so that value is undefined on every
  real call — the code path exists and never runs, and nothing throws.
  Covers `args.x`, `args['x']` and `const { x } = args`.

## 0.5.0

- New layer: traceability. `git-uncommitted` (files that ship in the tarball are
  not committed), `git-tag-missing` (no `v<version>` tag on HEAD),
  `git-tag-elsewhere` (the tag exists but points at another commit).
- The incident behind it: a 1.2.7 went to npm while the GitHub release still
  said 1.2.6 and the market entry still pointed at the old tarball.

## 0.4.0

- New layer: dependency truth. `undeclared-import` (lib/ imports a package
  package.json never declares), `dep-in-dev-only` (only devDependencies satisfy
  it — npm never installs those for the consumer), `unused-dependency` (info).
- New rule `version-behind-latest`: publishing under the live `latest` is
  accepted by npm and reaches nobody.

## 0.3.4

- `tool-call-slow` split from `tool-call-throws`: a timeout is not a defect.

## 0.3.3

- `publish_gate_tools` accepts `call: ["name"]` to really invoke a tool, opt-in
  because some tools open applications or write files.

## 0.3.2

- New rule `node-too-old`: `engines.node` says one thing, `lib/` uses an API from
  a newer Node. npm only warns on `engines`, so the plugin installs and then
  throws at import.

## 0.3.1

- `publish_gate_commands` emits commands that actually run on this machine
  (`cmd /c "npm publish --access public"` on Windows) and pairs the publish step
  with a `publish_gate_verify` shasum check.

## 0.3.0

- New layer: the browser half. `checkClientHalf` / `checkClientRuntime` load the
  bundle against a fake `window.__ModuleLoader__` and report a bundle that never
  loads, never returns `apply`, throws, registers nothing, or uses a service its
  `inject` array does not declare.
- New layer: market readiness — the repo is already listed, another entry
  publishes the same npm name, or the repo is under 24 hours old (the gate fails
  and reruns itself).
- New rules: `client-without-platform`, `pack-omits-client`, `pack-ships-secret`,
  `private-field-set`, `publish-config-registry`, `tool-bad-parameter-type`,
  `entry-path-missing`, `bundle-patch-not-declared`, `inject-unused-service`.
- New tool `publish_gate_client` (9 tools).

## 0.2.0

- New layers: artifact (`npm pack --dry-run` — what npm will really ship) and
  runtime (import the entry in an isolated child process, call `apply`, report a
  throwing import, a throwing apply, missing execute, duplicate tool names, a
  throwing `presentCall`, and card kinds the host does not render).
- New tools `publish_gate_tools` and `publish_gate_verify`.
- Fixed: `bad-repo-url` never fired for the object form of `repository`.

## 0.1.0

- First release: manifest rules, `cordis.patch.yml` insert checks, README and
  test presence, npm name and registry state.
