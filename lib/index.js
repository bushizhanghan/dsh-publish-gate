// dsh-publish-gate: agent tools that run the publish preflight.
//
// One entry point runs every static check, so an agent asked "can I ship
// this?" gets the same answer a human gets from the gate — a second
// implementation would drift and the two answers would disagree.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  bumpPatch,
  checkCandidate,
  checkDocs,
  checkEntrySource,
  checkGitState,
  checkLocalLink,
  checkMarketEntry,
  checkMarketReadiness,
  checkMountEntry,
  checkNpmState,
  checkPackageJson,
  entryFile,
  checkPack,
  diffPack,
  publishedFiles,
  checkPatchYml,
  checkPublishedMatches,
  checkStoreConflict,
  checkTests,
  checkToolRegistrations,
  checkUpdate,
  applyFixes,
  planFixes,
  checkClientRuntime,
  checkPublishIdentity,
  checkVersionTaken,
  waitForPublished,
  compareVersions,
  latestPublished,
  renderReport,
  renderMarkdown,
  buildGateWorkflow,
  runArtifactChecks,
  checkTestRun,
  straySeverities,
  runStaticChecks,
} from './engine.js'

const run = promisify(exec)

export const name = 'publish-gate'
export const inject = ['tools']

const Config = {
  registry: 'https://registry.npmjs.org',
  // Network checks (npm version collision, GitHub repo) are best-effort: a
  // blocked network downgrades them to unknown rather than failing the gate.
  networkTimeoutMs: 10_000,
  // The host kills a tool call at 120 s, so a suite slower than this has to be
  // run outside the gate (skipTests) instead of hanging the call.
  testTimeoutMs: 90_000,
}

