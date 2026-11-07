# Changelog

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
