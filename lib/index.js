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
  checkNpmState,
  checkPackageJson,
  checkPatchYml,
  checkTests,
  checkVersionTaken,
  renderReport,
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
        'Run the full pre-publish gate over a DSH plugin directory and report every blocker: package.json completeness (missing exports["."], files omitting lib/, no "type": "module"), UTF-8 BOM, JSON/YAML parse errors, cordis.patch.yml insert rows written at the wrong indent (the bug that makes a plugin install and never mount), insert name mismatches, missing entry exports, missing LICENSE or README install line, missing tests, unscoped npm names (the 403 you cannot diagnose), and — with network — versions already on the registry and missing GitHub repos. Deterministic: every rule is a file or API check, no LLM. Returns {ok, report, findings:[{rule,severity,title,detail,fix}], counts}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Plugin directory to gate. Defaults to the current working directory.' },
          skipNetwork: { type: 'boolean', description: 'Skip the npm registry and GitHub checks (default false).' },
        },
      },
      async execute(args) {
        const dir = resolveDir(args.dir)
        if (!dir) return { ok: false, error: 'no plugin directory given and cwd has no package.json' }
        const findings = runStaticChecks(dir)
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
          report: renderReport(findings, { title: `publish gate · ${dir}` }),
          safeToPublish: counts.error === 0,
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
        'Validate a market submission entry (the YAML you put in data/plugins/<owner>__<repo>.yml): url is a GitHub URL, name is owner/repo, category is one the market knows, and description carries both en: and zh:. Catches the shape errors the submission gate rejects. Returns {ok, findings, report, entry}.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The entry YAML text.' },
          file: { type: 'string', description: 'Or a path to the entry file.' },
        },
      },
      async execute(args) {
        let text = args.text ?? null
        if (text === null && args.file) {
          try {
            const { readFileSync } = await import('node:fs')
            text = readFileSync(args.file, 'utf8')
          } catch {
            return { ok: false, error: `cannot read ${args.file}` }
          }
        }
        if (text === null) return { ok: false, error: 'give either text or file' }
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
        const taken = (await checkVersionTaken(json.name, json.version, { registry: cfg.registry })).map((f) => f.title)
        const [a, b, c] = /^(\d+)\.(\d+)\.(\d+)/.exec(json.version)?.slice(1).map(Number) ?? [0, 0, 0]
        const bump = args.bump || 'patch'
        const suggested =
          bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
        return { ok: true, current: json.version, taken, suggested, suggestedFor: bump }
      },
    },
    {
      name: 'publish_gate_doctor',
      description:
        'Run the gate over every plugin in a directory tree (e.g. a workspace holding several plugin checkouts) and rank them by blocker count, so you can see which one is not ready to ship before you start a publish session. Returns {ok, plugins:[{dir,blockers,warns,notes,top}], totals}.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Directory containing plugin checkouts.' },
          skipNetwork: { type: 'boolean', description: 'Skip registry/GitHub checks (default true for a multi-plugin sweep).' },
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
          plugins.push({
            dir,
            name: json.name,
            version: json.version,
            blockers: findings.filter((f) => f.severity === 'error').length,
            warns: findings.filter((f) => f.severity === 'warn').length,
            notes: findings.filter((f) => f.severity === 'info').length,
            top: top ? `${top.rule}: ${top.title}` : null,
          })
        }
        plugins.sort((a, b) => b.blockers - a.blockers || b.warns - a.warns)
        const totals = plugins.reduce(
          (acc, p) => ({ blockers: acc.blockers + p.blockers, warns: acc.warns + p.warns, notes: acc.notes + p.notes }),
          { blockers: 0, warns: 0, notes: 0 },
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
            command: `npm publish --access public`,
            done: false,
            note: `a bare (unscoped) name can return 403 with a granular token — "${json.name}" is ${json.name.startsWith('@') ? 'scoped, fine' : 'UNSCOPED, rename it'}`,
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