const OUTPUT_SCHEMA = { type: 'json' }
const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  /** Add the network-dependent checks, each failing soft. */
  async function networkGate(dir) {
    const findings = []
    const pkgJson = readJson(join(dir, 'package.json'))
    if (pkgJson?.name && pkgJson?.version) {
      findings.push(...(await checkVersionTaken(pkgJson.name, pkgJson.version, { registry: cfg.registry })))
    }
    findings.push(...(await checkPublishIdentity(dir, { timeoutMs: cfg.networkTimeoutMs })))
    // is the GitHub repo there?
    if (pkgJson?.repository) {
      const url = repoUrl(pkgJson.repository)
      if (url) {
        try {
          const res = await fetch(`https://api.github.com/repos/${url}`, { signal: AbortSignal.timeout(cfg.networkTimeoutMs) })
          if (res.status === 404) {
            findings.push({
              rule: 'repo-missing',
              severity: 'warn',
              title: `GitHub repo ${url} does not exist`,
              detail: 'The market submission links to it, and npm shows it as the homepage. Create it before publishing, or fix the URL.',
              fix: `Create https://github.com/${url}`,
            })
          }
        } catch {
          // offline: unknown, not an error
        }
      }
    }
    return findings
  }

  const tools = [
    {
      name: 'publish_gate',
      description:
        'Run the full pre-publish gate over a DSH plugin directory. Five layers. (1) Manifest: missing exports["."], files omitting lib/, no "type": "module", UTF-8 BOM, JSON/YAML parse errors, cordis.patch.yml insert rows at the wrong indent (the bug that makes a plugin install and never mount), insert name mismatches, missing entry exports, an entry path that points at no file, a cordis.patch.yml the manifest never declares (inert), missing LICENSE or README install line, missing tests, unscoped npm names (the 403 you cannot diagnose). (2) Dependencies: every bare import in lib/ resolved against package.json — an import nothing declares, an import only devDependencies satisfy (npm never installs those for whoever installs you), an unused dependency. (3) Artifact: runs `npm pack --dry-run` and reads what npm will actually ship — lib/ missing from the tarball, a dsh.bundle.patch that never gets packed, oversize tarballs (test fixtures are the usual cause), dev directories shipping, and a prepack hook that means the dry run did not build. (4) Tests: runs `node --test` in the plugin directory and reports a suite that fails, hangs, or exits 0 without running anything — the only layer that reads the code instead of the paperwork. (5) Runtime: imports the entry in an isolated child process, calls apply(ctx) with a fake ctx, and reports a throwing import, a throwing apply, tools with no execute, duplicate tool names, a presentCall that throws, and card kinds the host does not render; then, if the package declares exports["./client"], loads the browser bundle against a fake window.__ModuleLoader__ and reports a bundle that never loads, never returns apply, throws, or registers nothing. Deterministic: every rule is a file, subprocess or API check, no LLM. Returns {ok, report, findings:[{rule,severity,title,detail,fix}], counts}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory to gate. Defaults to the current working directory.' },
          skipNetwork: { type: 'boolean', description: 'Skip the npm registry and GitHub checks (default false).' },
          skipPack: { type: 'boolean', description: 'Skip `npm pack --dry-run` (default false). Faster, but says nothing about the real tarball.' },
          skipTools: { type: 'boolean', description: 'Skip the isolated import of the plugin entry (default false).' },
          skipClient: { type: 'boolean', description: 'Skip the isolated load of the browser bundle (default false).' },
          skipTests: { type: 'boolean', description: 'Skip running the test suite (default false). The suite is the only check that reads the code rather than the paperwork.' },
          format: { type: 'string', enum: ['text', 'markdown'], description: 'Report format: plain text (default) or markdown you can paste into an issue.' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path) and cwd has no package.json' }
        const findings = runStaticChecks(dir)
        // `== true` on purpose: skipPack: "false" is truthy, and a silently
        // skipped pack layer reported safeToPublish: true on an unread tarball.
        const artifact = await runArtifactChecks(dir, {
          skipPack: args.skipPack === true,
          skipTools: args.skipTools === true,
          skipClient: args.skipClient === true,
        })
        findings.push(...artifact.findings)
        const tests = args.skipTests === true ? null : await checkTestRun(dir, { timeoutMs: cfg.testTimeoutMs })
        if (tests) findings.push(...tests)
        if (args.skipNetwork !== true) findings.push(...(await networkGate(dir)))
        // A finding with an unexpected severity is invisible to the counters
        // below, so the rule silently never reports. Make that loud instead.
        const stray = straySeverities(findings)
        if (stray.length > 0) {
          findings.push({
            rule: 'internal-bad-severity',
            severity: 'error',
            title: `these rules built a finding with an unknown severity: ${stray.join(", ")}`,
            detail: 'The gate counted them as nothing, so they never appeared in a report. This is a bug in publish-gate, not in the plugin being gated.',
            fix: 'Report it: the severity slot of F(...) took something other than error/warn/info.',
          })
        }
        const counts = {
          error: findings.filter((f) => f.severity === 'error').length,
          warn: findings.filter((f) => f.severity === 'warn').length,
          info: findings.filter((f) => f.severity === 'info').length,
        }
        return {
          ok: true,
          blockers: counts.error,
          counts,
          findings,
          tools: artifact.tools,
          client: artifact.client,
          tests: args.skipTests === true ? null : findings.filter((f) => f.rule.startsWith("tests-")),
          unpackedSize: artifact.pack?.unpackedSize ?? null,
          report: args.format === 'markdown' ? renderMarkdown(findings, { title: `publish gate · ${dir}` }) : renderReport(findings, { title: `publish gate · ${dir}` }),
          safeToPublish: counts.error === 0,
        }
      },
    },
    {
      name: 'publish_gate_tools',
      description:
        'Import a plugin entry in an isolated child process, call apply(ctx) with a no-op context, and report what it actually registered. Catches the failures the manifest cannot show: the entry throws when imported, apply throws, a tool has no execute function, two tools share a name, presentCall throws, and a card kind the host does not render (the host only knows other/execute/search/read/edit/delete/fetch — anything else registers fine and renders a broken card). Optional deeper modes: `call` runs named tools with {} and validates each result against its own output schema; `fuzz` drives every declared parameter with a wrong-typed value and reports the tools that throw a raw TypeError instead of answering — the host never validates a call against parameters, so those values really arrive. 20 s timeout, plugin code never runs in the host process. Returns {ok, tools:[{name,hasExecute,hasOutputSchema,cardKind}], findings, report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          timeoutMs: { type: 'number', description: 'Kill the child after this long (default 20000).' },
          call: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tool names to actually call with empty arguments, e.g. ["page_watch_list"]. Off by default: some tools open applications or write files, so you name the ones you consider safe. A tool that throws on {} is a bug no other check can see, because registration never runs execute.',
          },
          fuzz: {
            type: 'boolean',
            description:
              'Drive every declared parameter with wrong-typed values (a number where a string is declared, and so on) and report the tools that throw instead of answering. The host never validates a call against parameters, so these values really reach your code. Off by default because it calls every tool — pass skip for the ones that launch applications or write files.',
          },
          skip: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names the fuzz must not call, e.g. ["weapp_open","of_run","page_watch_add"].',
          },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        // A skip list that silently degrades to [] makes fuzz call every tool,
        // including the ones that launch applications. Refuse instead.
        if (args.skip != null && !Array.isArray(args.skip)) {
          return { ok: false, error: 'skip must be an array of tool names' }
        }
        if (args.call != null && !Array.isArray(args.call)) {
          return { ok: false, error: 'call must be an array of tool names' }
        }
        const calls = (args.call || []).filter((n) => typeof n === 'string' && n.length > 0)
        const fuzzSkip = (args.skip || []).filter((n) => typeof n === 'string' && n.length > 0)
        const { findings, tools } = await checkToolRegistrations(dir, {
          timeoutMs: Number(args.timeoutMs) || undefined,
          calls: calls.length > 0 ? calls : undefined,
          fuzz: args.fuzz === true,
          fuzzSkip: fuzzSkip.length > 0 ? fuzzSkip : undefined,
        })
        return { ok: true, tools, findings, report: renderReport(findings, { title: `runtime gate · ${dir}` }) }
      },
    },
    {
      name: 'publish_gate_client',
      description:
        'Load a plugin\'s browser bundle in an isolated child process and report whether it would actually appear in the UI. A client half fails silently: the host half keeps working, so a panel that never registers looks like a UI bug rather than a packaging one. Reproduces the host contract — a fake window.__ModuleLoader__.load({id, factory}), a fake require("react"), a ctx whose effect/inject run the callback and whose services record every call — then reports: the file declared in exports["./client"] is missing, the bundle never calls load, the factory throws, it returns no apply, apply throws, apply registers nothing, the bundle uses a service its own inject array omits (cordis never hands it over, so the panel is blank), and a SyntaxError anywhere in the file. 20 s timeout, plugin code never runs in the host process. Returns {ok, client:{loaded,id,hasApply,inject,registrations,services,parseError,evalError,factoryError,applyError}, findings, report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          timeoutMs: { type: 'number', description: 'Kill the child after this long (default 20000).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        const { findings, client } = await checkClientRuntime(dir, { timeoutMs: Number(args.timeoutMs) || undefined })
        return { ok: true, client, findings, report: renderReport(findings, { title: `client gate · ${dir}` }) }
      },
    },
    {
      name: 'publish_gate_verify',
      description:
        'Check that the tarball on the npm registry is the one in this directory. Runs `npm pack --dry-run` and compares its shasum with the registry dist.shasum — an exact comparison, not a version-number guess, so it catches "I bumped and forgot to publish" and "I published, then edited lib/". Reports publish-served (match), publish-served-mismatch (the version is spent and the registry holds different bytes), or publish-not-served (not published, or still inside the registry\'s 202-then-404 window — pass waitMs to poll through that window instead of concluding too early). Run it right after `npm publish`. Returns {ok, name, version, published, shasumMatch, localShasum, unpackedSize, files, waitedMs, findings, report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          version: { type: 'string', description: 'Version to verify (defaults to package.json version).' },
          waitMs: {
            type: 'number',
            description:
              'Poll until the registry serves the bytes, up to this many milliseconds (capped at 90000 — the host kills a tool call at 120000). npm answers 202 and keeps the version invisible for 60-180 s after a publish, measured up to 4 minutes, so a single shot reports "not published" on a release that already succeeded. When the wait runs out with `pending: true`, run it again; that is not a failure.',
          },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        const { json, error: parseError } = readJsonStrict(join(dir, 'package.json'))
        if (parseError) return { ok: false, error: parseError }
        if (!json?.name) return { ok: false, error: 'no package.json' }
        if (args.version != null && typeof args.version !== 'string') return { ok: false, error: 'version must be a string' }
        const version = args.version || json.version
        const { pack, findings: packFindings } = await checkPack(dir)
        if (!pack) return { ok: false, error: `npm pack --dry-run did not run, so there is nothing to compare: ${packFindings.map((f) => f.title).join('; ')}` }
        const waitMs = Math.min(Math.max(0, Number(args.waitMs) || 0), 90_000)
        const { findings, waitedMs, pending } = await waitForPublished(json.name, version, pack, {
          registry: cfg.registry,
          timeoutMs: cfg.networkTimeoutMs,
          waitMs,
        })
        const served = findings.some((f) => f.rule === 'publish-served')
        return {
          ok: true,
          name: json.name,
          version,
          published: served || findings.some((f) => f.rule === 'publish-served-mismatch'),
          shasumMatch: served,
          pending,
          localShasum: pack.shasum,
          unpackedSize: pack.unpackedSize,
          files: (pack.files || []).length,
          waitedMs,
          findings,
          report: renderReport(findings, { title: `publish verify · ${json.name}@${version}` }),
        }
      },
    },
    {
      name: 'publish_gate_patch',
      description:
        'Check only the cordis.patch.yml of a plugin directory: is there an insert row, is every insert row actually inside an "- insert:" sequence (a top-level "- id:" row is a patch on an existing entry, not a mount — the plugin installs and silently never loads), does each insert row carry a name, does that name match package.json, and does it resolve in node_modules. Use this first when a plugin "installed but the tools never appeared". Returns {ok, findings, report}.',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Plugin directory.' } },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        const findings = checkPatchYml(dir)
        return { ok: true, findings, report: renderReport(findings, { title: `patch gate · ${dir}` }) }
      },
    },
    {
      name: 'publish_gate_market',
      description:
        'Validate a market submission entry (the YAML you put in data/plugins/<owner>__<repo>.yml): url is a GitHub URL, name is owner/repo, category is one the market knows, and description carries both en: and zh:. Catches the shape errors the submission gate rejects. Pass dir instead to run the pre-submission checks that only the live catalogue can answer: this repo is already listed (a duplicate PR), another entry publishes the same npm package, and the repo is younger than the 24 h the submission gate requires — that last one fails with "0.0 days old" and only reruns on its own, so it is worth knowing before you open the PR. Returns {ok, findings, report, entry}.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The entry YAML text.' },
          file: { type: 'string', description: 'Or a path to the entry file.' },
          dir: { type: 'string', description: 'Or a plugin directory: reads the live catalogue and GitHub metadata instead of validating YAML.' },
        },
      },
      async execute(args) {
        if (!args.text && !args.file && args.dir) {
          const dir = resolveDir(args.dir)
          if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
          const findings = await checkMarketReadiness(dir, { timeoutMs: cfg.networkTimeoutMs })
          return { ok: true, findings, report: renderReport(findings, { title: `market readiness · ${dir}` }) }
        }
        let text = typeof args.text === 'string' ? args.text : null
        if (text === null && args.file) {
          try {
            const { readFileSync } = await import('node:fs')
            text = readFileSync(args.file, 'utf8')
          } catch {
            return { ok: false, error: `cannot read ${args.file}` }
          }
        }
        if (text === null) return { ok: false, error: 'give text, file, or dir' }
        const findings = checkMarketEntry(text)
        return { ok: true, findings, report: renderReport(findings, { title: 'market entry' }), entry: text }
      },
    },
    {
      name: 'publish_gate_next_version',
      description:
        'Report the next version to publish: the version in package.json, whether it is already taken on the registry, and the bump to use (patch by default, minor when you changed behaviour). Use this when a publish failed with a 403 you did not understand. Returns {ok, current, taken, suggested}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          bump: { type: 'string', enum: ['patch', 'minor', 'major'], description: 'Which bump to suggest (default patch).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        const { json, error: parseError } = readJsonStrict(join(dir, 'package.json'))
        if (parseError) return { ok: false, error: parseError }
        if (!json?.version) return { ok: false, error: 'no version in package.json' }
        const taken = (await checkVersionTaken(json.name, json.version, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })).map((f) => f.title)
        const latest = await latestPublished(json.name, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })
        // A checkout that is behind npm must bump from npm's latest, or the
        // "suggested" version is one that is already published.
        const behind = latest && compareVersions(latest, json.version) > 0 ? latest : null
        const base = behind ?? json.version
        const [a, b, c] = /^(\d+)\.(\d+)\.(\d+)/.exec(base)?.slice(1).map(Number) ?? [0, 0, 0]
        const bump = ['patch', 'minor', 'major'].includes(args.bump) ? args.bump : 'patch'
        const suggested =
          bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
        return {
          ok: true,
          current: json.version,
          latest,
          behind,
          taken,
          suggested,
          suggestedFor: bump,
          note: behind ? `package.json is behind the registry (${behind} is live); the suggestion bumps from there.` : undefined,
        }
      },
    },
    {
      name: 'publish_gate_doctor',
      description:
        'Run the gate over every plugin in a directory tree or a pnpm/npm workspace (package.json workspaces, pnpm-workspace.yaml): direct children plus the workspace globs and rank them by blocker count, so you can see which one is not ready to ship before you start a publish session. No registry or GitHub calls, so it is fast and works offline; each row also carries the real tarball size from `npm pack --dry-run` (pass skipPack to skip that and stay purely static). Returns {ok, plugins:[{dir,name,version,blockers,warns,notes,unpackedSize,files,top}], totals}.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Directory containing plugin checkouts.' },
          skipPack: { type: 'boolean', description: 'Skip `npm pack --dry-run` per plugin (default false).' },
          format: { type: 'string', enum: ['text', 'markdown'], description: 'Add a markdown table of the sweep to the result (default text).' },
        },
      },
      async execute(args) {
        const root = args.root || process.cwd()
        let dirs = []
        try {
          dirs = pluginDirs(root)
        } catch {
          return { ok: false, error: `cannot read ${root}` }
        }
        if (dirs.length === 0) return { ok: false, error: `no plugin checkout found under ${root}` }
        const plugins = []
        for (const dir of dirs) {
          const json = readJson(join(dir, 'package.json'))
          if (!json?.name || !entryFile(dir)) continue
          const findings = runStaticChecks(dir)
          const top = findings.find((f) => f.severity === 'error')
          const pack = args.skipPack ? null : (await checkPack(dir)).pack
          plugins.push({
            dir,
            name: json.name,
            version: json.version,
            blockers: findings.filter((f) => f.severity === 'error').length,
            warns: findings.filter((f) => f.severity === 'warn').length,
            notes: findings.filter((f) => f.severity === 'info').length,
            unpackedSize: pack?.unpackedSize ?? null,
            files: pack?.files?.length ?? null,
            top: top ? `${top.rule}: ${top.title}` : null,
          })
        }
        plugins.sort((a, b) => b.blockers - a.blockers || b.warns - a.warns)
        const totals = plugins.reduce(
          (acc, p) => ({
            blockers: acc.blockers + p.blockers,
            warns: acc.warns + p.warns,
            notes: acc.notes + p.notes,
            unpackedBytes: acc.unpackedBytes + (p.unpackedSize || 0),
          }),
          { blockers: 0, warns: 0, notes: 0, unpackedBytes: 0 },
        )
        const report =
          args.format === 'markdown'
            ? [
                '| plugin | version | errors | warns | notes | unpacked | top blocker |',
                '|---|---|---|---|---|---|---|',
                ...plugins.map(
                  (p) =>
                    `| \`${p.name}\` | ${p.version || '-'} | ${p.blockers} | ${p.warns} | ${p.notes} | ${p.unpackedSize == null ? '-' : Math.round(p.unpackedSize / 1024) + ' kB'} | ${p.top ? p.top.replace(/\|/g, '\\|') : '-'} |`,
                ),
              ].join('\n')
            : null
        return { ok: true, plugins, totals, report }
      },
    },
    {
      name: 'publish_gate_commands',
      description:
        'Report the exact publish commands for a plugin, in order, with the ones this machine has already completed marked: git init/commit, GitHub repo create, git push, npm publish, market entry, market PR. Use it to know where you are in the pipeline instead of re-deriving it. Returns {ok, steps:[{name,command,done,note}], manifestFix} — manifestFix is the exact JSON to merge into package.json when a scoped package lacks publishConfig.access, instead of a sentence telling you to write it.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          owner: { type: 'string', description: 'GitHub owner (default: from git config user.name).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
        const { json, error: parseError } = readJsonStrict(join(dir, 'package.json'))
        if (parseError) return { ok: false, error: parseError }
        if (!json?.name) return { ok: false, error: 'no package.json' }
        const owner = args.owner || (await gitConfig('user.name')) || '<owner>'
        const repo = json.repository?.url?.match(/github\.com[:/]([^/]+)\/([^/.]+)/)?.[2] || json.name.replace(/^@[^/]+\//, '')
        const { existsSync } = await import('node:fs')
        const hasGit = existsSync(join(dir, '.git'))
        // npm publishes to `latest` whatever the version suffix says, so a
        // prerelease needs an explicit tag or it goes out to everyone.
        const preTag = /^\d+\.\d+\.\d+-/.test(json.version || '')
        const tag = preTag ? (json.publishConfig?.tag && json.publishConfig.tag !== 'latest' ? json.publishConfig.tag : 'next') : null
        const publishCmd = `npm publish --access public${tag ? ` --tag ${tag}` : ''}`
        const steps = [
          {
            name: 'git init and commit',
            command: `git init && git add -A && git -c user.name="${owner}" commit -m "<message>"`,
            done: hasGit,
            note: hasGit ? 'repository exists' : 'no .git yet',
          },
          {
            name: 'create the GitHub repo',
            command: `POST https://api.github.com/user/repos  { name: "${repo}", private: false }`,
            done: false,
            note: 'check with: gh repo view (or the API)',
          },
          {
            name: 'push',
            command: `git remote add origin https://github.com/${owner}/${repo}.git && git push -u origin main`,
            done: false,
            note: 'if git push cannot reach github.com, push the files through the contents API instead',
          },
          {
            name: 'npm publish',
            command: process.platform === 'win32' ? `cmd /c "${publishCmd}"` : publishCmd,
            done: false,
            note:
              `a bare (unscoped) name can return 403 with a granular token — "${json.name}" is ${json.name.startsWith('@') ? 'scoped, fine' : 'UNSCOPED, rename it'}` +
              (process.platform === 'win32'
                ? '. On Windows the bare form fails under PowerShell when npm.ps1 is blocked by execution policy, so it is wrapped in cmd /c'
                : '') +
              '. Run `npm publish --dry-run` first if you want to see the file list without spending the version.',
          },
          {
            name: 'verify the published bytes',
            command: `publish_gate_verify({ dir: "${dir.replace(/\\/g, '\\\\')}" })`,
            done: false,
            note: 'the registry answers 202 and then 404s for about a minute, so a mismatch right after publish is normal; the shasum comparison is exact once it settles',
          },
          {
            name: 'tag the shipped commit',
            command: `git tag v${json.version} && git push origin v${json.version}`,
            done: false,
            note: 'a GitHub release, a changelog entry and the market listing all point at a commit — none of them can point at one that was never tagged',
          },
          {
            name: 'market entry',
            command: `write data/plugins/${owner}__${repo}.yml with url / name / category / description{en,zh}`,
            done: false,
            note: 'fork first, then commit on the fork branch',
          },
          {
            name: 'market PR',
            command: `POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls`,
            done: false,
            note: 'the submission gate needs repo age >= 1 day; it auto-reruns, so open the PR and come back tomorrow',
          },
        ]
        const manifestFix =
          json.name.startsWith('@') && json.publishConfig?.access !== 'public'
            ? {
                path: 'package.json',
                json: { publishConfig: { ...(json.publishConfig || {}), access: 'public' } },
                note: 'without this a scoped package publishes as restricted: it installs for you and 404s for everyone else',
              }
            : null
        return { ok: true, owner, repo, package: json.name, steps, manifestFix }
      },
    },
  ]

  tools.push({
    name: 'publish_gate_ci',
    description:
      'Emit a GitHub Actions workflow that keeps the two checks a CI runner can actually do: the test suite, and the one tarball fact a manifest cannot show — is the resolved entry file (and the declared cordis.patch.yml) inside the tarball npm would publish. It does not re-run the whole gate: a runner has no DSH profile, no host to import the entry into, and no access to your npm scope. Use publish_gate locally for the rest. Returns {ok, path, yaml, report}.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node version for setup-node (default "22").' },
        branch: { type: 'string', description: 'Branch to run on (default "main").' },
      },
    },
    execute(args) {
      const nodeVersion = typeof args.node === 'string' && /^\d+(?:\.\d+)?$/.test(args.node) ? args.node : '22'
      const branch = typeof args.branch === 'string' && /^[\w./-]+$/.test(args.branch) ? args.branch : 'main'
      const yaml = buildGateWorkflow({ nodeVersion, branches: [branch] })
      return {
        ok: true,
        path: '.github/workflows/publish-gate.yml',
        yaml,
        report: 'Write it to .github/workflows/publish-gate.yml, commit, push. Run publish_gate locally before tagging.',
      }
    },
  })

  tools.push({
    name: 'publish_gate_smoke',
    description:
      'The strongest pre-install check short of installing: download the exact tarball the registry would hand an installer, unpack it inside the profile\'s own node_modules so its bare imports resolve against what is really installed there, import the entry, call apply(ctx) and report what registered. publish_gate_update does the same work in a system temp directory, where a plugin that imports a real dependency fails with ERR_MODULE_NOT_FOUND and looks broken. Cleans up after itself. Returns {ok, name, version, resolved, tools, findings, report}.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Package name, e.g. @scope/plugin.' },
        version: { type: 'string', description: 'Exact version to smoke (default: dist-tags.latest).' },
        profile: { type: 'string', description: 'Profile name under ~/.dsh/profiles (default "desktop").' },
        fuzz: { type: 'boolean', description: 'Also drive every declared parameter with a wrong-typed value.' },
      },
      required: ['name'],
    },
    async execute(args) {
      if (typeof args.name !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(args.name)) {
        return { ok: false, error: 'name must be a package name like @scope/plugin' }
      }
      const profile = typeof args.profile === 'string' && /^[\w.-]+$/.test(args.profile) ? args.profile : 'desktop'
      const profileDir = join(process.env.USERPROFILE || homedir(), '.dsh', 'profiles', profile)
      if (!existsSync(profileDir)) return { ok: false, error: `no profile at ${profileDir}` }
      const version = typeof args.version === 'string' && args.version ? args.version : await latestPublished(args.name)
      if (!version) return { ok: false, error: `no published version for ${args.name}` }

      const { rmSync } = await import('node:fs')
      const root = join(profileDir, 'node_modules')
      if (!existsSync(root)) return { ok: false, error: `no node_modules at ${root}` }
      const res = await checkCandidate(args.name, version, { root, fuzz: args.fuzz === true, skipPack: true })
      try {
        const errors = res.findings.filter((f) => f.severity === 'error')
        return {
          // Nothing downloaded means nothing was verified. A warn-only result
          // (registry 404, tar missing, unsafe tarball) is not a pass.
          ok: errors.length === 0 && Boolean(res.dir),
          name: args.name,
          version,
          verified: Boolean(res.dir),
          resolved: Boolean(res.dir),
          tools: res.tools ?? null,
          client: res.client ?? null,
          findings: res.findings,
          report: renderReport(res.findings, { title: `smoke · ${args.name}@${version}` }),
        }
      } finally {
        // checkCandidate owns the temp directory and already removed it; this is
        // only a retry for the case where its own cleanup hit a file lock.
        if (res.dir) {
          try {
            rmSync(join(res.dir, '..'), { recursive: true, force: true })
          } catch {
            /* a leftover temp directory is not a reason to fail the tool call */
          }
        }
      }
    },
  })
  tools.push({
    name: 'publish_gate_update',
    description:
      'Answer "should I take this update?" BEFORE installing it — the question every updater in the market answers too late, by rolling back after the new build fails to boot. Reads the installed version, asks the registry for dist-tags.latest, then downloads that exact tarball, unpacks it into a temp directory and runs the same artifact and runtime layers the gate runs on a checkout: does the entry import, does apply() register tools, does the tarball carry lib/ and its patch, does a tool throw on a wrong-typed argument. Checkout-only rules (git, market, tests, links) are filtered out so the verdict is about the code, not the repo. Reports candidate-same-version (info), candidate-older (warn: dist-tags can move backwards after an unpublish), plus every artifact/runtime rule against the downloaded build, and candidate-unavailable when nothing could be downloaded — that is not a clean verdict. Returns {ok, name, current, latest, upToDate, tarball, findings, report}.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin checkout whose package.json names the package (installed version).' },
        name: { type: 'string', description: 'Package name, when the directory has no package.json.' },
        version: { type: 'string', description: 'Current/installed version to compare against (defaults to package.json version).' },
        latest: { type: 'string', description: 'Candidate version to test (defaults to the registry dist-tags.latest).' },
        fuzz: { type: 'boolean', description: 'Drive every declared parameter of the candidate with a wrong-typed value. Slower, and it executes the plugin code.' },
        skipTools: { type: 'boolean', description: 'Skip the isolated import and registration check.' },
      },
    },
    async execute(args) {
      const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : null
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
      if (!dir && !name) return { ok: false, error: 'pass dir (a plugin checkout) or name (a package name) so the gate knows what to compare' }
      const current = typeof args.version === 'string' && args.version.trim() ? args.version.trim() : undefined
      const latest = typeof args.latest === 'string' && args.latest.trim() ? args.latest.trim() : undefined
      // A named package with no checkout still has an installed copy to read a
      // version from; without one nothing compares, and "no version" is not a
      // pass.
      const probeDir = dir || join(process.env.USERPROFILE || homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', ...String(name).split('/'))
      const result = await checkUpdate(probeDir, {
        name,
        current,
        latest,
        registry: cfg.registry,
        timeoutMs: cfg.networkTimeoutMs,
        fuzz: args.fuzz === true,
        skipTools: args.skipTools === true,
      })
      // upToDate is a real answer; a candidate that never downloaded is not.
      const verified = Boolean(result.upToDate) || Boolean(result.candidate?.dir)
      return {
        ok: verified && result.findings.every((f) => f.severity !== 'error'),
        verified,
        name: name || readJson(join(probeDir, 'package.json'))?.name || null,
        current: result.current,
        latest: result.latest,
        upToDate: result.upToDate,
        tarball: result.candidate?.tarball || null,
        findings: result.findings,
        report: renderReport(result.findings, { title: `update preview · ${name || probeDir}` }),
      }
    },
  })

  tools.push({
    name: 'publish_gate_fix',
    description:
      'Apply only the mechanical half of the gate: the fixes where a fired rule has exactly one correct answer — publishConfig.access for a scoped name (npm publishes it as restricted otherwise, and the error names neither the setting nor the scope), and the missing "files" entries that make the tarball ship without its entry file or its mount patch. Dry run by default; nothing is written unless apply is true. It never touches code, versions, dependencies or anything a human has to decide, because a tool that rewrote your plugin would have to be trusted exactly as much as the checks it edits around. Returns {ok, applied, dryRun, changes:[{kind, add?, from?, to?, why}], report}.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin checkout directory.' },
        apply: { type: 'boolean', description: 'Write the changes (default false: return the plan only).' },
      },
      required: ['dir'],
    },
    async execute(args) {
      const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : null
      if (!dir) return { ok: false, error: 'dir must be a plugin directory path' }
      if (!existsSync(dir)) return { ok: false, error: `no such directory: ${dir}` }
      const result = applyFixes(dir, { dryRun: args.apply !== true })
      const lines = result.changes.map((change, i) =>
        change.kind === 'files'
          ? `${i + 1}. add "${change.add}" to files — ${change.why}`
          : `${i + 1}. set publishConfig.access = "public" — ${change.why}`,
      )
      return {
        ok: true,
        applied: result.applied,
        dryRun: result.dryRun !== false,
        changes: result.changes,
        reason: result.reason || null,
        report: lines.length ? lines.join('\n') : 'nothing to fix mechanically',
      }
    },
  })

  tools.push({
    name: 'publish_gate_drift',
    description:
      'Answer "what would this publish actually change" by diffing the tarball you have now against the tarball that is live on the registry: added files, removed files, and files whose size changed (which is how a rebuild shows up). Pass against to pick the version, otherwise the latest published one is used. Unreadable registry is reported as drift-unavailable, never as "no change". Returns {ok, compared, name, current, against, same, added, removed, changed, findings, report}.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin directory.' },
        against: { type: 'string', description: 'Published version to compare with (default: the latest published one).' },
        format: { type: 'string', enum: ['text', 'markdown'], description: 'Report format (default text).' },
      },
    },
    async execute(args) {
      const dir = resolveDir(args.dir)
      if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
      const { json, error: parseError } = readJsonStrict(join(dir, 'package.json'))
      if (parseError) return { ok: false, error: parseError }
      if (!json?.name) return { ok: false, error: 'no package.json' }
      const against =
        typeof args.against === 'string' && args.against.trim()
          ? args.against.trim()
          : await latestPublished(json.name, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })
      if (!against) return { ok: false, error: `could not tell which published version of ${json.name} to compare against` }
      const local = await checkPack(dir)
      if (!local.pack) return { ok: false, error: 'npm pack produced no file list, so there is nothing to compare' }
      let live = null
      try {
        live = await publishedFiles(json.name, against, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })
      } catch (e) {
        const findings = [
          {
            rule: 'drift-unavailable',
            severity: 'warn',
            title: `${json.name}@${against} could not be downloaded, so nothing is compared`,
            detail: `${String(e?.message || e)} - this is NOT the same as "no changes"`,
          },
        ]
        return { ok: true, compared: false, name: json.name, current: json.version, against, same: null, findings, report: renderReport(findings) }
      }
      const diff = diffPack(local.pack.files, live)
      const findings = []
      if (!diff.same) {
        const parts = []
        if (diff.added.length) parts.push(`+${diff.added.length} added`)
        if (diff.removed.length) parts.push(`-${diff.removed.length} removed`)
        if (diff.changed.length) parts.push(`~${diff.changed.length} changed`)
        findings.push({
          rule: 'published-drift',
          severity: 'info',
          title: `publishing now would change ${parts.join(', ')} against ${json.name}@${against}`,
          detail: [
            diff.added.length ? `added: ${diff.added.slice(0, 6).join(', ')}` : '',
            diff.removed.length ? `removed: ${diff.removed.slice(0, 6).join(', ')}` : '',
            diff.changed.length ? `changed: ${diff.changed.slice(0, 6).join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        })
      }
      return {
        ok: true,
        compared: true,
        name: json.name,
        current: json.version,
        against,
        same: diff.same,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        findings,
        report: args.format === 'markdown' ? renderMarkdown(findings, { title: json.name }) : renderReport(findings),
      }
    },
  })

  tools.push({
    name: 'publish_gate_link',
    description:
      'Answer "why is my local plugin not running?" from the profile\'s own files, with no network and no package manager. An unpublished plugin reaches the host only through a link in <profile>/node_modules plus a mount row in the profile\'s cordis.patch.yml, and every failure looks identical from the outside. Reports: link-not-installed (info) when the profile has no entry for this package; the link kind and its target — Node reports a junction and a directory symlink the same way, while a plain directory is a copy; link-target-missing (error) when the link points at a path with no parseable package.json, because a dead junction resolves the package to nothing and the plugin silently disappears; link-stale-copy (warn) when the profile holds a copy whose version differs from this checkout, so edits to lib/ never reach it; pnpm-store-conflict (warn) when the profile\'s pnpm store major differs from the bundled pnpm (v11) — that is the ERR_PNPM_UNEXPECTED_STORE that makes `dsh plugin add link:` fail before it installs; patch-entry-top-level (error) when this package\'s row in the profile patch sits outside an "- insert:" block, which installs and never mounts. Pass profile to inspect a temp profile; the default is ~/.dsh/profiles/desktop. Returns {ok, link:{kind,target,resolves}, store:{profileMajor,bundledMajor,conflict}, mount:{entryFound,shape}, findings, report}.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Plugin checkout directory.' },
        profile: { type: 'string', description: 'Profile directory to inspect (default ~/.dsh/profiles/desktop). Tests pass a temp profile instead of the real one.' },
      },
    },
    async execute(args) {
      const dir = resolveDir(args.dir)
      if (!dir) return { ok: false, error: 'no plugin directory given (dir must be a string path)' }
      const profileDir = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined
      const link = checkLocalLink(dir, { profileDir })
      const store = checkStoreConflict(dir, { profileDir })
      const mount = checkMountEntry(dir, { profileDir })
      const findings = [...link.findings, ...store.findings, ...mount.findings]
      return {
        ok: true,
        link: { kind: link.kind, target: link.target, resolves: link.resolves },
        store: { profileMajor: store.profileMajor, bundledMajor: store.bundledMajor, conflict: store.conflict },
        mount: { entryFound: mount.entryFound, shape: mount.shape },
        findings,
        report: renderReport(findings, { title: `local link · ${dir}` }),
      }
    },
  })

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
        // The host kills a call at 120 s; anything above that is a promise the
        // host will not keep, and the gate's own five layers must fit inside it.
        timeoutMs: 120_000,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'read', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[publish-gate] ${t.name} registration skipped: ${error}`)
    }
  }
}

