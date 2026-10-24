// dsh-publish-gate engine: deterministic checks over the publish path.
//
// Every rule here exists because publishing four DSH plugins hit it for real:
// a UTF-8 BOM that made JSON.parse throw, a `files` field that omitted lib/,
// a patch insert written at the wrong indent so the plugin never mounted, an
// unscoped npm name that returned E403, a git push that failed on the network
// while the REST API worked. All of them are silent until the moment they cost
// you a publish, so they are all checkable before you spend it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const safeRead = (p) => {
  try {
    return readFileSync(p)
  } catch {
    return null
  }
}

const safeText = (p) => {
  const b = safeRead(p)
  return b === null ? null : b.toString('utf8')
}

export const F = (rule, severity, title, detail, fix) => ({ rule, severity, title, detail, fix })

// =====================================================================
// package.json
// =====================================================================

/** Required fields, and the ones that fail silently when missing. */
const REQUIRED = ['name', 'version', 'description', 'main', 'type', 'license', 'repository', 'author']
const SCOPED = /^@[a-z0-9-*~][a-z0-9-*._~]*\/[a-z0-9-~][a-z0-9-._~]*$/
const NPM_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export function checkPackageJson(dir) {
  const out = []
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return [F('missing-file', 'error', 'package.json not found', 'Nothing can be published without it.', 'Create one — copy a working plugin as the template.')]

  const buf = safeRead(path)
  if (buf === null) return [F('unreadable', 'error', 'package.json cannot be read', 'Check permissions.', 'Fix the file permissions.')]

  // BOM: PowerShell's Set-Content -Encoding UTF8 adds one, and JSON.parse
  // then throws "Unexpected token" with no mention of the BOM.
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    out.push(
      F(
        'utf8-bom',
        'error',
        'package.json starts with a UTF-8 BOM',
        'A byte-order mark makes JSON.parse throw `Unexpected token` and npm publish fail with a parse error that never names the BOM. PowerShell `Set-Content -Encoding UTF8` adds one by default.',
        'Rewrite the file without a BOM: `[IO.File]::WriteAllBytes($p, [Text.Encoding]::UTF8.GetBytes((Get-Content $p -Raw)))`',
      ),
    )
  }

  let json
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    return [...out, F('json-parse', 'error', `package.json is not valid JSON: ${String(e.message).slice(0, 80)}`, 'npm refuses to publish an unparseable manifest.', 'Fix the syntax error, then re-run this gate.')]
  }

  for (const field of REQUIRED) {
    if (json[field] === undefined || json[field] === null || json[field] === '') {
      out.push(F('missing-field', 'error', `package.json is missing "${field}"`, `npm warns but publishes; consumers then cannot resolve it.`, `Add "${field}".`))
    }
  }

  // name shape
  if (json.name && !NPM_NAME.test(json.name)) {
    out.push(
      F(
        'invalid-name',
        'error',
        `package name "${json.name}" is not a valid npm name`,
        'Lowercase, no spaces, no leading dot or underscore. npm rejects the publish with a 400 that is easy to misread.',
        'Rename to kebab-case.',
      ),
    )
  }

  // version shape
  if (json.version && !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(json.version)) {
    out.push(F('invalid-version', 'error', `version "${json.version}" is not semver`, 'npm publish rejects it.', 'Use MAJOR.MINOR.PATCH.'))
  }

  // type: module — the whole plugin surface is ESM
  if (json.type !== 'module') {
    out.push(
      F(
        'not-esm',
        'warn',
        'package.json has no "type": "module"',
        'DSH plugins are ESM. Without it, Node treats .js as CommonJS and `import` in your entry fails at load time — the plugin installs but never mounts.',
        'Add "type": "module".',
      ),
    )
  }

  // files — the classic: lib/ omitted, so the published tarball has no code
  if (Array.isArray(json.files)) {
    if (!json.files.includes('lib')) {
      out.push(
        F(
          'files-omits-lib',
          'error',
          'files does not include "lib"',
          'The published tarball will contain no code. npm packs only what files/exports allow, so `npm publish` succeeds and the package is empty.',
          'Add "lib" to files (and "cordis.patch.yml" if you ship one).',
        ),
      )
    }
    if (json.dsh?.bundle?.patch && !json.files.includes('cordis.patch.yml')) {
      out.push(
        F(
          'files-omits-patch',
          'error',
          'dsh.bundle.patch points at cordis.patch.yml but files does not include it',
          'The installed plugin has no patch to mount, so it installs and loads nothing. npm does not warn about this.',
          'Add "cordis.patch.yml" to files.',
        ),
      )
    }
  }

  // exports — DSH resolves the entry through exports["."], not main
  if (!json.exports || !json.exports['.']) {
    out.push(
      F(
        'no-exports',
        'error',
        'package.json has no exports["."]',
        'The host resolves the plugin through `exports["."]`; with only `main`, a bundler-resolving loader finds nothing and the plugin silently does not load.',
        'Add "exports": { ".": "./lib/index.js" }.',
      ),
    )
  }

  // client half
  const hasClient = typeof json.exports === 'object' && json.exports && json.exports['./client']
  const wantsClient = json.dsh?.client?.platform !== undefined
  if (wantsClient && !hasClient) {
    out.push(
      F(
        'client-without-export',
        'error',
        'dsh.client.platform is set but exports["./client"] is missing',
        'The host tries to load a client bundle that is not in the tarball; the host half works and the sidebar panel never appears.',
        'Add "exports": { "./client": "./lib/client.js" } and ship the file.',
      ),
    )
  }

  // repository.url — GitHub Actions and the market link use it
  if (typeof json.repository === 'string' && /^git\+/.test(json.repository) === false && !/github\.com/.test(json.repository)) {
    out.push(F('bad-repo-url', 'warn', `repository "${json.repository}" is not a github.com URL`, 'The market listing and issue links will not resolve.', 'Use "git+https://github.com/<owner>/<repo>.git".'))
  }

  // engines — a too-low floor lets the install succeed and then crash
  if (!json.engines?.node) {
    out.push(F('no-engines', 'info', 'no engines.node declared', 'Consumers on an older Node get a runtime error instead of an install-time message.', 'Add "engines": { "node": ">=22" }.'))
  }

  return out
}

