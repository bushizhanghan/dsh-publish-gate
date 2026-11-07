// dsh-publish-gate: agent tools that run the publish preflight.
//
// One entry point runs every static check, so an agent asked "can I ship
// this?" gets the same answer a human gets from the gate — a second
// implementation would drift and the two answers would disagree.
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import {
  bumpPatch,
  checkDocs,
  checkEntrySource,
  checkGitState,
  checkMarketEntry,
  checkMarketReadiness,
  checkNpmState,
  checkPackageJson,
  checkPack,
  checkPatchYml,
  checkPublishedMatches,
  checkTests,
  checkToolRegistrations,
  checkClientRuntime,
  checkVersionTaken,
  compareVersions,
  latestPublished,
  renderReport,
  runArtifactChecks,
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
}

const OUTPUT_SCHEMA = { type: 'json' }
const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  /** Everything that does not need the network. */
  function staticGate(dir) {
    return {
      ok: true,
      findings: runStaticChecks(dir),
      counts: null,
    }
  }

  /** Add the network-dependent checks, each failing soft. */
  async function networkGate(dir) {
    const findings = []
    const pkgJson = readJson(join(dir, 'package.json'))
    if (pkgJson?.name && pkgJson?.version) {
      findings.push(...(await checkVersionTaken(pkgJson.name, pkgJson.version, { registry: cfg.registry })))
    }
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
        'Run the full pre-publish gate over a DSH plugin directory. Three layers. (1) Manifest: missing exports["."], files omitting lib/, no "type": "module", UTF-8 BOM, JSON/YAML parse errors, cordis.patch.yml insert rows at the wrong indent (the bug that makes a plugin install and never mount), insert name mismatches, missing entry exports, an entry path that points at no file, a cordis.patch.yml the manifest never declares (inert), missing LICENSE or README install line, missing tests, unscoped npm names (the 403 you cannot diagnose). (2) Artifact: runs `npm pack --dry-run` and reads what npm will actually ship — lib/ missing from the tarball, a dsh.bundle.patch that never gets packed, oversize tarballs (test fixtures are the usual cause), dev directories shipping, and a prepack hook that means the dry run did not build. (3) Runtime: imports the entry in an isolated child process, calls apply(ctx) with a fake ctx, and reports a throwing import, a throwing apply, tools with no execute, duplicate tool names, a presentCall that throws, and card kinds the host does not render; then, if the package declares exports["./client"], loads the browser bundle against a fake window.__ModuleLoader__ and reports a bundle that never loads, never returns apply, throws, or registers nothing. Deterministic: every rule is a file, subprocess or API check, no LLM. Returns {ok, report, findings:[{rule,severity,title,detail,fix}], counts}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory to gate. Defaults to the current working directory.' },
          skipNetwork: { type: 'boolean', description: 'Skip the npm registry and GitHub checks (default false).' },
          skipPack: { type: 'boolean', description: 'Skip `npm pack --dry-run` (default false). Faster, but says nothing about the real tarball.' },
          skipTools: { type: 'boolean', description: 'Skip the isolated import of the plugin entry (default false).' },
          skipClient: { type: 'boolean', description: 'Skip the isolated load of the browser bundle (default false).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given and cwd has no package.json' }
        const findings = runStaticChecks(dir)
        const artifact = await runArtifactChecks(dir, { skipPack: args.skipPack, skipTools: args.skipTools, skipClient: args.skipClient })
        findings.push(...artifact.findings)
        if (!args.skipNetwork) findings.push(...(await networkGate(dir)))
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
          unpackedSize: artifact.pack?.unpackedSize ?? null,
          report: renderReport(findings, { title: `publish gate · ${dir}` }),
          safeToPublish: counts.error === 0,
        }
      },
    },
    {
      name: 'publish_gate_tools',
      description:
        'Import a plugin entry in an isolated child process, call apply(ctx) with a no-op context, and report what it actually registered. Catches the failures the manifest cannot show: the entry throws when imported, apply throws, a tool has no execute function, two tools share a name, presentCall throws, and a card kind the host does not render (the host only knows other/execute/search/read/edit/delete/fetch — anything else registers fine and renders a broken card). 20 s timeout, plugin code never runs in the host process. Returns {ok, tools:[{name,hasExecute,hasOutputSchema,cardKind}], findings, report}.',
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
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given' }
        const { findings, tools } = await checkToolRegistrations(dir, { timeoutMs: args.timeoutMs, calls: args.call })
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
        if (!dir) return { ok: false, error: 'no plugin directory given' }
        const { findings, client } = await checkClientRuntime(dir, { timeoutMs: args.timeoutMs })
        return { ok: true, client, findings, report: renderReport(findings, { title: `client gate · ${dir}` }) }
      },
    },
    {
      name: 'publish_gate_verify',
      description:
        'Check that the tarball on the npm registry is the one in this directory. Runs `npm pack --dry-run` and compares its shasum with the registry dist.shasum — an exact comparison, not a version-number guess, so it catches "I bumped and forgot to publish" and "I published, then edited lib/". Reports publish-served (match), publish-served-mismatch (the version is spent and the registry holds different bytes), or publish-not-served (not published, or still inside the registry\'s one-minute 202-then-404 window). Run it after `npm publish`. Returns {ok, name, version, published, shasumMatch, localShasum, unpackedSize, files, findings, report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          version: { type: 'string', description: 'Version to verify (defaults to package.json version).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given' }
        const json = readJson(join(dir, 'package.json'))
        if (!json?.name) return { ok: false, error: 'no package.json' }
        const version = args.version || json.version
        const { pack, findings: packFindings } = await checkPack(dir)
        if (!pack) return { ok: false, error: `npm pack --dry-run did not run, so there is nothing to compare: ${packFindings.map((f) => f.title).join('; ')}` }
        const findings = await checkPublishedMatches(json.name, version, pack, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })
        const served = findings.some((f) => f.rule === 'publish-served')
        return {
          ok: true,
          name: json.name,
          version,
          published: served || findings.some((f) => f.rule === 'publish-served-mismatch'),
          shasumMatch: served,
          localShasum: pack.shasum,
          unpackedSize: pack.unpackedSize,
          files: (pack.files || []).length,
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
        if (!dir) return { ok: false, error: 'no plugin directory given' }
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
          if (!dir) return { ok: false, error: 'no plugin directory given' }
          const findings = await checkMarketReadiness(dir, { timeoutMs: cfg.networkTimeoutMs })
          return { ok: true, findings, report: renderReport(findings, { title: `market readiness · ${dir}` }) }
        }
        let text = args.text ?? null
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
        if (!dir) return { ok: false, error: 'no plugin directory given' }
        const json = readJson(join(dir, 'package.json'))
        if (!json?.version) return { ok: false, error: 'no version in package.json' }
        const taken = (await checkVersionTaken(json.name, json.version, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })).map((f) => f.title)
        const latest = await latestPublished(json.name, { registry: cfg.registry, timeoutMs: cfg.networkTimeoutMs })
        // A checkout that is behind npm must bump from npm's latest, or the
        // "suggested" version is one that is already published.
        const behind = latest && compareVersions(latest, json.version) > 0 ? latest : null
        const base = behind ?? json.version
        const [a, b, c] = /^(\d+)\.(\d+)\.(\d+)/.exec(base)?.slice(1).map(Number) ?? [0, 0, 0]
        const bump = args.bump || 'patch'
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
        'Run the gate over every plugin in a directory tree (e.g. a workspace holding several plugin checkouts) and rank them by blocker count, so you can see which one is not ready to ship before you start a publish session. No registry or GitHub calls, so it is fast and works offline; each row also carries the real tarball size from `npm pack --dry-run` (pass skipPack to skip that and stay purely static). Returns {ok, plugins:[{dir,name,version,blockers,warns,notes,unpackedSize,files,top}], totals}.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Directory containing plugin checkouts.' },
          skipPack: { type: 'boolean', description: 'Skip `npm pack --dry-run` per plugin (default false).' },
        },
      },
      async execute(args) {
        const root = args.root || process.cwd()
        const { readdirSync, existsSync } = await import('node:fs')
        let entries = []
        try {
          entries = readdirSync(root, { withFileTypes: true })
        } catch {
          return { ok: false, error: `cannot read ${root}` }
        }
        const plugins = []
        for (const e of entries) {
          if (!e.isDirectory()) continue
          const dir = join(root, e.name)
          const json = readJson(join(dir, 'package.json'))
          if (!json?.name || !existsSync(join(dir, 'lib'))) continue
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
        return { ok: true, plugins, totals }
      },
    },
    {
      name: 'publish_gate_commands',
      description:
        'Report the exact publish commands for a plugin, in order, with the ones this machine has already completed marked: git init/commit, GitHub repo create, git push, npm publish, market entry, market PR. Use it to know where you are in the pipeline instead of re-deriving it. Returns {ok, steps:[{name,command,done,note}]}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory.' },
          owner: { type: 'string', description: 'GitHub owner (default: from git config user.name).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given' }
        const json = readJson(join(dir, 'package.json'))
        if (!json?.name) return { ok: false, error: 'no package.json' }
        const owner = args.owner || (await gitConfig('user.name')) || '<owner>'
        const repo = json.repository?.url?.match(/github\.com[:/]([^/]+)\/([^/.]+)/)?.[2] || json.name.replace(/^@[^/]+\//, '')
        const { existsSync } = await import('node:fs')
        const hasGit = existsSync(join(dir, '.git'))
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
            command: process.platform === 'win32' ? 'cmd /c "npm publish --access public"' : 'npm publish --access public',
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
          },          {
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
        return { ok: true, owner, repo, package: json.name, steps }
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
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

/** Resolve a directory argument, defaulting to cwd when it holds a package.json. */
function resolveDir(dir) {
  if (dir) return dir
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
