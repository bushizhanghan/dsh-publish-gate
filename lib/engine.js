// dsh-publish-gate engine: deterministic checks over the publish path.
//
// Every rule here exists because publishing four DSH plugins hit it for real:
// a UTF-8 BOM that made JSON.parse throw, a `files` field that omitted lib/,
// a patch insert written at the wrong indent so the plugin never mounted, an
// unscoped npm name that returned E403, a git push that failed on the network
// while the REST API worked. All of them are silent until the moment they cost
// you a publish, so they are all checkable before you spend it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { builtinModules } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

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

/** package.json without the BOM trap. Null when it is missing or unparseable. */
export function readPkgJson(dir) {
  const text = safeText(join(dir, 'package.json'))
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** Every file under root matching filter, skipping node_modules. */
function walkFiles(root, filter, acc = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walkFiles(p, filter, acc)
    } else if (filter.test(e.name)) acc.push(p)
  }
  return acc
}

/** Drop a trailing // comment so a commented-out line is not reported as live code. */
const stripComment = (line) => line.replace(/\/\/.*$/, '')

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Which of `src/` and `lib/` was touched last.
 *
 * The two failure modes look identical from the outside and both ship code the
 * author never ran:
 *   - src newer  -> lib is stale build output. Publishing with --ignore-scripts
 *     (or a missing prepack) ships the old bytes.
 *   - lib newer  -> lib was hand-edited after the source. The next clean build
 *     silently drops those edits, so the published tarball is not reproducible.
 */
export function checkBuildFreshness(dir) {
  const src = join(dir, 'src')
  if (!existsSync(src)) return []
  const newest = (root) => walkFiles(root, /\.(?:[cm]?[jt]sx?)$/, []).reduce((max, f) => Math.max(max, mtimeOf(f)), 0)
  const srcTime = newest(src)
  const libTime = newest(join(dir, 'lib'))
  if (!srcTime || !libTime) return []
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  if (srcTime > libTime + 1000) {
    return [
      F(
        'stale-build',
        'warn',
        `src/ is newer than lib/ (${stamp(srcTime)} vs ${stamp(libTime)})`,
        'lib/ is what npm ships. If the build did not run before publish, the tarball carries the old output.',
        'Run the build (npm run build) and commit the result, or check that prepack runs it.',
      ),
    ]
  }
  if (libTime > srcTime + 1000) {
    return [
      F(
        'hand-edited-build',
        'warn',
        `lib/ is newer than src/ (${stamp(libTime)} vs ${stamp(srcTime)})`,
        'lib/ was edited after the source. A clean build overwrites it, so the published bytes cannot be reproduced from src/.',
        'Port the change into src/ and rebuild, or accept that the next build drops it.',
      ),
    ]
  }
  return []
}