// =====================================================================
// cordis.patch.yml — the indent trap that cost two plugins
// =====================================================================

export function checkPatchYml(dir) {
  const out = []
  const path = join(dir, 'cordis.patch.yml')
  if (!existsSync(path)) {
    if (existsSync(join(dir, 'lib', 'index.js'))) {
      out.push(F('no-patch-file', 'error', 'lib/index.js exists but cordis.patch.yml does not', 'Without a bundle patch the host never mounts your plugin: it installs, loads, and does nothing.', 'Add cordis.patch.yml with an insert row.'))
    }
    return out
  }
  const text = safeText(path)
  if (text === null) return [F('unreadable', 'error', 'cordis.patch.yml cannot be read', 'Check permissions.', 'Fix permissions.')]

  if (text.charCodeAt(0) === 0xfeff) {
    out.push(F('yaml-bom', 'error', 'cordis.patch.yml starts with a BOM', 'YAML parsers treat a BOM as content and fail with a cryptic error.', 'Rewrite without a BOM.'))
  }

  // find insert rows and the package name they mount
  const pkgJson = (() => {
    const t = safeText(join(dir, 'package.json'))
    if (!t) return null
    try {
      return JSON.parse(t.replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  })()
  const name = pkgJson?.name

  const lines = text.split('\n')
  const insertRows = []
  let inInsert = false
  let insertIndent = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const insertMatch = /^(\s*)-?\s*insert:\s*$/.exec(line)
    if (insertMatch) {
      inInsert = true
      insertIndent = insertMatch[1].length
      continue
    }
    const idMatch = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      const indent = idMatch[1].length
      const id = idMatch[2].replace(/^['"]|['"]$/g, '')
      insertRows.push({ line: i + 1, indent, id, underInsert: inInsert && indent > insertIndent })
      continue
    }
    // a top-level key (indent 0, no dash) closes the insert sequence
    if (/^\S/.test(line)) inInsert = false
  }

  if (insertRows.length === 0) {
    out.push(
      F(
        'no-insert-row',
        'error',
        'cordis.patch.yml has no insert row',
        'A patch with only overrides never mounts your plugin.',
        'Add:\n- insert:\n    - id: <your-plugin-id>\n      name: "<package-name>"',
      ),
    )
    return out
  }

  for (const row of insertRows) {
    if (!row.underInsert) {
      // the exact bug that kept page-monitor and weapp-loop from loading:
      // an insert row written at column 0 becomes a top-level patch entry,
      // which the loader applies to an id that is not in the tree.
      out.push(
        F(
          'insert-wrong-indent',
          'error',
          `insert row "${row.id}" (line ${row.line}) is not inside an "- insert:" sequence`,
          'A top-level `- id:` row is a patch on an existing entry, not a mount. The loader reports one stderr warning and boots without your plugin — installed, loaded, and silent.',
          'Indent it under `- insert:`:\n- insert:\n    - id: <id>\n      name: "<pkg>"',
        ),
      )
    }
  }

  // every insert row must carry a name that matches package.json
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(lines[i])
    if (!m || m[1].length <= 2) continue
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(lines[i + 1] || '')
    if (!nameMatch) {
      out.push(
        F(
          'insert-missing-name',
          'error',
          `insert row on line ${i + 1} has no name: field`,
          'The loader mounts by package name; without it the row resolves to nothing.',
          `Add the next line:      name: "${name || '<package-name>'}"`,
        ),
      )
      continue
    }
    const mounted = nameMatch[1].replace(/^['"]|['"]$/g, '')
    if (name && mounted !== name) {
      out.push(
        F(
          'insert-name-mismatch',
          'error',
          `patch mounts "${mounted}" but package.json name is "${name}"`,
          'The row mounts a package that npm will not publish under this name, so the install finds nothing.',
          `Use name: "${name}".`,
        ),
      )
    }
  }

  // name: must be resolvable in node_modules for a local dev install
  if (name) {
    const rel = name.startsWith('@') ? name : name
    const candidates = [join(dir, 'node_modules', rel), join(dir, '..', 'node_modules', rel)]
    const localDev = candidates.some((c) => existsSync(join(c, 'package.json')))
    if (!localDev && existsSync(join(dir, 'node_modules'))) {
      out.push(
        F(
          'patch-name-unresolvable',
          'warn',
          `patch mounts "${name}" but it is not in node_modules`,
          'A scoped package must live at node_modules/@scope/name; a junction at node_modules/name is not found. This is the junction trap.',
          `Link it: cmd /c mklink /J node_modules\\${name} <target-dir>`,
        ),
      )
    }
  }

  return out
}

// =====================================================================
// README / LICENSE
// =====================================================================
export function checkDocs(dir) {
  const out = []
  if (!existsSync(join(dir, 'README.md'))) {
    out.push(F('no-readme', 'warn', 'README.md is missing', 'npm renders it as the package page; the market submission also wants install instructions.', 'Add a README with the install command.'))
  } else {
    const text = safeText(join(dir, 'README.md'))
    if (text && !/dsh plugin .*add/.test(text)) {
      out.push(F('readme-no-install', 'warn', 'README has no `dsh plugin ... add` install line', 'Users cannot install from the README, and the market reviewer looks for exactly this line.', 'Add the install command near the top.'))
    }
    // the profile flag can sit either side of `add`:
    //   dsh plugin --profile desktop add <pkg>
    //   dsh plugin add <pkg> --profile desktop
    if (text && !/dsh plugin .*add .*--profile/.test(text) && !/dsh plugin --profile \S+ add/.test(text)) {
      out.push(F('readme-no-profile', 'info', 'README install line omits --profile', 'Omitting it installs into the default profile, which is not what every user wants.', 'Show `dsh plugin --profile desktop add <pkg>`.'))
    }
  }
  if (!existsSync(join(dir, 'LICENSE'))) {
    out.push(F('no-license', 'error', 'LICENSE is missing', 'npm warns on publish and the market listing shows an unknown license.', 'Add a LICENSE file (MIT is the ecosystem norm).'))
  } else {
    const json = (() => {
      const t = safeText(join(dir, 'package.json'))
      try {
        return t ? JSON.parse(t.replace(/^\uFEFF/, '')) : null
      } catch {
        return null
      }
    })()
    if (json?.license && json.license !== 'SEE LICENSE IN LICENSE' && !safeText(join(dir, 'LICENSE'))?.includes(json.license)) {
      out.push(F('license-mismatch', 'warn', `package.json says "${json.license}" but the LICENSE text does not mention it`, 'A reviewer reads the mismatch as sloppiness at best.', 'Align them.'))
    }
  }
  return out
}

// =====================================================================
// npm / GitHub / market state
// =====================================================================

export function checkNpmState(dir, { token, registry = 'https://registry.npmjs.org' } = {}) {
  const out = []
  const json = (() => {
    const t = safeText(join(dir, 'package.json'))
    try {
      return t ? JSON.parse(t.replace(/^\uFEFF/, '')) : null
    } catch {
      return null
    }
  })()
  if (!json?.name) return out

  // unscoped + granular token = E403 on the PUT, discovered the hard way
  if (!json.name.startsWith('@')) {
    out.push(
      F(
        'unscoped-name',
        'warn',
        `"${json.name}" is an unscoped package name`,
        'A granular access token scoped to an owner cannot publish a bare name — the registry answers 403 on the PUT and the error names neither the token nor the scope. Publishing under @owner/pkg avoids it entirely.',
        'Rename to @<owner>/<name>, or mint a token with publish rights for the bare name.',
      ),
    )
  }

  // is the version already live? publishing the same version twice is a 403
  if (token) {
    const url = `${registry.replace(/\/$/, '')}/${json.name.replace('/', '%2f')}`
    out.push(...[]) // filled asynchronously by the caller
  }
  return out
}

/** Version-collision check: the same version already on the registry. */
export async function checkVersionTaken(name, version, { registry = 'https://registry.npmjs.org' } = {}) {
  const out = []
  try {
    const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
    if (res.status === 404) return out // never published: fine
    if (!res.ok) return out
    const json = await res.json()
    if (json?.versions?.[version]) {
      out.push(
        F(
          'version-taken',
          'error',
          `${name}@${version} is already on the registry`,
          'npm refuses to overwrite a published version (403). You must bump the version first, and a tarball that fails here has already been uploaded once.',
          `Bump to ${bumpPatch(version)}.`,
        ),
      )
    }
  } catch {}
  return out
}

export function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v
}

export function checkGitState(dir) {
  const out = []
  const gitDir = join(dir, '.git')
  if (!existsSync(gitDir)) {
    out.push(F('no-git', 'warn', 'not a git repository', 'The market submission wants a repository URL; without one there is nothing to submit.', 'git init && git add -A && git commit'))
    return out
  }
  if (!existsSync(join(dir, '.gitignore'))) {
    out.push(F('no-gitignore', 'info', 'no .gitignore', 'node_modules and *.tgz end up in the repo and the market diff.', 'Add node_modules/ and *.tgz.'))
  }
  return out
}

// =====================================================================
// Market entry
// =====================================================================
export function checkMarketEntry(text) {
  const out = []
  if (text === null || text.trim() === '') return [F('market-empty', 'error', 'market entry is empty', 'Nothing to submit.', 'Fill in the entry.')]
  const url = /^url:\s*(\S+)/m.exec(text)
  if (!url) out.push(F('market-no-url', 'error', 'market entry has no url', 'The listing links nowhere.', 'Add url: https://github.com/<owner>/<repo>'))
  else if (!/github\.com/.test(url[1])) out.push(F('market-url-not-github', 'warn', `market url "${url[1]}" is not a GitHub URL`, 'The listing points somewhere other than the repo.', 'Use the GitHub URL.'))

  const name = /^name:\s*(\S+)/m.exec(text)
  if (!name) out.push(F('market-no-name', 'error', 'market entry has no name', 'The listing has no title.', 'Add name: <owner>/<repo>'))
  else if (name[1].includes('/') === false) out.push(F('market-name-shape', 'warn', `market name "${name[1]}" is not owner/repo`, 'The listing title will not match the repo.', 'Use owner/repo.'))

  const cat = /^category:\s*(\S+)/m.exec(text)
  if (!cat) out.push(F('market-no-category', 'error', 'market entry has no category', 'The submission gate rejects it.', 'Add category: dev (or another listed category).'))
  else {
    const KNOWN = new Set(['ui', 'tools', 'session', 'dev', 'workflow', 'model', 'usage', 'memory', 'theme', 'notify', 'skill', 'fun', 'remote', 'security', 'git', 'browser', 'vision', 'docs', 'market', 'voice', 'wsl', 'identity', 'agi'])
    if (!KNOWN.has(cat[1])) out.push(F('market-bad-category', 'warn', `category "${cat[1]}" is not one of the market's categories`, 'It may be accepted, but a known category is safer.', `Use one of: ${[...KNOWN].join(', ')}`))
  }

  // description block with both languages
  const descMatch = /description:\s*\n((?:\s{2,}.*\n?)*)/.exec(text)
  if (!descMatch) out.push(F('market-no-desc', 'error', 'market entry has no description block', 'The listing shows no summary.', 'Add description with en and zh.'))
  else {
    const block = descMatch[1]
    if (!/\ben:/.test(block)) out.push(F('market-no-en', 'warn', 'description has no en: line', 'English readers see nothing.', 'Add en: ...'))
    if (!/\bzh:/.test(block)) out.push(F('market-no-zh', 'warn', 'description has no zh: line', 'Chinese readers see nothing — most of this market is Chinese.', 'Add zh: ...'))
  }
  return out
}

// =====================================================================
// Source sanity: the entry protocol
// =====================================================================
export function checkEntrySource(dir) {
  const out = []
  const path = join(dir, 'lib', 'index.js')
  if (!existsSync(path)) return out
  const text = safeText(path)
  if (text === null) return out

  if (!/export\s+const\s+name/.test(text)) out.push(F('no-name-export', 'error', 'lib/index.js does not export `name`', 'The host identifies the plugin by this export; without it the bundle fails to apply.', 'Add `export const name = \'<id>\'`.'))
  if (!/export\s+(?:const|function)\s+apply/.test(text)) out.push(F('no-apply-export', 'error', 'lib/index.js does not export `apply`', 'cordis calls apply(ctx, config); without it nothing happens.', 'Add `export function apply(ctx, config) {}`.'))
  if (!/export\s+const\s+inject/.test(text)) out.push(F('no-inject', 'warn', 'lib/index.js does not export `inject`', 'Without an inject list the service is resolved late and `ctx.tools` may be undefined when apply runs.', 'Add `export const inject = [\'tools\']`.'))
  // require() in ESM blows up at load
  if (/^\s*const\s+\w+\s*=\s*require\(/m.test(text)) {
    out.push(
      F(
        'require-in-esm',
        'error',
        'lib/index.js calls require() inside an ESM module',
        'Mixing require with top-level await or a static import in an ESM file throws ERR_AMBIGUOUS_MODULE_SYNTAX at load, which surfaces as "plugin failed to load" with no line number.',
        'Use a static import instead.',
      ),
    )
  }
  return out
}

// =====================================================================
// Tests
// =====================================================================
export function checkTests(dir) {
  const out = []
  const testDir = join(dir, 'test')
  if (!existsSync(testDir)) {
    out.push(F('no-tests', 'warn', 'no test/ directory', 'A plugin with no tests ships rules nobody has run; the market does not require tests, but reviewers notice.', 'Add node --test tests.'))
    return out
  }
  const hasTest = ['engine.test.mjs', 'integration.test.mjs'].some((f) => existsSync(join(testDir, f)))
  if (!hasTest) out.push(F('no-test-files', 'warn', 'test/ has no *.test.mjs', 'Add at least an engine test so the rules are exercised.', 'Add test/engine.test.mjs.'))
  const pkgJson = (() => {
    const t = safeText(join(dir, 'package.json'))
    try {
      return t ? JSON.parse(t.replace(/^\uFEFF/, '')) : null
    } catch {
      return null
    }
  })()
  if (!pkgJson?.scripts?.test) out.push(F('no-test-script', 'info', 'package.json has no "test" script', 'npm test does nothing, so CI and reviewers cannot run your checks.', 'Add "scripts": { "test": "node --test test/" }.'))
  return out
}

// =====================================================================
// Orchestration
// =====================================================================
export function runStaticChecks(dir) {
  return [
    ...checkPackageJson(dir),
    ...checkPatchYml(dir),
    ...checkEntrySource(dir),
    ...checkDocs(dir),
    ...checkTests(dir),
    ...checkNpmState(dir),
    ...checkGitState(dir),
  ]
}

const RULE_ORDER = [
  'missing-file', 'unreadable', 'utf8-bom', 'json-parse', 'yaml-bom', 'invalid-name', 'invalid-version',
  'missing-field', 'not-esm', 'files-omits-lib', 'files-omits-patch', 'no-exports', 'client-without-export',
  'no-patch-file', 'no-insert-row', 'insert-wrong-indent', 'insert-missing-name', 'insert-name-mismatch',
  'patch-name-unresolvable', 'no-name-export', 'no-apply-export', 'no-inject', 'require-in-esm',
  'no-license', 'license-mismatch', 'version-taken', 'market-empty', 'market-no-url', 'market-url-not-github',
  'market-no-name', 'market-name-shape', 'market-no-category', 'market-bad-category', 'market-no-desc',
  'market-no-en', 'market-no-zh', 'unscoped-name', 'no-git', 'no-readme', 'readme-no-install', 'readme-no-profile',
  'no-tests', 'no-test-files', 'no-test-script', 'no-engines', 'bad-repo-url', 'no-gitignore',
]

const MARK = { error: '✗', warn: '!', info: '·' }

export function renderReport(findings, { title = 'publish gate' } = {}) {
  if (findings.length === 0) return `\n${title}: no blockers. Safe to publish.\n`
  const ordered = [...findings].sort((a, b) => {
    const sa = RULE_ORDER.indexOf(a.rule)
    const sb = RULE_ORDER.indexOf(b.rule)
    return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb)
  })
  const lines = ['', `${title}: ${findings.length} finding(s)`, '']
  for (const f of ordered) {
    lines.push(`${MARK[f.severity] ?? '·'} ${f.title}  [${f.rule}]`)
    lines.push(`    ${f.detail}`)
    if (f.fix) lines.push(`    fix ${f.fix}`)
    lines.push('')
  }
  const errors = findings.filter((f) => f.severity === 'error').length
  const warns = findings.filter((f) => f.severity === 'warn').length
  const infos = findings.filter((f) => f.severity === 'info').length
  lines.push(errors ? `${errors} blocker(s) — fix before publishing` : warns ? `no blockers, ${warns} warning(s)` : 'clean')
  if (infos) lines.push(`${infos} note(s)`)
  lines.push('')
  return lines.join('\n')
}
