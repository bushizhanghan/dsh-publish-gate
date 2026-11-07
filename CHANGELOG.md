# Changelog

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