// =====================================================================
// helpers
// =====================================================================

// A package.json that does not parse is not a missing package.json: saying
// "there is none" sends the caller looking for a file that is right there.
// A workspace root usually keeps its plugins one level down, but a monorepo keeps them under
// `packages/` or `plugins/`. Read both the pnpm workspace file and package.json workspaces so a
// sweep does not silently see zero plugins.
function pluginDirs(root) {
  const seen = new Set()
  const out = []
  const addDir = (dir) => {
    if (!existsSync(join(dir, 'package.json')) || seen.has(dir)) return
    seen.add(dir)
    out.push(dir)
  }
  const addGlob = (pattern) => {
    const clean = String(pattern).replace(/^!/, '').replace(/['\"]/g, '').replace(/^\.\//, '').replace(/\/$/, '').trim()
    if (!clean || clean.includes('**')) return
    const base = clean.endsWith('/*') ? clean.slice(0, -2) : null
    if (base !== null) {
      try {
        for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
          if (e.isDirectory()) addDir(join(root, base, e.name))
        }
      } catch {}
      return
    }
    if (!clean.includes('*')) addDir(join(root, clean))
  }
  let globs = []
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const block = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split(/^packages:/m)[1] || ''
    globs = block.split(/\n/).map((line) => line.match(/^\s*-\s*(.+)$/)?.[1]).filter(Boolean)
  }
  const pkg = readJson(join(root, 'package.json'))
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
  if (Array.isArray(ws)) globs = globs.concat(ws)
  for (const g of globs) addGlob(g)
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') addDir(join(root, e.name))
    }
  } catch {}
  return out
}

function readJsonStrict(p) {
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return { json: null, error: null }
  }
  try {
    return { json: JSON.parse(text.replace(/^\uFEFF/, '')), error: null }
  } catch (error) {
    return { json: null, error: `${p} is not valid JSON: ${String(error?.message || error)}` }
  }
}

function readJson(p) {
  try {
    const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function repoUrl(repo) {
  const raw = typeof repo === 'string' ? repo : repo?.url
  if (!raw) return null
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(raw)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * Resolve a directory argument, defaulting to cwd when it holds a package.json.
 *
 * The host renders `parameters` into the prompt but never validates a call
 * against it, so `dir` really can arrive as a number or an object — and
 * path.join then throws a raw Node TypeError instead of a tool result.
 */
function resolveDir(dir) {
  if (typeof dir === 'string') {
    const trimmed = dir.trim()
    if (trimmed) return trimmed
  } else if (dir !== undefined && dir !== null) {
    // Wrong type: do NOT fall back to cwd, that would silently gate a different
    // plugin than the one that was asked for.
    return null
  }
  return existsSync(join(process.cwd(), 'package.json')) ? process.cwd() : null
}

async function gitConfig(key) {
  try {
    const { stdout } = await run(`git config ${key}`, { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}
