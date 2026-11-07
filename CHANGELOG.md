# Changelog

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