const bytesHuman = (n) => {
  const v = Number(n) || 0
  return v >= 1_048_576 ? `${(v / 1_048_576).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} kB` : `${v} B`
}

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
    // `main` is optional when the package resolves through exports["."]:
    // an exports-only manifest is the modern shape and loads fine.
    if (field === 'main' && json.exports?.['.']) continue
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

  // files — the classic: lib/ omitted, so the published tarball has no code.
  // "lib/", "./lib" and "lib/**/*.js" all pack lib/, so match the entry rather
  // than the exact string "lib".
  if (Array.isArray(json.files)) {
    const packsLib = json.files.some((f) => {
      const norm = String(f).replace(/^\.\//, '').replace(/\/+$/, '')
      return norm === 'lib' || norm === 'lib/**/*' || norm.startsWith('lib/')
    })
    if (!packsLib) {
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
  // The mirror image, and the quieter one: the bundle ships, but nothing tells
  // the host to load it. It installs, the host half works, the file is dead
  // weight — and there is no error anywhere.
  if (hasClient && !wantsClient) {
    out.push(
      F(
        'client-without-platform',
        'error',
        'exports["./client"] is declared but dsh.client.platform is missing',
        'The host decides whether to fetch a client bundle from dsh.client.platform; without it the file ships and is never loaded.',
        'Add "dsh": { "client": { "platform": "web" } }.',
      ),
    )
  }

  // repository.url — GitHub Actions and the market link use it. Both shapes
  // occur: a bare string, and the {type,url} object npm documents. The object
  // form used to slip through, because the check tested `typeof === 'string'`
  // and every plugin in this workspace writes the object form.
  const repoRaw = typeof json.repository === 'string' ? json.repository : json.repository?.url
  if (typeof repoRaw === 'string' && !/github\.com/.test(repoRaw)) {
    out.push(F('bad-repo-url', 'warn', `repository "${repoRaw}" is not a github.com URL`, 'The market listing and issue links will not resolve.', 'Use "git+https://github.com/<owner>/<repo>.git".'))
  }

  // "private": true is the one flag npm refuses outright (EPRIVATE), and it is
  // easy to leave behind from a scaffolding template.
  if (json.private === true) {
    out.push(
      F(
        'private-field-set',
        'error',
        '"private": true blocks publishing outright',
        'npm refuses with EPRIVATE and no partial state, so this is a hard stop rather than a risk.',
        'Remove "private": true (or set it false) before publishing.',
      ),
    )
  }

  // publishConfig.registry redirects the publish. A leftover internal registry
  // means the release lands somewhere nobody else can install from.
  const targetRegistry = json.publishConfig?.registry
  if (typeof targetRegistry === 'string' && !/^https?:\/\/registry\.npmjs\.org\/?$/.test(targetRegistry)) {
    out.push(
      F(
        'publish-config-registry',
        'warn',
        `publishConfig.registry points at ${targetRegistry}`,
        'npm publishes there instead of the public registry, so the version you announce is not the version consumers can install.',
        'Remove publishConfig.registry, or confirm that registry is intentional.',
      ),
    )
  }

  // engines — a too-low floor lets the install succeed and then crash
  if (!json.engines?.node) {
    out.push(F('no-engines', 'info', 'no engines.node declared', 'Consumers on an older Node get a runtime error instead of an install-time message.', 'Add "engines": { "node": ">=22" }.'))
  }

  // Scoped packages default to restricted. Publish one without --access public
  // (or publishConfig.access) and it installs for you and 404s for everyone
  // else — the publish output says nothing about it. Info, not a defect:
  // `publish_gate_commands` always emits --access public, so this is a
  // reminder to make that explicit in the manifest rather than to change it.
  if (typeof json.name === 'string' && json.name.startsWith('@') && json.publishConfig?.access !== 'public') {
    out.push(
      F(
        'no-publish-config-access',
        'info',
        'scoped name without publishConfig.access: "public"',
        'npm publishes a scoped package as restricted unless you pass --access public or set publishConfig.access. A restricted package installs fine on the machine that published it and 404s for every other consumer, with no hint in the publish output. Already-public packages stay public, so this only matters on a first publish.',
        'Add "publishConfig": { "access": "public" }, or always publish with --access public (publish_gate_commands does).',
      ),
    )
  }

  // The patch file is inert without the declaration. The host mounts a plugin
  // through dsh.bundle.patch; with the file present but undeclared, the plugin
  // installs, the entry loads, and no tool or panel ever appears.
  if (existsSync(join(dir, 'cordis.patch.yml')) && !json.dsh?.bundle?.patch) {
    out.push(
      F(
        'bundle-patch-not-declared',
        'error',
        'cordis.patch.yml exists but dsh.bundle.patch is not declared',
        'The host mounts a plugin through dsh.bundle.patch. Without the declaration the patch file is inert: the plugin installs, its entry loads, and no tool or panel ever appears. Nothing reports an error, because from the host point of view nothing was ever asked of it.',
        'Add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }.',
      ),
    )
  }

  // Entry paths pointing at files that are not there. npm does not validate
  // them, so the package publishes and every consumer hits a bare
  // MODULE_NOT_FOUND that never names the manifest field responsible.
  const entryTargets = [
    ['main', typeof json.main === 'string' ? json.main : null],
    ['exports["."]', typeof json.exports === 'object' && json.exports ? json.exports['.'] : null],
    ['exports["./client"]', typeof json.exports === 'object' && json.exports ? json.exports['./client'] : null],
  ]
  for (const [field, target] of entryTargets) {
    if (typeof target !== 'string' || target.includes('*')) continue
    const rel = target.replace(/^\.\//, '')
    if (existsSync(join(dir, rel))) continue
    out.push(
      F(
        'entry-path-missing',
        'error',
        `${field} points at "${target}", which does not exist`,
        'The manifest publishes, the package resolves, and the import then fails at load time with a MODULE_NOT_FOUND that does not name the field responsible.',
        `Create ${target}, or point ${field} at the file you actually ship.`,
      ),
    )
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
  const name = readPkgJson(dir)?.name

  const lines = text.split('\n')
  const insertRows = []
  const patchRows = []
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
      // A row at column 0 is a patch on an existing entry — the shape every
      // profile patch is made of. Only a row nested inside "- insert:" mounts
      // a package, and calling the patch row a mis-indented insert told users
      // to indent it, which would insert a duplicate of an existing id.
      if (inInsert && indent > insertIndent) insertRows.push({ line: i + 1, indent, id })
      else patchRows.push({ line: i + 1, indent, id })
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
        `A patch with only overrides never mounts your plugin.${patchRows.length > 0 ? ` This file has ${patchRows.length} top-level \`- id:\` row(s) — those patch entries that already exist in the tree, they do not add one.` : ''}`,
        'Add:\n- insert:\n    - id: <your-plugin-id>\n      name: "<package-name>"',
      ),
    )
    return out
  }

  // Patching is legitimate (that is how a profile overrides a model or a
  // theme), but it must not be mistaken for a mount.
  if (patchRows.length > 0) {
    out.push(
      F(
        'patch-not-mount',
        'info',
        `${patchRows.length} top-level \`- id:\` row(s) patch existing entries (line ${patchRows.map((r) => r.line).join(', ')})`,
        'These rows override an entry that is already in the tree. They are not mounts: if you meant to add this package, it needs an "- insert:" row.',
        'Nothing to do if you are overriding. If not, move the row under "- insert:".',
      ),
    )
  }

  // every insert row must carry a name that matches package.json
  for (const row of insertRows) {
    const i = row.line - 1
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(lines[i + 1] || '')
    if (!nameMatch) {
      out.push(
        F(
          'insert-missing-name',
          'error',
          `insert row on line ${row.line} has no name: field`,
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
    // A README copied from another plugin keeps the old package name, and the
    // install line then installs something else entirely — with no error, since
    // that package really does exist.
    const pkg = readPkgJson(dir)
    if (text && pkg?.name) {
      const specs = [...text.matchAll(/dsh plugin\b[^\n]*?\badd\s+(?:--profile\s+\S+\s+)?(\S+)/g)]
        .map((m) => m[1].replace(/[`'"]/g, '').trim())
        .filter((s) => s && !s.startsWith('-'))
      const wrong = [...new Set(specs)].filter((s) => {
        if (s === pkg.name || s.startsWith('github:') || s.includes('://')) return false
        // A different install FORM is not a copy-paste slip: an unscoped name in
        // a scoped package's README is usually just shorthand for a dependency.
        if (s.startsWith('@') !== pkg.name.startsWith('@')) return false
        return /^@[\w.-]+\/[\w.-]+$|^[\w.-]+$/.test(s)
      })
      for (const spec of wrong) {
        out.push(
          F(
            'readme-wrong-package',
            'error',
            `README install line says "${spec}" but the package is "${pkg.name}"`,
            'A README copied from another plugin keeps the old name. Whoever follows it installs a different package — and nothing fails, because that package exists too.',
            `Change the install line to ${pkg.name}.`,
          ),
        )
      }
    }
  }
  if (!existsSync(join(dir, 'LICENSE'))) {
    out.push(F('no-license', 'error', 'LICENSE is missing', 'npm warns on publish and the market listing shows an unknown license.', 'Add a LICENSE file (MIT is the ecosystem norm).'))
  } else {
    const json = readPkgJson(dir)
    if (json?.license && json.license !== 'SEE LICENSE IN LICENSE' && !safeText(join(dir, 'LICENSE'))?.includes(json.license)) {
      out.push(F('license-mismatch', 'warn', `package.json says "${json.license}" but the LICENSE text does not mention it`, 'A reviewer reads the mismatch as sloppiness at best.', 'Align them.'))
    }
  }
  return out
}

// =====================================================================
// npm / GitHub / market state
// =====================================================================

/**
 * Who npm thinks you are on this machine.
 *
 * A publish fails at the very last step with ENEEDAUTH or a 403 that names
 * neither the token nor the scope. Asking first turns that into a message
 * instead of a spent version number.
 */
export async function checkPublishIdentity(dir, { timeoutMs = 15000, whoami } = {}) {
  const out = []
  let who = whoami
  if (who === undefined) {
    try {
      const isWin = process.platform === 'win32'
      const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm'
      const args = isWin ? ['/d', '/s', '/c', 'npm whoami'] : ['whoami']
      const { stdout } = await runFile(cmd, args, { timeout: timeoutMs, windowsHide: true })
      who = stdout.trim() || null
    } catch (error) {
      const text = String(error?.stderr || error?.message || error)
      if (/ENEEDAUTH|E401|not logged in|need auth/i.test(text)) {
        out.push(
          F(
            'npm-not-logged-in',
            'error',
            'npm has no usable login on this machine',
            '`npm publish` will fail with ENEEDAUTH after the tarball has been built. A granular token that lacks publish rights fails later still, with a 403 that names neither the token nor the scope.',
            'Run `npm login`, or put a publish-capable token in ~/.npmrc.',
          ),
        )
      } else {
        out.push(
          F(
            'npm-whoami-unavailable',
            'info',
            'could not ask npm who is logged in',
            'The publish-identity check did not run, so nothing is claimed about it.',
            'Make sure npm is on PATH and re-run.',
          ),
        )
      }
      return out
    }
  }

  const pkg = readPkgJson(dir)
  const scope = /^@([^/]+)\//.exec(pkg?.name || '')?.[1]
  if (who && scope && who !== scope) {
    out.push(
      F(
        'npm-scope-mismatch',
        'warn',
        `logged in as "${who}" but the package is under @${scope}`,
        `Publishing under a scope needs a token that owns that scope. A granular token scoped to another owner answers 403 on the PUT — the error names neither the token nor the scope, which is why this takes an hour to diagnose.`,
        `Log in as ${scope}, or mint a token with publish rights for @${scope}.`,
      ),
    )
  }
  return out
}

export function checkNpmState(dir) {
  const out = []
  const json = readPkgJson(dir)
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

  // Whether the version is already live needs the network: that is
  // checkVersionTaken / latestPublished. Nothing synchronous belongs here.
  return out
}

/**
 * Version-collision check: the same version already on the registry.
 * `doc` injects a registry document so the rule is testable without the network.
 */
export async function checkVersionTaken(name, version, { registry = 'https://registry.npmjs.org', timeoutMs = 8000, doc } = {}) {
  const out = []
  try {
    let json = doc ?? null
    if (!json) {
      const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 404) return out // never published: fine
      if (!res.ok) {
        // A 500 or a rate limit is not proof the version is free. Saying nothing
        // here made the gate report "clean" for a check that never ran.
        out.push(
          F(
            'registry-unreachable',
            'warn',
            `could not read ${name} from the registry (HTTP ${res.status})`,
            'The version-taken check did not run, so this is NOT a clean version check. npm itself will still refuse a duplicate on publish.',
            'Re-run the gate later, or check https://www.npmjs.com/package/' + name + '?activeTab=versions by hand.',
          ),
        )
        return out
      }
      json = await res.json()
    }
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

    // npm accepts a publish of an OLDER version without a word. It lands in
    // `versions`, but `dist-tags.latest` keeps pointing at the newer one, so
    // anyone installing by name never receives it. The tarball is uploaded and
    // invisible — which reads exactly like "my update did not reach anyone".
    const latest = json?.['dist-tags']?.latest
    if (latest && compareVersions(version, latest) < 0) {
      out.push(
        F(
          'version-behind-latest',
          'error',
          `${name}@${version} is older than the published latest ${latest}`,
          'npm will accept this publish and leave `latest` on the newer version, so install-by-name keeps resolving to the old code. Nothing errors; the release simply never reaches anyone.',
          `Publish ${bumpPatch(latest)} or higher instead.`,
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

/** -1 / 0 / 1 by semver-ish comparison of the numeric part. */
export function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a))?.slice(1).map(Number) ?? [0, 0, 0]
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(String(b))?.slice(1).map(Number) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  return 0
}

/**
 * The registry's `dist-tags.latest`, or null when it could not be read.
 * next_version needs this: a local checkout that is BEHIND npm would otherwise
 * be told to publish a version that is already taken.
 */
export async function latestPublished(name, { registry = 'https://registry.npmjs.org', timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.['dist-tags']?.latest ?? null
  } catch {
    return null
  }
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

// The submission gate is where a release stalls after all the local checks are
// green: the catalogue already has this repo (a duplicate PR), the repo is too
// young (the gate fails with "0.0 days old" and only reruns on its own), or the
// name is taken. All three are visible before opening the PR — this reads the
// live catalogue and the GitHub repo metadata instead of guessing.
const CATALOGUE_URL = 'https://awesome-dsh-plugin.com/plugins.json'
let catalogueCache = null

export function repoSlug(dir) {
  const json = readPkgJson(dir)
  const raw = typeof json?.repository === 'string' ? json.repository : json?.repository?.url
  if (typeof raw !== 'string') return null
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/.exec(raw.replace(/^git\+/, ''))
  return m ? `${m[1]}/${m[2]}` : null
}

export async function checkMarketReadiness(dir, opts = {}) {
  const out = []
  const timeoutMs = opts.timeoutMs ?? 8000
  const slug = repoSlug(dir)
  if (!slug) {
    out.push(F('market-no-repo', 'warn', 'package.json has no GitHub repository', 'The market lists GitHub repos; without one there is nothing to submit.', 'Add repository.url.'))
    return out
  }
  const json = readPkgJson(dir)
  const pkgName = typeof json?.name === 'string' ? json.name : null

  let entries = Array.isArray(opts.entries) ? opts.entries : null
  try {
    if (!entries) {
      if (!catalogueCache) {
        const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'dsh-publish-gate' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        catalogueCache = Array.isArray(data) ? data : Array.isArray(data?.plugins) ? data.plugins : []
      }
      entries = catalogueCache
    }
  } catch (error) {
    out.push(
      F(
        'market-unavailable',
        'warn',
        'the market catalogue could not be read',
        `The duplicate and name-collision checks did not run, so this is NOT a clean market report. ${String(error?.message || error).slice(0, 120)}`,
        'Retry when the network is available.',
      ),
    )
    return out
  }

  const sameRepo = entries.filter((e) => typeof e?.url === 'string' && e.url.toLowerCase().includes(slug.toLowerCase()))
  if (sameRepo.length > 0) {
    out.push(
      F(
        'market-duplicate-entry',
        'warn',
        `${slug} is already in the market catalogue`,
        `Listed as "${sameRepo[0].name}" (category ${sameRepo[0].category}). A new submission PR adds a second entry for the same repo, which reviewers reject.`,
        'Update the existing entry instead of adding one — a version bump needs no PR at all.',
      ),
    )
  }
  if (pkgName) {
    const sameName = entries.filter((e) => e?.npm === pkgName && !sameRepo.includes(e))
    if (sameName.length > 0) {
      out.push(
        F(
          'market-npm-name-collision',
          'warn',
          `another catalogue entry also publishes ${pkgName}`,
          `Listed as "${sameName[0].name}" — two entries installing the same npm package confuse the install path.`,
          'Check whether one of them is stale.',
        ),
      )
    }
  }

  // The gate rejects a repo younger than a day and only reruns by itself, so
  // opening the PR earlier wastes a round trip.
  let repoInfo = opts.repoInfo ?? null
  if (!repoInfo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${slug}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'dsh-publish-gate', accept: 'application/vnd.github+json' },
      })
      if (res.ok) repoInfo = await res.json()
    } catch {
      // a blocked GitHub API only costs the age hint
    }
  }
  if (repoInfo?.created_at) {
    const created = Date.parse(repoInfo.created_at)
    if (Number.isFinite(created)) {
      const hours = (Date.now() - created) / 3_600_000
      if (hours < 24) {
        out.push(
          F(
            'market-repo-too-new',
            'warn',
            `the repo is ${hours.toFixed(1)}h old; the submission gate needs 24h`,
            'The gate fails with a "repo too new" message and reruns on its own, so the PR is not lost — but nothing merges until it passes.',
            'Wait until the repo is a day old before submitting.',
          ),
        )
      }
    }
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
  // Any call form, including destructuring and a member access: `const {a} = require(…)`,
  // `x = require(…)`, `require('node:fs').readFileSync`. Quoted literals are removed
  // first, because a tool description that *mentions* `require("react")` is prose —
  // this rule fired on this plugin's own description until that was fixed.
  const code = text
    .split('\n')
    .map(stripComment)
    .join('\n')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  if (/\brequire\s*\(\s*['"`]/.test(code)) {
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
  // Any test file counts: naming is the author's business, and demanding
  // engine.test.mjs specifically told authors to rename working tests.
  const testFiles = (() => {
    try {
      return readdirSync(testDir).filter((f) => /\.(test|spec)\.(mjs|js|cjs)$/.test(f))
    } catch {
      return []
    }
  })()
  const hasTest = testFiles.length > 0
  if (!hasTest) out.push(F('no-test-files', 'warn', 'test/ has no *.test.mjs or *.spec.mjs', 'Add at least an engine test so the rules are exercised.', 'Add test/engine.test.mjs.'))
  const pkgJson = readPkgJson(dir)
  if (!pkgJson?.scripts?.test) out.push(F('no-test-script', 'info', 'package.json has no "test" script', 'npm test does nothing, so CI and reviewers cannot run your checks.', 'Add "scripts": { "test": "node --test" }.'))
  // Node 22+ loads a positional argument to --test as a module path instead of
  // globbing it, so `node --test test/` dies with MODULE_NOT_FOUND on every run
  // while the tests themselves are fine. Auto-discovery needs no argument.
  const testScript = pkgJson?.scripts?.test || ''
  const dirArg = testScript.match(/\bnode\s+--test\s+(?!-)(\S+)/)
  if (dirArg) out.push(F('test-script-dir-arg', 'warn', `test script passes a path to node --test ("${dirArg[1]}")`, 'Node 22+ treats that argument as a module path, not a directory to glob: `node --test test/` throws MODULE_NOT_FOUND, so npm test can never pass even though the tests are fine.', 'Drop the path — "test": "node --test" auto-discovers test/**/*.test.mjs.'))
  return out
}

// =====================================================================
// Artifact truth: what npm will actually put in the tarball
// =====================================================================

/**
 * `npm pack --dry-run` is the only honest answer to "what ships?". Reading
 * `files` from package.json is a guess: npm merges it with .npmignore, adds
 * package.json/README/LICENSE whether or not you listed them, and honours
 * nested .gitignore files. Every number below comes from npm itself.
 *
 * --ignore-scripts is deliberate. A `prepack` hook (tsdown, tsc, rollup) would
 * run a real build here and overwrite hand-edited output; that case is
 * reported as `pack-script-build` instead of being silently executed.
 */
export async function checkPack(dir, opts = {}) {
  const out = []
  const warnBytes = opts.warnUnpackedBytes ?? 1_000_000
  const maxBytes = opts.maxUnpackedBytes ?? 5_000_000
  const json = readPkgJson(dir)

  let pack = null
  try {
    // On Windows npm is npm.cmd, which Node refuses to exec without a shell;
    // the command string is a fixed literal, so cmd.exe adds no injection
    // surface. Everywhere else npm is an ordinary executable.
    const isWin = process.platform === 'win32'
    const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm'
    const args = isWin ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts']
    const { stdout } = await runFile(cmd, args, {
      cwd: dir,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout)
    pack = Array.isArray(parsed) ? parsed[0] : parsed
  } catch (error) {
    out.push(
      F(
        'pack-unavailable',
        'warn',
        'npm pack --dry-run did not run',
        `The tarball check did not run, so this is NOT a clean artifact report. ${String(error?.message || error).slice(0, 140)}`,
        'Run `npm pack --dry-run` by hand in the plugin directory.',
      ),
    )
    return { findings: out, pack: null }
  }

  const files = Array.isArray(pack.files) ? pack.files : []
  const paths = files.map((f) => String(f.path))
  const has = (prefix) => paths.some((p) => p === prefix || p.startsWith(`${prefix}/`))

  if (!has('lib')) {
    out.push(
      F(
        'pack-omits-lib',
        'error',
        'the tarball contains no lib/ files',
        `npm packed ${files.length} file(s) and none are under lib/: the published plugin has no code at all.`,
        'Add "lib" to files.',
      ),
    )
  }
  if (json?.dsh?.bundle?.patch && !paths.includes(String(json.dsh.bundle.patch).replace(/^\.\//, ''))) {
    out.push(
      F(
        'pack-omits-patch',
        'error',
        `the tarball does not contain ${json.dsh.bundle.patch}`,
        'dsh.bundle.patch names a file npm did not pack, so the installed plugin has nothing to mount.',
        'Add it to files.',
      ),
    )
  }
  // The browser half can work in dev and be absent from the package: `files`
  // is usually ["lib"], so a bundle that lives anywhere else silently drops out.
  const clientRel = typeof json?.exports === 'object' && json?.exports ? json.exports['./client'] : null
  if (typeof clientRel === 'string' && !clientRel.includes('*') && !paths.includes(clientRel.replace(/^\.\//, ''))) {
    out.push(
      F(
        'pack-omits-client',
        'error',
        `the tarball does not contain ${clientRel}`,
        'exports["./client"] points at a file npm did not pack, so the installed plugin has no browser half even though it works from the checkout.',
        'Add its directory to files, or move the bundle under lib/.',
      ),
    )
  }
  if (!paths.includes('README.md')) out.push(F('pack-omits-readme', 'warn', 'the tarball has no README.md', 'npm renders it as the package page and the market reviewer reads it.', 'Add "README.md" to files.'))
  if (!paths.includes('LICENSE')) out.push(F('pack-omits-license', 'warn', 'the tarball has no LICENSE', 'npm warns on publish and consumers get an unlicensed package.', 'Add "LICENSE" to files.'))

  // A tarball that carries credentials is worse than any other finding here:
  // npm never expires them and the market mirrors the tarball.
  const SECRET = /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.netrc|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i
  const secrets = paths.filter((p) => SECRET.test(p))
  if (secrets.length > 0) {
    out.push(
      F(
        'pack-ships-secret',
        'error',
        `the tarball contains ${secrets.length} credential-shaped file(s)`,
        `${secrets.slice(0, 5).join(', ')} — npm does not expire these and the tarball is public the moment it is published. Without a "files" field npm packs everything .gitignore does not exclude.`,
        'Delete them from the package and narrow "files".',
      ),
    )
  }

  const unpacked = Number(pack.unpackedSize ?? 0)
  if (unpacked > warnBytes) {
    const biggest = [...files]
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .slice(0, 3)
      .map((f) => `${f.path} ${bytesHuman(f.size)}`)
      .join(', ')
    out.push(
      F(
        'pack-oversize',
        unpacked > maxBytes ? 'error' : 'warn',
        `the tarball unpacks to ${bytesHuman(unpacked)}`,
        `Every install downloads that. Largest: ${biggest}. Test fixtures and case data are the usual cause — they belong in the repo, not the package.`,
        'Move the data out of the package, or narrow "files".',
      ),
    )
  }

  for (const d of ['fixtures', 'test', 'tests', 'src']) {
    if (has(d)) out.push(F('pack-unexpected-dir', 'warn', `the tarball includes ${d}/`, 'A development directory is being published: it bloats the install and ships code nobody runs.', `Add "!${d}" to files if it is not meant to ship.`))
  }

  const scripts = json?.scripts || {}
  const buildHook = scripts.prepack ? 'prepack' : scripts.prepare ? 'prepare' : null
  if (buildHook) {
    out.push(
      F(
        'pack-script-build',
        'warn',
        `package.json runs "${buildHook}" on publish`,
        'This dry run used --ignore-scripts, so it describes the directory as it is now, not what a real `npm publish` would build. If the hook rewrites lib/, the published files differ from the ones you just checked.',
        'Run the build, then re-run this gate, then publish.',
      ),
    )
  }

  return { findings: out, pack }
}

// =====================================================================
// Runtime truth: does the entry load, and what does it register?
// =====================================================================

/**
 * The card kinds the host actually renders. Read out of the built-in tools in
 * the DSH bundle, every one of which returns { card: "generic", title, kind }
 * with kind in this set. A plugin that writes kind: "tool" still registers and
 * still runs — only the transcript card renders wrong, which is why nobody
 * notices until a user mentions it.
 */
export const CARD_KINDS = new Set(['other', 'execute', 'search', 'read', 'edit', 'delete', 'fetch'])

// Runs in a child process: importing a plugin executes its module body, and a
// top-level throw or an infinite loop must not take the gate down with it.
const RUNNER = `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const dir = process.argv[1]
const registered = []
// The host renders \`parameters\` into the prompt and never validates the value
// against it, so a typo like "strin" silently removes the type hint.
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
const badParamTypes = []
const walkParams = (schema, path) => {
  if (!schema || typeof schema !== 'object') return
  if (typeof schema.type === 'string' && !JSON_TYPES.has(schema.type)) badParamTypes.push(path + '.type=' + schema.type)
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, sub] of Object.entries(schema.properties)) walkParams(sub, path + '.' + key)
  }
  if (schema.items) walkParams(schema.items, path + '[]')
}
// The model only ever sends the arguments \`parameters\` declares — the host
// renders that schema into the prompt and passes nothing else. So an execute
// that reads args.dir while the schema never mentions dir is unreachable code:
// every call sees undefined, and the tool looks broken with no error anywhere.
const ARG_DOT = /\\bargs\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)/g
const ARG_INDEX = /\\bargs\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]/g
const ARG_DESTRUCTURE = /\\{\\s*([^{}]+?)\\s*\\}\\s*=\\s*args\\b/g
const undeclaredArgs = (def) => {
  const props = def?.parameters?.properties
  if (!props || typeof props !== 'object') return []
  const declared = Object.keys(props)
  if (typeof def.execute !== 'function') return []
  let src = ''
  try { src = def.execute.toString() } catch { return [] }
  const reads = []
  for (const m of src.matchAll(ARG_DOT)) reads.push(m[1])
  for (const m of src.matchAll(ARG_INDEX)) reads.push(m[1])
  for (const m of src.matchAll(ARG_DESTRUCTURE)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].split('=')[0].replace(/\\.\\.\\./, '').trim()
      if (/^[A-Za-z_$][\\w$]*$/.test(key)) reads.push(key)
    }
  }
  return [...new Set(reads)].filter((r) => !declared.includes(r))
}
const noopService = () => new Proxy(function () {}, {
  get: (target, prop) => {
    // Own properties win, or ctx.tools would resolve to another no-op proxy
    // and every registration would vanish.
    if (Reflect.has(target, prop)) return Reflect.get(target, prop)
    if (prop === 'then') return undefined
    if (prop === Symbol.toPrimitive) return () => ''
    if (prop === 'toString') return () => '[ctx]'
    return noopService()
  },
  apply: () => noopService(),
})
const ctx = noopService()
ctx.tools = {
  register: (def) => {
    let card = null
    if (def && typeof def.presentCall === 'function') {
      try {
        const c = def.presentCall({})
        card = c && typeof c.kind === 'string' ? c.kind : null
      } catch (error) {
        card = { threw: String((error && error.message) || error) }
      }
    }
    registered.push({
      name: typeof def?.name === 'string' ? def.name : null,
      hasExecute: typeof def?.execute === 'function',
      hasOutputSchema: Boolean(def && def.output && def.output.schema),
      schema: (def && def.output && def.output.schema) || null,
      parameters: (def && def.parameters) || null,
      cardKind: card,
      undeclaredParams: undeclaredArgs(def),
      run: typeof def?.execute === 'function' ? def.execute : null,
    })
    walkParams(def?.parameters, typeof def?.name === 'string' ? def.name : '(unnamed)')
  },
}
// The host validates every tool result against output.schema and throws
// ToolOutputError when it does not match — the tool is then unusable, and the
// failure names a JSON path rather than the code that produced it. This gate
// shipped exactly that bug: a permissive schema was tightened to
// additionalProperties:false while one error path still returned { ok, error }.
const validateValue = (schema, value, path) => {
  if (!schema || typeof schema !== 'object') return null
  const at = path || '$'
  if (typeof schema.type === 'string' && schema.type !== 'json') {
    const t = schema.type
    const ok = t === 'array' ? Array.isArray(value)
      : t === 'null' ? value === null
      : t === 'integer' ? Number.isInteger(value)
      : t === 'object' ? (value !== null && typeof value === 'object' && !Array.isArray(value))
      : typeof value === t
    if (!ok) return at + ' must be ' + t + ', got ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return at + ' is not one of ' + JSON.stringify(schema.enum)
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) return at + '.' + key + ' is required but missing'
    }
    if (schema.additionalProperties === false && schema.properties && typeof schema.properties === 'object') {
      const extra = Object.keys(value).filter((k) => !(k in schema.properties))
      if (extra.length) return at + ' has key(s) the schema does not declare: ' + extra.join(', ')
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (!(key in value)) continue
        const bad = validateValue(sub, value[key], at + '.' + key)
        if (bad) return bad
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const bad = validateValue(schema.items, value[i], at + '[' + i + ']')
      if (bad) return bad
    }
  }
  return null
}
const emit = (payload) => process.stdout.write('\\n@@PG@@' + JSON.stringify(payload) + '\\n')
let stage = 'import'
try {
  const mod = await import(pathToFileURL(join(dir, 'lib', 'index.js')).href)
  stage = 'apply'
  if (typeof mod.apply !== 'function') throw new Error('lib/index.js does not export apply')
  await mod.apply(ctx, {})
  // Calling a tool is opt-in: some tools launch applications or write files, so
  // the caller names the ones it considers safe. A tool that throws here is a
  // bug the author cannot see any other way - registration never runs execute.
  stage = 'call'
  const wanted = new Set(JSON.parse(process.env.PG_CALLS || '[]'))
  const budget = Number(process.env.PG_CALL_MS || 8000)
  const calls = []
  for (const entry of registered) {
    if (!wanted.has(entry.name) || !entry.run) continue
    try {
      const value = await Promise.race([
        Promise.resolve(entry.run({}, { signal: undefined })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), budget)),
      ])
      calls.push({ name: entry.name, ok: true, invalid: validateValue(entry.schema, value) })
    } catch (error) {
      const message = String((error && error.message) || error)
      // A slow tool is not a broken tool: of_env shells out to WSL and takes
      // seconds by design. Only a real throw is a defect.
      calls.push({ name: entry.name, ok: false, timedOut: message === 'timed out', error: message })
    }
  }
  // The host never validates tool input against \`parameters\`, so a number really
  // does reach a path argument. Fuzzing every declared parameter with the wrong
  // type found 12 crashes across this workspace's own plugins — each one a raw
  // TypeError handed to the caller instead of an answer.
  stage = 'fuzz'
  const fuzzIssues = []
  if (process.env.PG_FUZZ === '1') {
    const skip = new Set(JSON.parse(process.env.PG_FUZZ_SKIP || '[]'))
    const WRONG = {
      string: [123, true, { a: 1 }, [1]],
      boolean: ['yes', 1, {}],
      number: ['n', {}, []],
      array: ['x', 1, {}],
      object: ['x', 1, []],
    }
    for (const entry of registered) {
      if (!entry.run || skip.has(entry.name)) continue
      const props = entry.parameters && entry.parameters.properties
      if (!props || typeof props !== 'object') continue
      for (const [param, spec] of Object.entries(props)) {
        for (const bad of WRONG[spec && spec.type] || [123]) {
          try {
            await Promise.race([
              Promise.resolve(entry.run({ [param]: bad }, { signal: undefined })),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), budget)),
            ])
          } catch (error) {
            // Only a throw is a defect. A filter parameter that ignores a number
            // and returns the unfiltered list still answers, and every optional
            // boolean treats any truthy value the same way.
            const message = String((error && error.message) || error)
            if (message === 'timed out') continue
            fuzzIssues.push({ tool: entry.name, param, value: JSON.stringify(bad), problem: message.slice(0, 200) })
          }
        }
      }
    }
  }
  emit({ ok: true, tools: registered.map(({ run, ...rest }) => rest), badParamTypes, calls, fuzzIssues })
} catch (error) {
  emit({ ok: false, stage, error: String((error && error.message) || error) })
}
process.exit(0)
`

export async function checkToolRegistrations(dir, opts = {}) {
  const out = []
  let payload = null
  try {
    const { stdout } = await runFile(process.execPath, ['--input-type=module', '-e', RUNNER, dir], {
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PG_CALLS: JSON.stringify(Array.isArray(opts.calls) ? opts.calls : []),
        PG_CALL_MS: String(opts.callTimeoutMs ?? 8000),
        PG_FUZZ: opts.fuzz ? '1' : '0',
        PG_FUZZ_SKIP: JSON.stringify(Array.isArray(opts.fuzzSkip) ? opts.fuzzSkip : []),
      },
    })
    const line = String(stdout).split('\n').filter((l) => l.startsWith('@@PG@@')).pop()
    if (!line) throw new Error('the child printed no result')
    payload = JSON.parse(line.slice(6))
  } catch (error) {
    out.push(
      F(
        'tools-unavailable',
        'warn',
        'the isolated import did not finish',
        `The runtime check did not run, so this is NOT a clean registration report. ${String(error?.message || error).slice(0, 140)}`,
        'Load the plugin once in a profile and watch for a bundle error.',
      ),
    )
    return { findings: out, tools: null }
  }

  if (!payload.ok) {
    out.push(
      F(
        payload.stage === 'import' ? 'entry-import-failed' : 'apply-threw',
        'error',
        payload.stage === 'import' ? 'lib/index.js throws when imported' : 'apply(ctx) throws',
        `Stage "${payload.stage}": ${payload.error}. The plugin installs and then fails to load; the host reports it as a bundle error with none of your own diagnostics.`,
        'Fix the throw — this gate reproduces it in isolation.',
      ),
    )
    return { findings: out, tools: null }
  }

  const tools = Array.isArray(payload.tools) ? payload.tools : []
  if (tools.length === 0) {
    out.push(
      F(
        'tool-none-registered',
        'warn',
        'apply() registered no tools',
        'A plugin that registers nothing is only useful if it adds a client panel or a service. If you expected tools, ctx.tools was undefined when apply ran.',
        "Check `export const inject = ['tools']`.",
      ),
    )
  }

  const seen = new Set()
  for (const c of Array.isArray(payload.calls) ? payload.calls : []) {
    if (c.ok) {
      if (c.invalid) {
        out.push(
          F(
            'tool-output-invalid',
            'error',
            `tool "${c.name}" returns a value its own output schema rejects: ${c.invalid}`,
            'The host validates every result against output.schema and throws ToolOutputError on a mismatch. The tool is unusable from the first call, and the error names a JSON path rather than the line that produced it.',
            'Either widen the schema or change what execute returns so the two agree.',
          ),
        )
      }
      continue
    }
    if (c.timedOut) {
      out.push(
        F(
          'tool-call-slow',
          'warn',
          `tool "${c.name}" did not answer within the call budget`,
          'A slow tool is not a broken one — this may shell out or wait on a service. Reported so a hang is not mistaken for a pass, and NOT counted as a defect.',
          'Raise callTimeoutMs if the tool is legitimately slow, or check that it returns at all.',
        ),
      )
      continue
    }
    out.push(
      F(
        'tool-call-throws',
        'error',
        `tool "${c.name}" throws when called with no arguments`,
        `${c.error}. Registration never runs execute, so nothing else in this gate can see it — the consumer hits it on the first call.`,
        'Guard the missing input, or accept that the tool is unusable without arguments and say so in its description.',
      ),
    )
  }
  for (const t of tools) {
    const label = t.name || '(unnamed)'
    if (!t.name) out.push(F('tool-missing-name', 'error', 'a registered tool has no name', 'The host cannot address a tool without a name.', 'Give it a name.'))
    else if (seen.has(t.name)) out.push(F('tool-duplicate-name', 'error', `two tools are registered as "${t.name}"`, 'One registration is dropped or shadows the other, and which one wins is not something you control.', 'Rename one.'))
    else seen.add(t.name)

    if (!t.hasExecute) out.push(F('tool-missing-execute', 'error', `tool "${label}" has no execute function`, "It appears in the model's tool list and throws the moment it is called.", 'Add execute(args, exec).'))
    if (!t.hasOutputSchema) out.push(F('tool-missing-output-schema', 'warn', `tool "${label}" declares no output.schema`, 'The host validates tool output against output.schema; without one the contract is implicit and a malformed result reaches the caller.', "Add output: { schema: { type: 'json' }, render }."))
    if (t.cardKind && typeof t.cardKind === 'object') {
      out.push(F('tool-present-call-throws', 'error', `tool "${label}" presentCall() throws`, `presentCall renders the transcript card and must be total: ${t.cardKind.threw}`, 'Do not read args fields that may be absent.'))
    } else if (typeof t.cardKind === 'string' && !CARD_KINDS.has(t.cardKind)) {
      out.push(
        F(
          'tool-bad-card-kind',
          'error',
          `tool "${label}" renders card kind "${t.cardKind}", which the host does not know`,
          `The host only understands ${[...CARD_KINDS].join(', ')}. An unknown kind does not throw at registration — the card just renders wrong, which is why it survives to release.`,
          "Use kind: 'read' for a read-only tool.",
        ),
      )
    }

    // The model only sends what `parameters` declares, so a read of anything
    // else is unreachable: args.dir is undefined on every real call, and the
    // tool looks broken while nothing throws.
    for (const name of Array.isArray(t.undeclaredParams) ? t.undeclaredParams : []) {
      out.push(
        F(
          'tool-undeclared-param',
          'warn',
          `tool "${label}" reads args.${name}, which parameters never declares`,
          'The host renders parameters into the prompt and passes the model nothing else, so this value is always undefined on a real call. The code path exists and never runs.',
          `Add "${name}" to parameters.properties, or stop reading it.`,
        ),
      )
    }
  }
  const badParams = Array.isArray(payload.badParamTypes) ? payload.badParamTypes : []
  for (const where of badParams) {
    out.push(
      F(
        'tool-bad-parameter-type',
        'warn',
        `a parameters schema uses an unknown type at ${where}`,
        'The host renders parameters into the prompt and never validates a call against it, so a typo like "strin" removes the type hint with no error anywhere.',
        'Use one of string, number, integer, boolean, object, array, null.',
      ),
    )
  }
  // One finding per tool+parameter: the first wrong value is enough to prove the
  // guard is missing, and four findings for the same line is noise.
  const fuzzSeen = new Set()
  for (const issue of Array.isArray(payload.fuzzIssues) ? payload.fuzzIssues : []) {
    const key = `${issue.tool}\u0000${issue.param}`
    if (fuzzSeen.has(key)) continue
    fuzzSeen.add(key)
    out.push(
      F(
        'tool-input-throws',
        'error',
        `${issue.tool}(${issue.param}: ${issue.value}) — ${issue.problem}`,
        'The host never validates a call against parameters, so this really reaches your code with the wrong type. The caller gets a raw Node TypeError instead of an answer, and nothing in the plugin log says which tool was at fault.',
        `Guard the top of ${issue.tool}: if (typeof args.${issue.param} !== 'string') return { ok: false, error: '${issue.param} must be a string' }.`,
      ),
    )
  }
  return { findings: out, tools }
}

// =====================================================================
// Source hygiene and service wiring
// =====================================================================

export function checkLibHygiene(dir) {
  const out = []
  for (const file of walkFiles(join(dir, 'lib'), /\.(?:js|mjs|cjs)$/)) {
    const text = safeText(file)
    if (text === null) continue
    const rel = relative(dir, file).replace(/\\/g, '/')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const code = stripComment(lines[i])
      const at = `${rel}:${i + 1}`
      if (/\bconsole\.log\s*\(/.test(code)) out.push(F('lib-console-log', 'warn', `${at} calls console.log`, 'Tool output is the channel; a stray console.log lands in the host log and never reaches the model. Harmless, but it is debug residue in a published file.', 'Delete it, or use console.error if it is a real warning.'))
      if (/(?:^|[;{}\s])debugger\s*;?\s*$/.test(code)) out.push(F('lib-debugger', 'error', `${at} has a debugger statement`, 'In a published package a debugger statement stops every consumer who reaches that path.', 'Remove it.'))
      if (/(?:[A-Za-z]:[\\/]{1,2}Users[\\/]|\/Users\/)/.test(code)) out.push(F('lib-hardcoded-path', 'warn', `${at} contains an absolute path from this machine`, "It does not exist on the consumer's machine, so that code path silently fails there.", 'Resolve it from homedir() or ctx instead.'))
    }
    if (/new\s+URL\s*\([\s\S]{0,240}?\)\s*\.pathname/.test(text)) {
      out.push(
        F(
          'lib-url-pathname',
          'warn',
          `${rel} reads .pathname from a URL`,
          'pathname percent-encodes non-ASCII, so a plugin directory under a Chinese path becomes %E6%8F%92... and every path derived from it is wrong. This cost a test suite a day.',
          'Use fileURLToPath(new URL(...)) instead.',
        ),
      )
    }
  }
  return out
}

/**
 * Features that need a newer Node than the manifest promises.
 *
 * `engines.node` is only advisory — npm warns and installs anyway — so a plugin
 * that says `>=20` and uses `Object.groupBy` (21) breaks on exactly the Node it
 * advertised. Each entry is [name, regex, minimum major], newest evidence only.
 */
const NODE_FEATURES = [
  ['Object.groupBy / Map.groupBy', /\b(?:Object|Map)\.groupBy\b/, 21],
  ['Array.fromAsync', /\bArray\.fromAsync\b/, 22],
  ['Promise.withResolvers', /\bPromise\.withResolvers\b/, 22],
  ['import.meta.dirname', /\bimport\.meta\.dirname\b/, 21],
  ['Array.prototype.toSorted / toReversed / toSpliced / with', /\.(?:toSorted|toReversed|toSpliced)\(|\.with\(/, 20],
  ['structuredClone', /\bstructuredClone\s*\(/, 17],
]

/** `>=22.1.0`, `^20`, `>=18 <21` -> the first major it allows. */
const minNodeMajor = (range) => {
  if (typeof range !== 'string') return null
  const m = /(\d+)/.exec(range)
  return m ? Number(m[1]) : null
}

export function checkNodeVersion(dir) {
  const declared = minNodeMajor(readPkgJson(dir)?.engines?.node)
  if (declared === null) return []
  const out = []
  const seen = new Set()
  for (const file of walkFiles(join(dir, 'lib'), /\.(?:js|mjs|cjs)$/)) {
    const text = safeText(file)
    if (text === null) continue
    // Strings are stripped first: a tool description that names a feature is
    // prose, not a call (the same false positive require-in-esm had).
    const code = text
      .split('\n')
      .map(stripComment)
      .join('\n')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    for (const [name, re, needs] of NODE_FEATURES) {
      if (needs <= declared || seen.has(name) || !re.test(code)) continue
      seen.add(name)
      out.push(
        F(
          'node-too-old',
          'warn',
          `engines.node says ${JSON.stringify(readPkgJson(dir).engines.node)} but lib/ uses ${name} (needs >=${needs})`,
          'npm only warns about engines, so it installs on the older Node and throws at import time — the consumer sees a broken plugin, not a version mismatch.',
          `Raise engines.node to >=${needs}, or stop using ${name}.`,
        ),
      )
    }
  }
  return out
}

const INJECT_HINTS = [
  ['tools', /ctx\.tools\b/],
  ['web', /ctx\.web\b/],
  ['webServer', /ctx\.webServer\b/],
  ['timer', /ctx\.(?:setInterval|setTimeout|clearInterval|clearTimeout)\b/],
]

export function checkInjectCoverage(dir) {
  const out = []
  const text = safeText(join(dir, 'lib', 'index.js'))
  if (text === null) return out
  const code = text.split('\n').map(stripComment).join('\n')
  const declared = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(code)
  if (!declared) return out // checkEntrySource already reports a missing inject
  const names = new Set([...declared[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]))
  for (const [service, re] of INJECT_HINTS) {
    if (!re.test(code) || names.has(service)) continue
    out.push(
      F(
        `inject-missing-${service}`,
        'error',
        `lib/index.js uses ctx.${service} but does not inject "${service}"`,
        'cordis resolves injected services before apply runs. Without the inject entry the property may still be undefined at that moment, so the plugin throws or silently registers nothing — and it works on your machine only if another plugin happened to pull the service in first.',
        `Add "${service}" to export const inject.`,
      ),
    )
  }

  // The other direction. cordis waits for every declared service before apply
  // runs, so a misspelled entry ('tool' for 'tools') leaves the plugin pending
  // forever with no error at all — the tools simply never appear. Scan every
  // lib file, so a service used from a helper still counts as used.
  const all = walkFiles(join(dir, 'lib'), /\.(?:js|mjs|cjs)$/)
    .map((f) => safeText(f))
    .filter((t) => t !== null)
    .map((t) => t.split('\n').map(stripComment).join('\n'))
    .join('\n')
  for (const name of names) {
    const usage = INJECT_HINTS.find(([service]) => service === name)?.[1] ?? new RegExp(`ctx\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (usage.test(all)) continue
    out.push(
      F(
        'inject-unused-service',
        'warn',
        `inject declares "${name}" but no lib file uses ctx.${name}`,
        'cordis resolves every injected service before apply runs. A misspelled or leftover entry keeps the plugin pending forever without an error message — the tools just never appear, and the plugin looks installed.',
        `Fix the spelling, or remove "${name}" from inject.`,
      ),
    )
  }
  return out
}

// =====================================================================
// The browser half. It is the half that fails silently: the host half keeps
// working, so a panel that never registers looks like a UI bug.
// =====================================================================

const clientTarget = (json) => (typeof json?.exports === 'object' && json?.exports ? json.exports['./client'] : null)

export function checkClientHalf(dir) {
  const out = []
  const json = readPkgJson(dir)
  const target = clientTarget(json)
  if (typeof target !== 'string') return out // client-without-export covers the other direction
  const file = join(dir, target.replace(/^\.\//, ''))
  if (!existsSync(file)) {
    out.push(
      F(
        'client-file-missing',
        'error',
        `exports["./client"] points at ${target}, which does not exist`,
        'The host asks for the client bundle, gets MODULE_NOT_FOUND, and the panel never appears — while the host half keeps working, so nothing looks broken.',
        `Ship ${target}.`,
      ),
    )
    return out
  }
  const text = safeText(file)
  if (text === null) return out
  const code = text.split('\n').map(stripComment).join('\n')
  if (!/__ModuleLoader__/.test(code)) {
    out.push(
      F(
        'client-no-module-loader',
        'error',
        `${target} never calls window.__ModuleLoader__.load()`,
        'The host evaluates the bundle and looks for a factory registered through __ModuleLoader__. A bundle that never registers one is loaded and discarded: no error, no panel.',
        'Wrap the module in window.__ModuleLoader__.load({ id, factory }).',
      ),
    )
  }
  return out
}

// Evaluates the bundle in a child process: fake window, fake module loader,
// fake React, fake ctx. Answers the question the source cannot: does apply()
// actually register anything, and does it touch a service it forgot to inject?
const CLIENT_RUNNER = `
const { readFileSync } = await import('node:fs')
// With -e, the extra argument lands at argv[1]; there is no script path.
const file = process.argv[2] || process.argv[1]
const records = { loaded: 0, id: null, parseError: null, evalError: null, factoryError: null, hasApply: false, inject: null, applyError: null, registrations: [], services: [] }
const noop = () => {}
const serviceProxy = (name) => new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined
    if (prop === 'inject') return (_slot, fn) => { try { return fn() } catch (e) { records.applyError = records.applyError || String(e && e.message || e); return noop } }
    return () => { records.registrations.push(name + '.' + String(prop)); return noop }
  },
})
const fakeCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined
    if (prop === 'effect') return (fn) => { try { return fn() } catch (e) { records.applyError = records.applyError || String(e && e.message || e); return noop } }
    if (prop === 'on' || prop === 'emit' || prop === 'off') return noop
    records.services.push(String(prop))
    return serviceProxy(String(prop))
  },
})
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      records.loaded += 1
      records.id = spec && spec.id
      if (typeof spec?.factory !== 'function') { records.factoryError = 'factory is not a function'; return }
      const fakeRequire = (name) => {
        if (name === 'react') {
          return { createElement: () => null, useState: (v) => [v, noop], useEffect: noop, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }), Fragment: 'fragment' }
        }
        return new Proxy({}, { get: () => noop })
      }
      let mod
      try { mod = spec.factory(fakeRequire) } catch (e) { records.factoryError = String(e && e.message || e); return }
      records.hasApply = typeof mod?.apply === 'function'
      records.inject = Array.isArray(mod?.inject) ? mod.inject : null
      if (!records.hasApply) return
      try { mod.apply(fakeCtx) } catch (e) { records.applyError = String(e && e.message || e) }
    },
  },
}
globalThis.fetch = () => Promise.reject(new Error('stubbed by publish-gate'))
const stub = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub })
// Node already defines some of these as getter-only (navigator), so a plain
// assignment throws and would abort the whole probe.
for (const name of ['document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']) {
  try { globalThis[name] = stub } catch { try { Object.defineProperty(globalThis, name, { value: stub, configurable: true, writable: true }) } catch {} }
}
let source = ''
try { source = readFileSync(file, 'utf8') } catch (e) { records.parseError = 'unreadable: ' + String(e && e.message || e) }
if (!records.parseError) {
  try { new Function(source)() } catch (e) {
    const text = String(e && e.message || e)
    if (e && e.name === 'SyntaxError') records.parseError = text
    else records.evalError = text
  }
}
process.stdout.write('\\n@@PG@@' + JSON.stringify(records))
process.exit(0)
`

export async function checkClientRuntime(dir, opts = {}) {
  const out = []
  const json = readPkgJson(dir)
  const target = clientTarget(json)
  if (typeof target !== 'string') return { findings: out, client: null }
  const file = join(dir, target.replace(/^\.\//, ''))
  if (!existsSync(file)) return { findings: out, client: null } // checkClientHalf names it
  const timeoutMs = opts.timeoutMs || 20000

  let stdout
  try {
    ;({ stdout } = await runFile(process.execPath, ['--input-type=module', '-e', CLIENT_RUNNER, file], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }))
  } catch (error) {
    // execFile's own message is the whole command line; stderr has the reason.
    const why = String(error.stderr || error.message || error).trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)
    out.push(
      F(
        'client-unavailable',
        'warn',
        'the client bundle could not be evaluated',
        `${why} — the runtime layer did not run, so treat this bundle as unverified.`,
        'Check that the file parses as a classic script, or pass skipClient.',
      ),
    )
    return { findings: out, client: null }
  }
  const m = /@@PG@@(.*)$/m.exec(stdout)
  if (!m) {
    out.push(F('client-unavailable', 'warn', 'the client probe produced no result', 'The child process exited without reporting — the bundle may call process.exit() or loop forever.', 'Run the bundle by hand, or pass skipClient.'))
    return { findings: out, client: null }
  }
  const r = JSON.parse(m[1])

  if (r.parseError) {
    out.push(F('client-parse-failed', 'error', `${target} does not parse: ${String(r.parseError).slice(0, 160)}`, 'The host evaluates this file as a classic script. A syntax error there means the whole client half never runs.', 'Fix the syntax error.'))
    return { findings: out, client: r }
  }
  if (r.loaded === 0) {
    out.push(
      F(
        'client-load-not-called',
        'error',
        `${target} ran without calling window.__ModuleLoader__.load()`,
        'Nothing was registered with the module loader, so the host has no factory to call: the bundle is loaded and discarded with no error and no panel.',
        'Register through window.__ModuleLoader__.load({ id, factory }) unconditionally.',
      ),
    )
  }
  if (r.factoryError) {
    out.push(F('client-factory-throws', 'error', `the factory in ${target} throws: ${String(r.factoryError).slice(0, 160)}`, 'The host calls the factory to get the module. A throw here aborts the panel and can leave the surrounding UI pending.', 'Fix the throw, or move the work into apply().'))
  }
  if (r.loaded > 0 && !r.hasApply && !r.factoryError) {
    out.push(F('client-no-apply', 'error', `the factory in ${target} returns no apply()`, 'The host calls module.apply(ctx) to let the panel register itself. Without it the factory result is inert.', 'Return { apply, inject } from the factory.'))
  }
  if (r.applyError) {
    out.push(F('client-apply-throws', 'error', `apply() in ${target} throws: ${String(r.applyError).slice(0, 160)}`, 'Registration happens inside apply(); a throw there leaves the panel unregistered while the host half keeps working.', 'Wrap the failing registration, or fix the cause.'))
  }
  if (r.hasApply && !r.applyError && r.registrations.length === 0) {
    out.push(
      F(
        'client-no-registration',
        'warn',
        `apply() in ${target} registered nothing`,
        'apply() ran and touched no slot or tab registration. The panel is loaded, mounted nowhere, and there is no error to find.',
        'Call ctx.slots.inject(...) / ctx.<tab>.register(...) inside apply().',
      ),
    )
  }
  if (Array.isArray(r.inject)) {
    const declared = new Set(r.inject)
    const used = new Set(r.services.filter((s) => s !== 'effect'))
    for (const service of used) {
      if (declared.has(service)) continue
      out.push(
        F(
          `client-inject-missing-${service}`,
          'warn',
          `apply() in ${target} uses ctx.${service} but inject does not list it`,
          'The client loader resolves injected services before calling apply. Without the entry the property can be undefined at that moment, so the registration throws or silently does nothing.',
          `Add "${service}" to the inject array the factory returns.`,
        ),
      )
    }
  }
  return { findings: out, client: r }
}

export function checkReadmeTruth(dir, toolNames = null) {
  const out = []
  const text = safeText(join(dir, 'README.md'))
  if (text === null) return out

  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const missing = toolNames.filter((n) => n && !text.includes(n))
    if (missing.length > 0) {
      out.push(
        F(
          'readme-tool-undocumented',
          'warn',
          `README does not name ${missing.length} registered tool(s)`,
          `Registered but never mentioned: ${missing.join(', ')}. A reader cannot discover them, and the market reviewer reads the README, not the source.`,
          'Add them to the tool table.',
        ),
      )
    }
  }

  // The boundary belongs to the English form only: a Chinese character is not
  // a word character, so `单测\b` never matches and "27 个单测。" was invisible.
  const claimed = /(\d+)\s*(?:个单测|unit tests|tests\b)/.exec(text)
  if (claimed) {
    const actual = countTests(dir)
    if (actual > 0 && Number(claimed[1]) !== actual) {
      out.push(F('readme-test-count', 'info', `README claims ${claimed[1]} tests but test/ defines ${actual}`, 'A stale count is the first thing a careful reader checks, and being wrong there makes them distrust everything else.', `Update the README to ${actual}.`))
    }
  }
  return out
}

function countTests(dir) {
  let n = 0
  for (const file of walkFiles(join(dir, 'test'), /\.(?:test|spec)\.(?:mjs|js|cjs)$/)) {
    const text = safeText(file)
    if (!text) continue
    n += (text.match(/^\s*(?:test|it)\s*\(/gm) || []).length
  }
  return n
}

// =====================================================================
// Post-publish: is the tarball on the registry the one you gated?
// =====================================================================

/**
 * `npm pack --dry-run` and the registry's dist.shasum are directly
 * comparable — verified against a real publish. So "did the thing I checked
 * actually ship?" is an exact comparison, not a version-number guess.
 */
export async function checkPublishedMatches(name, version, localPack, { registry = 'https://registry.npmjs.org', timeoutMs = 8000 } = {}) {
  const out = []
  if (!name || !version) return out

  let json = null
  try {
    const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return [F('publish-not-served', 'warn', `${name} is not on the registry`, 'Nothing has been published under this name yet.', 'npm publish --access public')]
    if (!res.ok) return out // unreachable is unknown, not a failure
    json = await res.json()
  } catch {
    return out
  }

  const dist = json?.versions?.[version]?.dist
  if (!dist) {
    return [F('publish-not-served', 'warn', `${name}@${version} is not on the registry`, `The live latest is ${json?.['dist-tags']?.latest ?? 'unknown'}. Either it was never published, or the registry has not finished processing it (a 202 then a 404 for a minute or two is normal).`, 'npm publish --access public')]
  }

  if (localPack?.shasum && dist.shasum && localPack.shasum !== dist.shasum) {
    out.push(
      F(
        'publish-served-mismatch',
        'error',
        `${name}@${version} is published, but its tarball is not this directory`,
        `registry shasum ${dist.shasum} (${bytesHuman(dist.unpackedSize)}, ${dist.fileCount} files) vs local ${localPack.shasum} (${bytesHuman(localPack.unpackedSize)}, ${(localPack.files || []).length} files). The version number is spent: npm will not let you overwrite it, and every install gets the older bytes.`,
        `Bump to ${bumpPatch(version)} and publish again.`,
      ),
    )
  } else {
    out.push(F('publish-served', 'info', `${name}@${version} on the registry matches this directory`, `shasum ${dist.shasum}, ${bytesHuman(dist.unpackedSize)}, ${dist.fileCount} files — the tarball you gated is the one that shipped.`, null))
  }
  return out
}

/**
 * Poll the registry until the published bytes show up.
 *
 * npm answers 202 and keeps the version invisible for 60–180 s, so a single
 * shot right after `npm publish` reports "not on the registry" for a release
 * that already succeeded — the most common false alarm this plugin produces,
 * including on its own publishes. `probe` is injectable so the loop tests
 * without the network.
 */
export async function waitForPublished(name, version, localPack, opts = {}) {
  const waitMs = Math.max(0, Number(opts.waitMs) || 0)
  const intervalMs = Math.max(1000, Number(opts.intervalMs) || 10_000)
  const probe = opts.probe || ((o) => checkPublishedMatches(name, version, localPack, o))
  const net = { registry: opts.registry, timeoutMs: opts.timeoutMs }
  const started = Date.now()
  let findings = await probe(net)
  while (!findings.some((f) => f.rule === 'publish-served') && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, waitMs - (Date.now() - started))))
    findings = await probe(net)
  }
  return { findings, waitedMs: Date.now() - started }
}

/** The async half of the gate: everything that needs a subprocess or the network. */
export async function runArtifactChecks(dir, opts = {}) {
  const packResult = opts.skipPack ? { findings: [], pack: null } : await checkPack(dir, opts)
  const toolResult = opts.skipTools ? { findings: [], tools: null } : await checkToolRegistrations(dir, opts)
  const clientResult = opts.skipClient ? { findings: [], client: null } : await checkClientRuntime(dir, opts)
  const names = toolResult.tools ? toolResult.tools.map((t) => t.name).filter(Boolean) : null
  const trace = await checkTraceability(dir, {
    packFiles: packResult.pack?.files?.map((f) => f.path) || [],
    ...opts,
  })
  return {
    findings: [...packResult.findings, ...toolResult.findings, ...clientResult.findings, ...checkReadmeTruth(dir, names), ...trace],
    pack: packResult.pack,
    tools: toolResult.tools,
    client: clientResult.client,
  }
}

// =====================================================================
// Dependency truth
// =====================================================================

// A package specifier never contains whitespace, so the capture is whitespace-
// excluding on purpose: a greedy [^'"]+ matched across a whole template block
// and reported the runner's own source as a dependency name.
const SPECIFIER_RE =
  /\b(?:import|export)\s[^'"]*?from\s*['"]([^'"\s]+)['"]|\bimport\s*\(\s*['"]([^'"\s]+)['"]\s*\)|\bimport\s*['"]([^'"\s]+)['"]|\brequire\s*\(\s*['"]([^'"\s]+)['"]\s*\)/g

const BUILTINS = new Set(builtinModules)

// The client half runs inside the host's module loader, which resolves these
// itself (CLIENT_RUNNER's fakeRequire mirrors it). They are provided, not
// installed by the plugin, so importing them is not a missing dependency.
const HOST_PROVIDED = new Set(['react', 'react-dom'])

/** '@scope/pkg/sub' -> '@scope/pkg', 'pkg/sub' -> 'pkg', relative/builtin -> null. */
export const packageOf = (spec) => {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0]
  return name && !BUILTINS.has(name) ? name : null
}

// A tool description that says `require("react")` is prose, not an import — this
// rule fired on this plugin's own description until it was dropped. Only quoted
// strings that CONTAIN a call are removed, so a real specifier survives.
const dropProse = (code) =>
  code
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (s) => (/\b(?:require|import)\s*\(/.test(s) ? "''" : s))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => (/\b(?:require|import)\s*\(/.test(s) ? '""' : s))

/**
 * Every bare specifier lib/ imports, checked against what package.json declares.
 *
 * A published package installs its own `dependencies` — devDependencies are never
 * fetched by whoever installs the tarball. So an import that only devDependencies
 * satisfies works in your repo (where everything is installed) and throws
 * ERR_MODULE_NOT_FOUND in theirs, after they have already installed you.
 */
export function checkDependencies(dir) {
  const out = []
  const json = readPkgJson(dir)
  if (!json) return out
  const deps = new Set(Object.keys(json.dependencies || {}))
  const dev = new Set(Object.keys(json.devDependencies || {}))
  const provided = new Set([
    ...Object.keys(json.peerDependencies || {}),
    ...Object.keys(json.optionalDependencies || {}),
  ])

  const used = new Map() // package name -> the first lib/ file that imports it
  const clientRel = clientTarget(json)
  const isClientFile = (file) =>
    Boolean(clientRel) && relative(dir, file).replace(/\\/g, '/') === String(clientRel).replace(/^\.\//, '')
  for (const file of walkFiles(join(dir, 'lib'), /\.(?:js|mjs|cjs)$/)) {
    const text = safeText(file)
    if (text === null) continue
    // Backtick strings go first: a runner template literal embeds code that
    // contains the word `import`, and a greedy specifier match used to swallow
    // a whole block of it. A real specifier is always a plain quoted string.
    const code = dropProse(text.split('\n').map(stripComment).join('\n').replace(/`(?:[^`\\]|\\.)*`/g, '``'))
    for (const m of code.matchAll(SPECIFIER_RE)) {
      const name = packageOf(m[1] ?? m[2] ?? m[3] ?? m[4])
      if (!name) continue
      if (isClientFile(file) && HOST_PROVIDED.has(name)) continue
      if (!used.has(name)) used.set(name, relative(dir, file))
    }
  }

  for (const [name, file] of used) {
    if (deps.has(name) || provided.has(name)) continue
    if (dev.has(name)) {
      out.push(
        F(
          'dep-in-dev-only',
          'error',
          `${file} imports "${name}", which is only in devDependencies`,
          'npm installs a package\'s dependencies for the consumer, never its devDependencies. The import resolves on your machine and fails with ERR_MODULE_NOT_FOUND on theirs — the plugin installs fine and then does not load.',
          `Move "${name}" into dependencies.`,
        ),
      )
      continue
    }
    out.push(
      F(
        'undeclared-import',
        'error',
        `${file} imports "${name}", which package.json does not declare`,
        'It resolves locally only because some other package happens to hoist it into node_modules. The consumer has no such package, so the import fails at load time.',
        `Add "${name}" to dependencies (or drop the import).`,
      ),
    )
  }

  for (const name of deps) {
    if (used.has(name)) continue
    out.push(
      F(
        'unused-dependency',
        'info',
        `dependencies lists "${name}" but lib/ never imports it`,
        'Every consumer downloads and installs it for nothing. Sometimes that is deliberate (a peer you only load dynamically), which is why this is a note rather than a defect.',
        `Remove "${name}", or ignore this line if it is loaded at runtime only.`,
      ),
    )
  }
  return out
}

// =====================================================================
// Traceability: can you point at the exact bytes you are publishing?
// =====================================================================

const gitOut = async (dir, args) => {
  try {
    const { stdout } = await runFile('git', ['-C', dir, ...args], { timeout: 8000, windowsHide: true })
    return String(stdout).trim()
  } catch {
    return null
  }
}

/**
 * Publishing is the one moment where the bytes leave your machine. If they are
 * not in a commit and not under a tag, then a week later nobody — including you —
 * can say which source produced the live tarball. This really happened: a 1.2.7
 * went to npm while the repo's release still said 1.2.6, and the marketplace
 * entry pointed at the old tarball.
 *
 * `status` / `atHead` / `tagExists` inject the git answers so the rules are
 * testable without a repository.
 */
export async function checkTraceability(dir, opts = {}) {
  const out = []
  const json = readPkgJson(dir)
  const version = typeof opts.version === 'string' ? opts.version : json?.version
  if (!version) return out

  const inside = opts.inside ?? (opts.status === undefined ? await gitOut(dir, ['rev-parse', '--is-inside-work-tree']) : 'true')
  if (inside !== 'true') return out // checkGitState already reported no-git

  // 1. Dirty tree: the tarball carries bytes that exist in no commit.
  const status = opts.status === undefined ? await gitOut(dir, ['status', '--porcelain']) : opts.status
  if (typeof status === 'string') {
    const packed = new Set((opts.packFiles || []).map((p) => String(p).replace(/\\/g, '/')))
    const dirty = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop().trim() : p))
      .filter(Boolean)
    // Without a tarball listing, lib/ is the honest proxy: that is the code.
    const relevant = packed.size ? dirty.filter((p) => packed.has(p)) : dirty.filter((p) => p.startsWith('lib/'))
    if (relevant.length) {
      out.push(
        F(
          'git-uncommitted',
          'warn',
          `${relevant.length} file(s) going into the tarball are not committed`,
          `The published bytes exist in no commit, so they can never be reproduced or bisected later. First: ${relevant.slice(0, 3).join(', ')}.`,
          'Commit (or stash) them before publishing.',
        ),
      )
    }
  }

  // 2. No tag on HEAD: nothing points at these bytes afterwards.
  const atHead = opts.atHead === undefined ? await gitOut(dir, ['tag', '--points-at', 'HEAD']) : opts.atHead
  const tags = typeof atHead === 'string' ? atHead.split('\n').map((t) => t.trim()).filter(Boolean) : []
  const wanted = [`v${version}`, version]
  if (typeof atHead === 'string' && !wanted.some((t) => tags.includes(t))) {
    const exists = opts.tagExists === undefined ? await gitOut(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`]) : opts.tagExists ? 'sha' : null
    out.push(
      exists
        ? F(
            'git-tag-elsewhere',
            'warn',
            `tag v${version} exists but does not point at HEAD`,
            'The tag and the tarball are different bytes. A release built from that tag would not be what you just published.',
            `Move it: git tag -f v${version} && git push -f origin v${version}`,
          )
        : F(
            'git-tag-missing',
            'warn',
            `no git tag v${version} on HEAD`,
            'After publishing, the only record of these bytes is the registry. A GitHub release, a changelog entry or a market listing cannot point at a commit that was never tagged.',
            `git tag v${version} && git push origin v${version}`,
          ),
    )
  }
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
    ...checkInjectCoverage(dir),
    ...checkClientHalf(dir),
    ...checkLibHygiene(dir),
    ...checkNodeVersion(dir),
    ...checkBuildFreshness(dir),
    ...checkDependencies(dir),
    ...checkDocs(dir),
    ...checkTests(dir),
    ...checkNpmState(dir),
    ...checkGitState(dir),
  ]
}

const RULE_ORDER = [
  'missing-file', 'unreadable', 'utf8-bom', 'json-parse', 'yaml-bom', 'invalid-name', 'invalid-version',
  'missing-field', 'not-esm', 'files-omits-lib', 'files-omits-patch', 'no-exports', 'client-without-export', 'client-without-platform',
  'entry-path-missing', 'bundle-patch-not-declared', 'no-publish-config-access', 'private-field-set', 'publish-config-registry',
  'client-file-missing', 'client-no-module-loader', 'client-parse-failed', 'client-load-not-called',
  'client-factory-throws', 'client-no-apply', 'client-apply-throws', 'client-no-registration',
  'client-inject-missing-slots', 'client-inject-missing-sidebarRightTabs', 'client-unavailable',
  'no-patch-file', 'no-insert-row', 'insert-missing-name', 'insert-name-mismatch',
  'patch-name-unresolvable', 'no-name-export', 'no-apply-export', 'no-inject', 'require-in-esm',
  'entry-import-failed', 'apply-threw', 'tools-unavailable',
  'inject-missing-tools', 'inject-missing-web', 'inject-missing-webServer', 'inject-missing-timer',
  'inject-unused-service',
  'tool-missing-name', 'tool-duplicate-name', 'tool-missing-execute', 'tool-present-call-throws',
  'tool-bad-card-kind', 'tool-missing-output-schema', 'tool-none-registered', 'tool-bad-parameter-type', 'tool-undeclared-param', 'tool-input-throws', 'tool-call-throws', 'tool-output-invalid', 'tool-call-slow',
  'lib-debugger', 'lib-console-log', 'lib-hardcoded-path', 'lib-url-pathname', 'node-too-old', 'stale-build', 'hand-edited-build',
  'undeclared-import', 'dep-in-dev-only', 'unused-dependency',
  'pack-omits-lib', 'pack-omits-patch', 'pack-omits-client', 'pack-oversize', 'pack-omits-readme', 'pack-omits-license', 'pack-ships-secret',
  'pack-unexpected-dir', 'pack-script-build', 'pack-unavailable',
  'no-license', 'license-mismatch', 'version-taken', 'version-behind-latest', 'npm-not-logged-in', 'npm-scope-mismatch', 'npm-whoami-unavailable', 'registry-unreachable', 'publish-not-served',
  'publish-served-mismatch', 'publish-served', 'market-empty', 'market-no-url', 'market-url-not-github',
  'market-no-name', 'market-name-shape', 'market-no-category', 'market-bad-category', 'market-no-desc', 'market-no-en', 'market-no-zh', 'unscoped-name', 'no-git', 'no-readme', 'readme-no-install', 'readme-no-profile', 'readme-wrong-package',
  'market-no-repo', 'market-unavailable', 'market-duplicate-entry', 'market-npm-name-collision', 'market-repo-too-new',
  'git-uncommitted', 'git-tag-missing', 'git-tag-elsewhere',
  'readme-tool-undocumented', 'readme-test-count',
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
