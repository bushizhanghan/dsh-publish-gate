import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bumpPatch,
  CARD_KINDS,
  checkBuildFreshness,
  checkClientHalf,
  checkClientRuntime,
  checkDependencies,
  entryFile,
  checkDocs,
  checkEntrySource,
  checkInjectCoverage,
  checkLibHygiene,
  checkLocalLink,
  checkMarketEntry,
  checkMarketReadiness,
  checkMountEntry,
  checkNodeVersion,
  checkBin,
  checkExportsTargets,
  checkPackageJson,
  checkMountIdCollision,
  mountIds,
  applyRelease,
  bumpVersion,
  planRelease,
  checkPack,
  diffPack,
  checkPatchYml,
  checkPublishIdentity,
  checkPublishedMatches,
  checkStoreConflict,
  checkReadmeTruth,
  checkTests,
  checkToolRegistrations,
  checkTraceability,
  checkVersionTaken,
  compareVersions,
  latestPublished,
  packageOf,
  renderReport,
  repoSlug,
  runArtifactChecks,
  checkChangelog,
  checkTestRun,
  straySeverities,
  runStaticChecks,
  waitForPublished,
} from '../lib/engine.js'

/** Build a minimal valid plugin. */
function goodPlugin(dir, overrides = {}) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@bushizhanghan/dsh-good',
        version: '1.0.0',
        description: 'A good plugin',
        main: 'lib/index.js',
        type: 'module',
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/bushizhanghan/dsh-good.git' },
        author: 'bushizhanghan',
        engines: { node: '>=22' },
        exports: { '.': './lib/index.js' },
        files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        scripts: { test: 'node --test' },
        ...overrides,
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    '# mount\n- insert:\n    - id: good\n      name: "@bushizhanghan/dsh-good"\n',
  )
  writeFileSync(
    join(dir, 'lib', 'index.js'),
    `export const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx, config = {}) {\n  ctx.tools.register({\n    name: 'good_x',\n    description: 'Reads a directory and returns its tool count.',\n    parameters: {},\n    output: { schema: { type: 'json' } },\n    presentCall: () => ({ card: 'generic', title: 'good_x', kind: 'read' }),\n    async execute() {},\n  })\n}\n`,
  )
  writeFileSync(
    join(dir, 'README.md'),
    '# good\n\nInstall:\n\n```sh\ndsh plugin --profile desktop add @bushizhanghan/dsh-good\n```\n\n## Tools\n\n- `good_x` — does a thing.\n',
  )
  writeFileSync(join(dir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 bushizhanghan\n')
  writeFileSync(join(dir, 'test', 'engine.test.mjs'), 'import { test } from "node:test"\ntest("x", () => {})\n')
}

test('a well-formed plugin passes the static gate clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-good-'))
  try {
    goodPlugin(dir)
    const findings = runStaticChecks(dir)
    const errors = findings.filter((f) => f.severity === 'error')
    assert.deepEqual(errors.map((f) => f.rule), [], `unexpected errors: ${JSON.stringify(errors.map((f) => f.rule))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a UTF-8 BOM is an error and never a JSON parse mystery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-bom-'))
  try {
    goodPlugin(dir)
    // simulate what PowerShell Set-Content -Encoding UTF8 produces
    const p = join(dir, 'package.json')
    const text = readFileSync(p, 'utf8')
    writeFileSync(p, '\uFEFF' + text)
    const findings = checkPackageJson(dir)
    const bom = findings.find((f) => f.rule === 'utf8-bom')
    assert.ok(bom, 'BOM must be reported')
    assert.equal(bom.severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('files omitting lib is flagged statically and blocked by the tarball check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-files-'))
  try {
    goodPlugin(dir, { files: ['README.md'] })
    const hit = checkPackageJson(dir).find((f) => f.rule === 'files-omits-lib')
    assert.ok(hit, 'the static layer names the missing directory')
    // Only the packed tarball proves the code is gone; the static layer is the
    // suspicion that sends you there, so it must not double-report an error.
    assert.equal(hit.severity, 'info')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing exports["."] is a warning, because main still resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exports-'))
  try {
    goodPlugin(dir)
    const p = join(dir, 'package.json')
    const json = JSON.parse(readFileSync(p, 'utf8'))
    delete json.exports
    writeFileSync(p, JSON.stringify(json))
    const found = checkPackageJson(dir).find((f) => f.rule === 'no-exports')
    assert.equal(found?.severity, 'warn')
    assert.doesNotMatch(String(found?.detail), /silently does not load/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a top-level "- id:" pair is caught as a patch that never mounts', () => {  const dir = mkdtempSync(join(tmpdir(), 'gate-indent-'))
  try {
    goodPlugin(dir)
    // exactly what I wrote for page-monitor and weapp-loop: a top-level
    // "- id:" + "name:" pair instead of children of "- insert:"
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '# comment\n- id: page-monitor\n  name: "@bushizhanghan/dsh-page-monitor"\n',
    )
    const findings = checkPatchYml(dir)
    const bad = findings.find((f) => f.rule === 'no-insert-row')
    assert.ok(bad, 'a patch with only override rows must be reported')
    assert.equal(bad.severity, 'error')
    // the detail must say WHY it is not a mount, or the reader just indents it
    assert.match(bad.detail, /patch entries that already exist in the tree/)
    // and the old false positive must be gone: a patch row is legal, not a
    // mis-indented insert whose "fix" would duplicate an existing id
    assert.ok(!findings.some((f) => f.rule === 'insert-wrong-indent'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a correct insert block produces no findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-insert-ok-'))
  try {
    goodPlugin(dir)
    const findings = checkPatchYml(dir).filter((f) => f.rule.startsWith('insert'))
    assert.deepEqual(findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an insert name that does not match package.json is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-mismatch-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- insert:\n    - id: good\n      name: "@someone/dsh-other"\n',
    )
    assert.ok(checkPatchYml(dir).some((f) => f.rule === 'insert-name-mismatch' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('require() inside an ESM entry is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-require-'))
  try {
    goodPlugin(dir)
    writeFileSync(join(dir, 'lib', 'index.js'), `const fs = require('node:fs')\nexport const name = 'good'\nexport function apply() {}\n`)
    const findings = checkEntrySource(dir)
    assert.ok(findings.some((f) => f.rule === 'require-in-esm' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('require() is caught in every call form, not just `const x =`', () => {
  for (const line of [
    `const { readFileSync } = require('node:fs')`,
    `let fs\nfs = require('node:fs')`,
    `const text = require('node:fs').readFileSync('x', 'utf8')`,
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-require2-'))
    try {
      goodPlugin(dir)
      writeFileSync(join(dir, 'lib', 'index.js'), `${line}\nexport const name = 'good'\nexport function apply() {}\n`)
      const rules = checkEntrySource(dir).map((f) => f.rule)
      assert.ok(rules.includes('require-in-esm'), line)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a tool description that mentions require("x") is prose, not a call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-require-prose-'))
  try {
    goodPlugin(dir)
    // this plugin fired the rule on its own description before the fix
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      `export const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx) {\n  ctx.tools.register({ name: 'good_x', description: 'a fake require("react") module', parameters: {}, output: { schema: { type: 'json' } }, async execute() {} })\n}\n`,
    )
    const rules = checkEntrySource(dir).map((f) => f.rule)
    assert.ok(!rules.includes('require-in-esm'), 'a quoted mention must not be read as a call')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing name/apply exports are errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exports2-'))
  try {
    goodPlugin(dir)
    writeFileSync(join(dir, 'lib', 'index.js'), `export function apply() {}\n`)
    const rules = checkEntrySource(dir).map((f) => f.rule)
    assert.ok(rules.includes('no-name-export'))
    writeFileSync(join(dir, 'lib', 'index.js'), `export const name = 'x'\n`)
    assert.ok(checkEntrySource(dir).some((f) => f.rule === 'no-apply-export'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unscoped name warns about the 403 nobody can diagnose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-unscoped-'))
  try {
    goodPlugin(dir, { name: 'dsh-bare-name' })
    const findings = runStaticChecks(dir)
    const u = findings.find((f) => f.rule === 'unscoped-name')
    assert.ok(u)
    assert.match(u.detail, /403/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing LICENSE and README install line are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-docs-'))
  try {
    goodPlugin(dir)
    rmSync(join(dir, 'LICENSE'))
    writeFileSync(join(dir, 'README.md'), '# good\n\nNo install instructions here.\n')
    const rules = checkDocs(dir).map((f) => f.rule)
    assert.ok(rules.includes('no-license'))
    assert.ok(rules.includes('readme-no-install'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing tests are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tests-'))
  try {
    goodPlugin(dir)
    rmSync(join(dir, 'test'), { recursive: true, force: true })
    assert.ok(checkTests(dir).some((f) => f.rule === 'no-tests'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a test script that passes a path to node --test is flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-testscript-'))
  try {
    // the shape that ships and silently fails on Node 22+
    goodPlugin(dir, { scripts: { test: 'node --test test/' } })
    const rules = checkTests(dir).map((f) => f.rule)
    assert.ok(rules.includes('test-script-dir-arg'), `expected the rule, got ${JSON.stringify(rules)}`)
    // auto-discovery is the correct shape and must stay quiet
    goodPlugin(dir, { scripts: { test: 'node --test' } })
    assert.ok(!checkTests(dir).some((f) => f.rule === 'test-script-dir-arg'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bumpPatch does what it says', () => {
  assert.equal(bumpPatch('0.1.0'), '0.1.1')
  assert.equal(bumpPatch('1.2.3-rc.1'), '1.2.4')
})

test('market entry validation catches the shape errors', () => {
  const good = `url: https://github.com/bushizhanghan/dsh-good\nname: bushizhanghan/dsh-good\ncategory: dev\ndescription:\n  en: 'Does a thing.'\n  zh: 做一件事。\n`
  assert.deepEqual(checkMarketEntry(good).filter((f) => f.severity === 'error'), [])

  const bad = `name: dsh-good\ncategory: nonsense\ndescription:\n  en: 'Only english.'\n`
  const rules = checkMarketEntry(bad).map((f) => f.rule)
  assert.ok(rules.includes('market-no-url'))
  assert.ok(rules.includes('market-name-shape'))
  assert.ok(rules.includes('market-bad-category'))
  assert.ok(rules.includes('market-no-zh'))
})

test('renderReport counts blockers and lists fixes', () => {
  const text = renderReport([
    { rule: 'no-license', severity: 'error', title: 't', detail: 'd', fix: 'do x' },
    { rule: 'no-readme', severity: 'warn', title: 't2', detail: 'd2', fix: null },
  ])
  assert.match(text, /1 blocker/)
  assert.match(text, /✗ t/)
  assert.match(text, /! t2/)
  assert.match(text, /fix do x/)
  assert.match(renderReport([]), /no blockers/)
})

// ---- the real test: the sibling plugin checkouts in this workspace ----
// Resolved from this file's own location, so moving the whole workspace is
// harmless. `new URL().pathname` is not used: it percent-encodes the Chinese
// directory name and every fixture read then fails with ENOENT.
import { fileURLToPath } from 'node:url'
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')
const WORKSPACE = HERE.replace(/\/dsh-publish-gate\/test\/?$/, '')
const MY_PLUGINS = [
  'dsh-page-monitor',
  'dsh-weapp-loop',
  'dsh-profile-doctor',
  'dsh-openfoam-doctor',
  'dsh-publish-gate',
  'dsh-compaction-audit',
  'dsh-context-budget',
  'dsh-routing-forensics',
  'dsh-workspace-switch-cost',
].map((n) => `${WORKSPACE}/${n}`)
// On a fresh clone these directories do not exist; a test that walks them has
// nothing to say and must skip rather than report the machine as broken.
const MY_PLUGINS_PRESENT = () => MY_PLUGINS.filter((dir) => existsSync(join(dir, 'package.json')))

test('the four published plugins pass the static gate (no blockers)', (ctx) => {
  const dirs = MY_PLUGINS_PRESENT()
  if (dirs.length === 0) {
    ctx.skip('needs sibling plugin checkouts next to this repository')
    return
  }
  for (const dir of dirs) {
    const findings = runStaticChecks(dir)
    const errors = findings.filter((f) => f.severity === 'error')
    assert.deepEqual(
      errors.map((f) => `${f.rule}: ${f.title}`),
      [],
      `${dir} still has blockers`,
    )
  }
})

test('the four published plugins have no patch or entry-structure findings', (ctx) => {
  const dirs = MY_PLUGINS_PRESENT()
  if (dirs.length === 0) {
    ctx.skip('needs sibling plugin checkouts')
    return
  }
  for (const dir of dirs) {
    const rules = runStaticChecks(dir).map((f) => f.rule)
    for (const forbidden of ['insert-wrong-indent', 'insert-missing-name', 'insert-name-mismatch', 'no-insert-row', 'patch-not-mount', 'no-name-export', 'no-apply-export', 'require-in-esm', 'utf8-bom']) {
      assert.ok(!rules.includes(forbidden), `${dir}: ${forbidden}`)
    }
  }
})

test('checkVersionTaken reports a version that is already live', async () => {
  // page-monitor 0.1.0 is published; that exact version is taken
  const findings = await checkVersionTaken('@bushizhanghan/dsh-page-monitor', '0.1.0')
  const hit = findings.find((f) => f.rule === 'version-taken')
  if (hit) {
    assert.equal(hit.severity, 'error')
    assert.match(hit.fix, /0\.1\.1/)
  }
  // a version that will never exist is not reported
  const none = await checkVersionTaken('@bushizhanghan/dsh-page-monitor', '99.99.99')
  assert.deepEqual(none, [])
})

test('checkVersionTaken says so when the registry did not answer', async () => {
  // port 1 refuses instantly: this must not read as "the version is free"
  const findings = await checkVersionTaken('@bushizhanghan/dsh-page-monitor', '0.1.0', { registry: 'http://127.0.0.1:1', timeoutMs: 1500 })
  assert.deepEqual(findings, [], 'a refused connection is silent, not a false finding')
  // a reachable registry answering 500 must warn rather than pass
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address()
    const got = await checkVersionTaken('@bushizhanghan/dsh-page-monitor', '0.1.0', { registry: `http://127.0.0.1:${port}` })
    const warn = got.find((f) => f.rule === 'registry-unreachable')
    assert.ok(warn, 'a 500 must not pass as a clean version check')
    assert.equal(warn.severity, 'warn')
  } finally {
    server.close()
  }
})

test('files entries that pack lib/ are all accepted', () => {
  for (const variant of [['lib'], ['lib/'], ['./lib'], ['lib/**/*.js'], ['lib/index.js', 'lib/engine.js']]) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-files-'))
    try {
      goodPlugin(dir, { files: [...variant, 'cordis.patch.yml'] })
      const rules = checkPackageJson(dir).map((f) => f.rule)
      assert.ok(!rules.includes('files-omits-lib'), `${JSON.stringify(variant)} must count as packing lib/`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('an exports-only package does not need main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-nomain-'))
  try {
    goodPlugin(dir)
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    delete parsed.main
    writeFileSync(join(dir, 'package.json'), JSON.stringify(parsed, null, 2))
    const findings = checkPackageJson(dir)
    assert.ok(
      !findings.some((f) => f.rule === 'missing-field' && /"main"/.test(f.title)),
      `exports["."] resolves the entry; main is optional. got ${JSON.stringify(findings.map((f) => f.title))}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('any *.test.mjs or *.spec.mjs counts as a test file', () => {
  for (const name of ['plugin.test.mjs', 'rules.spec.mjs']) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-tests-'))
    try {
      goodPlugin(dir)
      rmSync(join(dir, 'test', 'engine.test.mjs'))
      writeFileSync(join(dir, 'test', name), 'import { test } from "node:test"\ntest("x", () => {})\n')
      const rules = checkTests(dir).map((f) => f.rule)
      assert.ok(!rules.includes('no-test-files'), `${name} is a test file`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('compareVersions orders the numeric part', () => {
  assert.equal(compareVersions('0.1.4', '0.1.3'), 1)
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1)
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
})

test('latestPublished reads dist-tags and stays null when it cannot', async () => {
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ 'dist-tags': { latest: '0.1.9' }, versions: {} }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address()
    assert.equal(await latestPublished('@bushizhanghan/dsh-page-monitor', { registry: `http://127.0.0.1:${port}` }), '0.1.9')
  } finally {
    server.close()
  }
  // a registry that cannot be reached must not invent a version
  assert.equal(await latestPublished('@bushizhanghan/dsh-page-monitor', { registry: 'http://127.0.0.1:1', timeoutMs: 1500 }), null)
})

// =====================================================================
// 0.2.0 — artifact truth (npm pack) and runtime truth (a real import)
// =====================================================================

/** A plugin whose entry is exactly `source`. */
function pluginWithEntry(dir, source, overrides = {}) {
  goodPlugin(dir, overrides)
  writeFileSync(join(dir, 'lib', 'index.js'), source)
  return dir
}

const ENTRY_REGISTERS = (body) => `export const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx) {\n${body}\n}\n`

test('checkPack reads the real tarball, not the files field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-'))
  try {
    goodPlugin(dir)
    const { findings, pack } = await checkPack(dir)
    assert.ok(pack, 'npm pack must produce a manifest')
    assert.ok(pack.files.some((f) => f.path === 'lib/index.js'), `lib/index.js must be in the tarball, got ${JSON.stringify(pack.files.map((f) => f.path))}`)
    assert.deepEqual(findings.filter((f) => f.severity === 'error').map((f) => f.rule), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPack catches a tarball with no code even when package.json looks fine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-nolib-'))
  try {
    // npm force-includes whatever `main` points at, so a tarball that really
    // has no code needs no main/exports either — that is the shape where the
    // manifest looks plausible and the package is empty.
    goodPlugin(dir, { files: ['README.md'], main: undefined, exports: undefined })
    const { findings, pack } = await checkPack(dir)
    assert.ok(!pack.files.some((f) => f.path.startsWith('lib/')), 'the fixture must really pack no lib/')
    assert.ok(findings.some((f) => f.rule === 'pack-omits-lib' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPack reports an oversize tarball and names the biggest files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-big-'))
  try {
    goodPlugin(dir, { files: ['lib', 'README.md'] })
    writeFileSync(join(dir, 'lib', 'blob.js'), `export const blob = '${'x'.repeat(4000)}'\n`)
    const { findings } = await checkPack(dir, { warnUnpackedBytes: 100, maxUnpackedBytes: 200 })
    const over = findings.find((f) => f.rule === 'pack-oversize')
    assert.ok(over, 'an oversize tarball must be reported')
    assert.equal(over.severity, 'error')
    assert.match(over.detail, /blob\.js/, 'the biggest file must be named, or the author cannot act')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPack warns when a development directory ships', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-fixtures-'))
  try {
    goodPlugin(dir, { files: ['lib', 'README.md', 'fixtures'] })
    mkdirSync(join(dir, 'fixtures'), { recursive: true })
    writeFileSync(join(dir, 'fixtures', 'case.txt'), 'mesh data')
    const { findings } = await checkPack(dir)
    assert.ok(findings.some((f) => f.rule === 'pack-unexpected-dir' && /fixtures/.test(f.title)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPack says the dry run did not build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-build-'))
  try {
    goodPlugin(dir, { scripts: { test: 'node --test', prepack: 'npm run build' } })
    const hook = (await checkPack(dir)).findings.find((f) => f.rule === 'pack-script-build')
    assert.ok(hook)
    assert.match(hook.detail, /ignore-scripts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkToolRegistrations imports the entry and lists its tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-ok-'))
  try {
    goodPlugin(dir)
    const { findings, tools } = await checkToolRegistrations(dir)
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'good_x')
    assert.equal(tools[0].cardKind, 'read')
    assert.deepEqual(findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an entry that throws on import is an error, not a silent install', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-import-'))
  try {
    pluginWithEntry(dir, `throw new Error('boom at import')\nexport const name = 'good'\nexport function apply() {}\n`)
    const f = (await checkToolRegistrations(dir)).findings.find((x) => x.rule === 'entry-import-failed')
    assert.ok(f, 'a throwing import must be reported')
    assert.equal(f.severity, 'error')
    assert.match(f.detail, /boom at import/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply() that throws is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-apply-'))
  try {
    pluginWithEntry(dir, `export const name = 'good'\nexport const inject = ['tools']\nexport function apply() { throw new Error('no service') }\n`)
    const f = (await checkToolRegistrations(dir)).findings.find((x) => x.rule === 'apply-threw')
    assert.ok(f)
    assert.match(f.detail, /no service/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a card kind the host does not know is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-card-'))
  try {
    pluginWithEntry(
      dir,
      ENTRY_REGISTERS(
        `  ctx.tools.register({ name: 't', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, presentCall: () => ({ card: 'generic', title: 't', kind: 'tool' }), async execute() {} })`,
      ),
    )
    const f = (await checkToolRegistrations(dir)).findings.find((x) => x.rule === 'tool-bad-card-kind')
    assert.ok(f, 'kind: "tool" is the exact bug this rule exists for')
    assert.equal(f.severity, 'error')
    assert.match(f.detail, /read/, 'the message must list what the host accepts')
    assert.ok(CARD_KINDS.has('read'))
    assert.ok(!CARD_KINDS.has('tool'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tool with no execute, and two tools with one name, are errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-shape-'))
  try {
    pluginWithEntry(
      dir,
      ENTRY_REGISTERS(
        `  ctx.tools.register({ name: 't', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } } })\n  ctx.tools.register({ name: 't', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, async execute() {} })`,
      ),
    )
    const rules = (await checkToolRegistrations(dir)).findings.map((f) => f.rule)
    assert.ok(rules.includes('tool-missing-execute'))
    assert.ok(rules.includes('tool-duplicate-name'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('presentCall that throws is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-present-'))
  try {
    pluginWithEntry(
      dir,
      ENTRY_REGISTERS(
        `  ctx.tools.register({ name: 't', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, presentCall: (args) => ({ card: 'generic', title: args.dir.length, kind: 'read' }), async execute() {} })`,
      ),
    )
    const f = (await checkToolRegistrations(dir)).findings.find((x) => x.rule === 'tool-present-call-throws')
    assert.ok(f, 'presentCall({}) must be total')
    assert.equal(f.severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lib hygiene: console.log warns, debugger errors, a machine path warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-hygiene-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'debug.js'),
      [
        'export const a = () => console.log("hi")',
        'export function b() {',
        '  debugger',
        '}',
        'export const p = "C:/Users/1/x"',
        'export const u = new URL("file:///x").pathname',
        '// console.log("commented out is not live code")',
      ].join('\n'),
    )
    const rules = checkLibHygiene(dir).map((f) => f.rule)
    assert.ok(rules.includes('lib-console-log'))
    assert.ok(rules.includes('lib-debugger'))
    assert.ok(rules.includes('lib-hardcoded-path'))
    assert.ok(rules.includes('lib-url-pathname'))
    assert.equal(rules.filter((r) => r === 'lib-console-log').length, 1, 'the commented-out call must not be counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('using ctx.tools without injecting "tools" is a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-inject-'))
  try {
    pluginWithEntry(dir, `export const name = 'good'\nexport const inject = []\nexport function apply(ctx) { ctx.tools.register({}) }\n`)
    const f = checkInjectCoverage(dir).find((x) => x.rule === 'inject-missing-tools')
    assert.ok(f)
    // A missed inject is a real risk but not a certain break: another plugin can
    // pull the service in first, so it stays a warning.
    assert.equal(f.severity, 'warn')

    // ctx.webServer must not be mistaken for ctx.web
    pluginWithEntry(dir, `export const name = 'good'\nexport const inject = ['webServer']\nexport function apply(ctx) { ctx.webServer.register({}) }\n`)
    assert.deepEqual(checkInjectCoverage(dir), [])

    // timer services need the timer inject
    pluginWithEntry(dir, `export const name = 'good'\nexport const inject = []\nexport function apply(ctx) { ctx.setInterval(() => {}, 1000) }\n`)
    assert.ok(checkInjectCoverage(dir).some((x) => x.rule === 'inject-missing-timer'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('README truth: an undocumented tool and a stale test count are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-readme-'))
  try {
    goodPlugin(dir)
    assert.ok(checkReadmeTruth(dir, ['good_x', 'ghost_tool']).some((f) => f.rule === 'readme-tool-undocumented' && /ghost_tool/.test(f.detail)))
    assert.deepEqual(checkReadmeTruth(dir, ['good_x']).filter((f) => f.rule === 'readme-tool-undocumented'), [])
    writeFileSync(join(dir, 'README.md'), '# good\n\n27 个单测。\n')
    const stale = checkReadmeTruth(dir, null).find((f) => f.rule === 'readme-test-count')
    assert.ok(stale, 'a claimed count that differs from test/ must be reported')
    assert.equal(stale.severity, 'info')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPublishedMatches compares the published shasum with the local tarball', async () => {
  const http = await import('node:http')
  let body = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { shasum: 'aaa', unpackedSize: 10, fileCount: 2 } } } }
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const registry = `http://127.0.0.1:${server.address().port}`
  try {
    const mismatch = await checkPublishedMatches('@x/y', '1.0.0', { shasum: 'bbb', unpackedSize: 20, files: [] }, { registry })
    assert.ok(mismatch.some((f) => f.rule === 'publish-served-mismatch' && f.severity === 'error'))

    const match = await checkPublishedMatches('@x/y', '1.0.0', { shasum: 'aaa' }, { registry })
    assert.ok(match.some((f) => f.rule === 'publish-served' && f.severity === 'info'))

    body = { 'dist-tags': { latest: '0.9.0' }, versions: { '0.9.0': { dist: { shasum: 'zzz' } } } }
    const missing = await checkPublishedMatches('@x/y', '1.0.0', { shasum: 'aaa' }, { registry })
    assert.ok(missing.some((f) => f.rule === 'publish-not-served' && f.severity === 'warn'))
  } finally {
    server.close()
  }
})

test('bad-repo-url fires for the {type,url} shape too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-repo-'))
  try {
    goodPlugin(dir, { repository: { type: 'git', url: 'git+https://gitlab.com/x/y.git' } })
    assert.ok(checkPackageJson(dir).some((f) => f.rule === 'bad-repo-url'), 'the object form used to slip through')
    goodPlugin(dir, { repository: { type: 'git', url: 'git+https://github.com/x/y.git' } })
    assert.deepEqual(checkPackageJson(dir).filter((f) => f.rule === 'bad-repo-url'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runArtifactChecks composes pack + runtime + readme, and can skip each half', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-artifact-'))
  try {
    goodPlugin(dir)
    const full = await runArtifactChecks(dir)
    assert.ok(full.pack, 'the pack manifest must be returned for the publish verification')
    assert.ok(Array.isArray(full.tools) && full.tools.length === 1)
    assert.deepEqual(full.findings.filter((f) => f.severity === 'error').map((f) => f.rule), [])

    const skipped = await runArtifactChecks(dir, { skipPack: true, skipTools: true })
    assert.equal(skipped.pack, null)
    assert.equal(skipped.tools, null)
    assert.deepEqual(skipped.findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every plugin in this workspace is artifact-clean', async (ctx) => {
  const present = MY_PLUGINS.filter((dir) => existsSync(join(dir, 'package.json')))
  if (present.length === 0) {
    ctx.skip('needs sibling plugin checkouts next to this repository')
    return
  }
  for (const dir of present) {
    const { findings } = await runArtifactChecks(dir)
    const errors = findings.filter((f) => f.severity === 'error')
    assert.deepEqual(errors.map((f) => `${f.rule}: ${f.title}`), [], `${dir} still has blockers`)
  }
})

// ---------------------------------------------------------------------------
// Manifest rules added in 0.3.0
// ---------------------------------------------------------------------------

test('a patch file the manifest never declares is inert — and that is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-nobundle-'))
  try {
    goodPlugin(dir, { dsh: {} })
    const findings = checkPackageJson(dir)
    assert.ok(findings.some((f) => f.rule === 'bundle-patch-not-declared' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an entry path pointing at a missing file is an error, in both export keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-entrypath-'))
  try {
    goodPlugin(dir, { main: 'lib/nope.js', exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    const rules = checkPackageJson(dir).map((f) => f.rule)
    assert.ok(rules.includes('entry-path-missing'), 'main pointing nowhere must be caught')
    // the client file is also missing, so the same rule fires twice — both are real
    assert.equal(checkPackageJson(dir).filter((f) => f.rule === 'entry-path-missing').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scoped package without publishConfig.access is a note, not a blocker', () => {  const dir = mkdtempSync(join(tmpdir(), 'gate-access-'))
  try {
    goodPlugin(dir)
    const bare = checkPackageJson(dir).find((f) => f.rule === 'no-publish-config-access')
    assert.ok(bare)
    assert.equal(bare.severity, 'info')

    goodPlugin(dir, { publishConfig: { access: 'public' } })
    assert.equal(checkPackageJson(dir).filter((f) => f.rule === 'no-publish-config-access').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an inject entry nothing ever uses is reported — the typo that never activates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-injectunused-'))
  try {
    goodPlugin(dir)
    // 'tool' instead of 'tools': cordis waits for a service that does not exist
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      `export const name = 'good'\nexport const inject = ['tools', 'tool']\nexport function apply(ctx, config = {}) {\n  ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, async execute() {} })\n}\n`,
    )
    const unused = checkInjectCoverage(dir).filter((f) => f.rule === 'inject-unused-service')
    assert.equal(unused.length, 1)
    assert.match(unused[0].title, /"tool"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('optional chaining still counts as using a declared service', () => {
  // This package injects 'credentials' and reaches it as `ctx?.credentials` from a
  // helper; the rule used to call that unused, on the gate itself.
  const dir = mkdtempSync(join(tmpdir(), 'gate-injectopt-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      `export const name = 'good'\nexport const inject = ['tools', 'credentials']\nexport function apply(ctx, config = {}) {\n  const api = ctx?.credentials\n  if (api) api.resolve('NPM_TOKEN')\n  ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, async execute() {} })\n}\n`,
    )
    const unused = checkInjectCoverage(dir).filter((f) => f.rule === 'inject-unused-service')
    assert.deepEqual(unused.map((f) => f.title), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The browser half
// ---------------------------------------------------------------------------

/** A client bundle that does the right thing, parameterised for the failure cases. */
const goodClient = `if (window.__goodLoaded) { /* already injected once */ } else {
window.__goodLoaded = true
window.__ModuleLoader__.load({
  id: 'good',
  factory: (require) => {
    const React = require('react')
    function Panel() { return React.createElement('div', null, 'hi') }
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'good', title: () => 'good' }))
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'good' }, Panel)))
    }
    return { apply, inject: ['slots', 'sidebarRightTabs'] }
  },
})
}`

test('the client half: a working bundle is clean and really registers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-ok-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), goodClient)
    assert.deepEqual(checkClientHalf(dir).map((f) => f.rule), [])
    const { findings, client } = await checkClientRuntime(dir)
    assert.deepEqual(findings.map((f) => f.rule), [])
    assert.equal(client.loaded, 1)
    assert.equal(client.hasApply, true)
    assert.ok(client.registrations.includes('sidebarRightTabs.register'))
    assert.ok(client.registrations.includes('slots.register'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a declared bundle that is not there is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-missing-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    assert.ok(checkClientHalf(dir).some((f) => f.rule === 'client-file-missing' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a bundle that never touches __ModuleLoader__ is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-loader-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), 'export const apply = () => {}\n')
    assert.ok(checkClientHalf(dir).some((f) => f.rule === 'client-no-module-loader' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a bundle that registers nothing is caught at runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-noop-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), 'const x = 1\n')
    const { findings, client } = await checkClientRuntime(dir)
    assert.equal(client.loaded, 0)
    assert.ok(findings.some((f) => f.rule === 'client-load-not-called' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a factory that throws, returns no apply, or whose apply throws', async () => {
  const cases = [
    ['factory throws', `window.__ModuleLoader__.load({ id: 'g', factory: () => { throw new Error('boom') } })`, 'client-factory-throws'],
    ['no apply', `window.__ModuleLoader__.load({ id: 'g', factory: () => ({ inject: [] }) })`, 'client-no-apply'],
    [
      'apply throws',
      `window.__ModuleLoader__.load({ id: 'g', factory: () => ({ inject: [], apply: (ctx) => { ctx.sidebarRightTabs.register({}) ; throw new Error('late boom') } }) })`,
      'client-apply-throws',
    ],
    [
      'apply registers nothing',
      `window.__ModuleLoader__.load({ id: 'g', factory: () => ({ inject: [], apply: () => {} }) })`,
      'client-no-registration',
    ],
  ]
  for (const [label, source, rule] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-client-bad-'))
    try {
      goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
      writeFileSync(join(dir, 'lib', 'client.js'), source)
      const { findings } = await checkClientRuntime(dir)
      assert.ok(findings.some((f) => f.rule === rule), `${label} must report ${rule}, got ${findings.map((f) => f.rule)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('the client half: using a service the factory does not inject is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-inject-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(
      join(dir, 'lib', 'client.js'),
      `window.__ModuleLoader__.load({ id: 'g', factory: () => ({ inject: [], apply: (ctx) => { ctx.sidebarRightTabs.register({ id: 'g' }) } }) })`,
    )
    const { findings } = await checkClientRuntime(dir)
    const inject = findings.find((f) => f.rule === 'client-inject-missing-sidebarRightTabs')
    assert.ok(inject, `expected an inject finding, got ${findings.map((f) => f.rule)}`)
    assert.equal(inject.severity, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a syntax error is reported as a parse failure, not a sandbox gap', async () => {  const dir = mkdtempSync(join(tmpdir(), 'gate-client-syntax-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), 'function ( { this is not javascript\n')
    const { findings } = await checkClientRuntime(dir)
    assert.ok(findings.some((f) => f.rule === 'client-parse-failed' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shipped client bundle with no dsh.client.platform is dead weight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-platform-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), goodClient)
    assert.ok(checkPackageJson(dir).some((f) => f.rule === 'client-without-platform' && f.severity === 'error'))

    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
    assert.equal(checkPackageJson(dir).filter((f) => f.rule === 'client-without-platform').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a client bundle outside files is reported from the real tarball', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-client-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './client/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })
    mkdirSync(join(dir, 'client'), { recursive: true })
    writeFileSync(join(dir, 'client', 'index.js'), goodClient)
    const { findings, pack } = await checkPack(dir)
    // whether npm force-includes it or not, the rule must agree with the tarball
    const packed = pack.files.some((f) => f.path === 'client/index.js')
    const reported = findings.some((f) => f.rule === 'pack-omits-client')
    assert.equal(reported, !packed, `tarball packed=${packed} but rule reported=${reported}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a parameters schema with a misspelled type is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-param-type-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      `export const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx) {\n  ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: { type: 'object', properties: { url: { type: 'strin' }, n: { type: 'integer' } } }, output: { schema: { type: 'json' } }, async execute() {} })\n}\n`,
    )
    const { findings } = await checkToolRegistrations(dir)
    const bad = findings.filter((f) => f.rule === 'tool-bad-parameter-type')
    assert.equal(bad.length, 1, `expected exactly one, got ${JSON.stringify(findings.map((f) => f.rule))}`)
    assert.match(bad[0].title, /good_x\.url\.type=strin/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('"private": true is a hard stop and a foreign registry is a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-private-'))
  try {
    goodPlugin(dir, { private: true })
    assert.ok(checkPackageJson(dir).some((f) => f.rule === 'private-field-set' && f.severity === 'error'))

    goodPlugin(dir, { publishConfig: { access: 'public', registry: 'https://npm.internal.example/' } })
    const reg = checkPackageJson(dir).find((f) => f.rule === 'publish-config-registry')
    assert.ok(reg)
    assert.equal(reg.severity, 'warn')

    goodPlugin(dir, { publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' } })
    assert.equal(checkPackageJson(dir).filter((f) => f.rule === 'publish-config-registry').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tarball that carries a .env or a key file is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-secret-'))
  try {
    goodPlugin(dir)
    // no "files" field: npm packs everything .gitignore does not exclude
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    delete pkg.files
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    writeFileSync(join(dir, '.env'), 'NPM_TOKEN=nope\n')
    const { findings, pack } = await checkPack(dir)
    assert.ok(pack.files.some((f) => f.path === '.env'), 'the fixture must really be packed')
    const secret = findings.find((f) => f.rule === 'pack-ships-secret')
    assert.ok(secret, `expected pack-ships-secret, got ${findings.map((f) => f.rule)}`)
    assert.equal(secret.severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('market readiness: duplicate entry, npm collision, and a repo younger than a day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-market-'))
  try {
    goodPlugin(dir)
    const entries = [
      { name: 'bushizhanghan/dsh-good', url: 'https://github.com/bushizhanghan/dsh-good', category: 'dev', npm: '@bushizhanghan/dsh-good' },
      { name: 'someone/other', url: 'https://github.com/someone/other', category: 'dev', npm: '@bushizhanghan/dsh-good' },
    ]
    const rules = (await checkMarketReadiness(dir, { entries, repoInfo: { created_at: new Date().toISOString() }, releaseInfo: {} })).map((f) => f.rule)
    assert.ok(rules.includes('market-duplicate-entry'), rules.join(','))
    assert.ok(rules.includes('market-npm-name-collision'), rules.join(','))
    assert.ok(rules.includes('market-repo-too-new'), rules.join(','))

    const clean = await checkMarketReadiness(dir, { entries: [], repoInfo: { created_at: '2020-01-01T00:00:00Z' }, releaseInfo: {} })
    assert.deepEqual(clean.map((f) => f.rule), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market readiness: a package with no GitHub repository cannot be listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-market-norepo-'))
  try {
    goodPlugin(dir, { repository: undefined })
    assert.equal(repoSlug(dir), null)
    assert.ok((await checkMarketReadiness(dir, { entries: [], repoUnavailable: 'no network in tests' })).some((f) => f.rule === 'market-no-repo'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('build freshness: stale lib/ is reported and a fresh build is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-build-'))
  try {
    goodPlugin(dir)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'lib', 'index.js'), 'export const x = 1\n')

    // lib/ older than src/ -> the tarball would carry stale build output.
    utimesSync(join(dir, 'lib', 'index.js'), new Date('2020-01-01'), new Date('2020-01-01'))
    assert.deepEqual(checkBuildFreshness(dir).map((f) => f.rule), ['stale-build'])

    // lib/ newer than src/ is what a normal build produces — the rule that used
    // to call it a hand edit fired on every healthy package and is gone.
    utimesSync(join(dir, 'src', 'index.ts'), new Date('2020-01-01'), new Date('2020-01-01'))
    utimesSync(join(dir, 'lib', 'index.js'), new Date(), new Date())
    assert.deepEqual(checkBuildFreshness(dir), [])

    // No src/ at all (plain JS plugin) -> nothing to compare.
    rmSync(join(dir, 'src'), { recursive: true, force: true })
    assert.deepEqual(checkBuildFreshness(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('node-too-old: engines.node must cover the newest feature lib/ actually uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-node-'))
  try {
    goodPlugin(dir, { engines: { node: '>=18' } })
    writeFileSync(join(dir, 'lib', 'index.js'), "const g = Object.groupBy([1], (x) => x)\nconst p = Promise.withResolvers()\n")
    const rules = checkNodeVersion(dir).map((f) => f.rule)
    assert.deepEqual(rules, ['node-too-old', 'node-too-old'])

    // A description that names the feature is prose, not a call.
    writeFileSync(join(dir, 'lib', 'index.js'), "export const name = 'x'\n// Object.groupBy needs 21\nexport const d = 'Promise.withResolvers is newer'\n")
    assert.deepEqual(checkNodeVersion(dir), [])

    // Declaring a high enough Node silences it.
    goodPlugin(dir, { engines: { node: '>=22' } })
    writeFileSync(join(dir, 'lib', 'index.js'), 'const g = Object.groupBy([1], (x) => x)\n')
    assert.deepEqual(checkNodeVersion(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('tool-call-throws: an execute that throws on empty args is caught, and only when asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-call-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'fixture'",
        'export function apply(ctx) {',
        "  ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: { type: 'object', properties: {} },",
        "    output: { schema: { type: 'json' }, render: () => ({}) },",
        "    execute: () => { throw new ReferenceError('entry is not defined') } })",
        '}',
      ].join('\n'),
    )
    // Opt-in: registration alone says nothing about execute.
    const quiet = await checkToolRegistrations(dir)
    assert.deepEqual(quiet.findings.map((f) => f.rule), [])
    // Asked for it, the throw is reported with its own message.
    const loud = await checkToolRegistrations(dir, { calls: ['good_x'] })
    const hit = loud.findings.find((f) => f.rule === 'tool-call-throws')
    assert.ok(hit, loud.findings.map((f) => f.rule).join(','))
    assert.match(hit.detail, /entry is not defined/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('tool-call-slow: a timeout is a warning, not a defect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-slow-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'fixture'",
        'export function apply(ctx) {',
        "  ctx.tools.register({ name: 'slow_x', description: 'Reads a directory and returns its tool count.', parameters: { type: 'object', properties: {} },",
        "    output: { schema: { type: 'json' }, render: () => ({}) },",
        '    execute: () => new Promise((r) => setTimeout(r, 400)) })',
        '}',
      ].join('\n'),
    )
    const r = await checkToolRegistrations(dir, { calls: ['slow_x'], callTimeoutMs: 60 })
    const rules = r.findings.map((f) => f.rule)
    assert.ok(rules.includes('tool-call-slow'), rules.join(','))
    assert.ok(!rules.includes('tool-call-throws'), 'a timeout must not be reported as a throw')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// ---------------------------------------------------------------------
// Dependency truth
// ---------------------------------------------------------------------

test('packageOf: a specifier maps to the package that would be installed', () => {
  assert.equal(packageOf('@scope/pkg/sub/path'), '@scope/pkg')
  assert.equal(packageOf('pkg/sub'), 'pkg')
  assert.equal(packageOf('./local.js'), null)
  assert.equal(packageOf('../up.js'), null)
  assert.equal(packageOf('/abs.js'), null)
  assert.equal(packageOf('node:fs'), null)
  assert.equal(packageOf('fs/promises'), null, 'a builtin subpath is still a builtin')
  assert.equal(packageOf('@scope'), null, 'a scope alone is not a package')
})

test('undeclared-import: an import that package.json does not declare is a blocker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "import { thing } from 'left-pad'\nexport const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx) { ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: {}, output: { schema: { type: 'json' } }, execute() {} }) }\n",
    )
    const findings = checkDependencies(dir)
    const hit = findings.find((f) => f.rule === 'undeclared-import')
    assert.ok(hit, findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /left-pad/)
    assert.match(hit.title, /lib[\\/]index\.js/, 'the report names the file that imports it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dep-in-dev-only: a runtime import satisfied only by devDependencies breaks for the consumer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-dev-'))
  try {
    goodPlugin(dir, { devDependencies: { 'left-pad': '^1.0.0' } })
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "import { thing } from 'left-pad'\nexport const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx) {}\n",
    )
    const rules = checkDependencies(dir).map((f) => f.rule)
    assert.deepEqual(rules, ['dep-in-dev-only'], 'a devDependency must not be reported as undeclared as well')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unused-dependency: a declared dependency lib/ never imports is a note, not a blocker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-unused-'))
  try {
    goodPlugin(dir, { dependencies: { 'left-pad': '^1.0.0' } })
    const findings = checkDependencies(dir)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'unused-dependency')
    assert.equal(findings[0].severity, 'info')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a declared dependency that is really imported is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-ok-'))
  try {
    goodPlugin(dir, { dependencies: { 'left-pad': '^1.0.0' } })
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "import { thing } from 'left-pad'\nimport { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nexport const name = 'good'\nexport function apply(ctx) {}\n",
    )
    assert.deepEqual(checkDependencies(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tool description that mentions require("react") is prose, not a dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-prose-'))
  try {
    goodPlugin(dir)
    // This is the shape that produced a false positive in this plugin's own source.
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "export const name = 'good'\nconst HINT = 'the panel does require(\"react\") at runtime'\nexport function apply(ctx) { const x = HINT; return x }\n",
    )
    assert.deepEqual(checkDependencies(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('react in the client half is provided by the host loader, not a missing dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deps-react-'))
  try {
    goodPlugin(dir, {
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    })
    writeFileSync(
      join(dir, 'lib', 'client.js'),
      "window.__ModuleLoader__.load({ id: 'good', factory: (require) => { const React = require('react'); return { apply(ctx) { ctx.slots.register({}) } } } })\n",
    )
    assert.deepEqual(checkDependencies(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version-behind-latest: publishing under the live latest is accepted by npm and reaches nobody', async () => {
  const doc = { 'dist-tags': { latest: '0.3.4' }, versions: { '0.1.0': {}, '0.3.4': {} } }
  const behind = await checkVersionTaken('@bushizhanghan/dsh-x', '0.3.0', { doc })
  assert.deepEqual(behind.map((f) => f.rule), ['version-behind-latest'])
  assert.equal(behind[0].severity, 'error')
  assert.match(behind[0].title, /0\.3\.4/)

  const ahead = await checkVersionTaken('@bushizhanghan/dsh-x', '0.3.5', { doc })
  assert.deepEqual(ahead, [], 'ahead of latest is the normal case')

  const same = await checkVersionTaken('@bushizhanghan/dsh-x', '0.3.4', { doc })
  assert.deepEqual(same.map((f) => f.rule), ['version-taken'], 'equal is the collision, not the behind case')
})

// ---------------------------------------------------------------------
// Traceability: can you point at the bytes you published?
// ---------------------------------------------------------------------

test('git-uncommitted: a modified file that ships is published from no commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-trace-dirty-'))
  try {
    goodPlugin(dir)
    const dirty = await checkTraceability(dir, {
      status: ' M lib/index.js\n?? README.md\n',
      atHead: 'v1.0.0',
      packFiles: ['lib/index.js', 'README.md', 'package.json'],
    })
    assert.deepEqual(dirty.map((f) => f.rule), ['git-uncommitted'])
    assert.equal(dirty[0].severity, 'warn')
    assert.match(dirty[0].title, /2 file\(s\)/, 'both the modified and the untracked one ship')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git-uncommitted: a dirty file that is not in the tarball is not a finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-trace-clean-'))
  try {
    goodPlugin(dir)
    const clean = await checkTraceability(dir, {
      status: ' M notes/scratch.md\n',
      atHead: 'v1.0.0',
      packFiles: ['lib/index.js', 'package.json'],
    })
    assert.deepEqual(clean, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git-tag-missing: nothing points at the published bytes afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-trace-notag-'))
  try {
    goodPlugin(dir)
    const f = await checkTraceability(dir, { status: '', atHead: '', tagExists: false })
    assert.deepEqual(f.map((x) => x.rule), ['git-tag-missing'])
    assert.match(f[0].title, /v1\.0\.0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git-tag-elsewhere: the tag exists but holds different bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-trace-elsewhere-'))
  try {
    goodPlugin(dir)
    const f = await checkTraceability(dir, { status: '', atHead: 'v0.9.0', tagExists: true })
    assert.deepEqual(f.map((x) => x.rule), ['git-tag-elsewhere'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tag on HEAD is silent, and a non-repository is left to checkGitState', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-trace-ok-'))
  try {
    goodPlugin(dir)
    assert.deepEqual(await checkTraceability(dir, { status: '', atHead: 'v1.0.0' }), [])
    assert.deepEqual(await checkTraceability(dir, { inside: 'false' }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------
// Reachable arguments
// ---------------------------------------------------------------------

test('tool-undeclared-param: an execute that reads an argument the schema never declares', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-param-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'good'",
        "export const inject = ['tools']",
        'export function apply(ctx) {',
        '  ctx.tools.register({',
        "    name: 'good_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { alpha: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        '    async execute(args) { return { a: args.alpha, b: args.beta } },',
        '  })',
        '}',
      ].join('\n'),
    )
    const r = await checkToolRegistrations(dir)
    const hits = r.findings.filter((f) => f.rule === 'tool-undeclared-param')
    assert.equal(hits.length, 1, hits.map((h) => h.title).join(' | '))
    assert.match(hits[0].title, /args\.beta/)
    assert.equal(hits[0].severity, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-undeclared-param: the destructuring form is caught too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-param-dest-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'good'",
        "export const inject = ['tools']",
        'export function apply(ctx) {',
        '  ctx.tools.register({',
        "    name: 'good_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { alpha: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        '    async execute(args) { const { alpha, gamma = 1 } = args; return { alpha, gamma } },',
        '  })',
        '}',
      ].join('\n'),
    )
    const hits = (await checkToolRegistrations(dir)).findings.filter((f) => f.rule === 'tool-undeclared-param')
    assert.equal(hits.length, 1, hits.map((h) => h.title).join(' | '))
    assert.match(hits[0].title, /args\.gamma/, 'a default value must not hide the undeclared key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-undeclared-param: a tool that only reads declared arguments is silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-param-ok-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'good'",
        "export const inject = ['tools']",
        'export function apply(ctx) {',
        '  ctx.tools.register({',
        "    name: 'good_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { alpha: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        '    async execute(args) { return { a: args.alpha } },',
        '  })',
        '}',
      ].join('\n'),
    )
    const rules = (await checkToolRegistrations(dir)).findings.map((f) => f.rule)
    assert.ok(!rules.includes('tool-undeclared-param'), rules.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------
// Publish identity and README truth
// ---------------------------------------------------------------------

test('npm-scope-mismatch: publishing under a scope you are not logged in as', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-identity-'))
  try {
    goodPlugin(dir)
    const mismatch = await checkPublishIdentity(dir, { whoami: 'someone-else' })
    assert.deepEqual(mismatch.map((f) => f.rule), ['npm-scope-mismatch'])
    // npm whoami returns the USER, never an org, so the org-scoped case is normal.
    assert.equal(mismatch[0].severity, 'info')
    assert.match(mismatch[0].title, /@bushizhanghan/)

    const ok = await checkPublishIdentity(dir, { whoami: 'bushizhanghan' })
    assert.deepEqual(ok, [], 'the owner of the scope is not a warning')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readme-wrong-package: an install line copied from another plugin is a blocker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-readme-pkg-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'README.md'),
      '# good\n\n```sh\ndsh plugin --profile desktop add @bushizhanghan/dsh-page-monitor\n```\n\n## Tools\n\n- `good_x` — does a thing.\n',
    )
    const hits = checkDocs(dir).filter((f) => f.rule === 'readme-wrong-package')
    assert.equal(hits.length, 1, hits.map((h) => h.title).join(' | '))
    assert.equal(hits[0].severity, 'error')
    assert.match(hits[0].title, /dsh-page-monitor/)
    assert.match(hits[0].title, /dsh-good/, 'the message names the right package')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readme-wrong-package: the correct install line, a placeholder and a github: spec are all silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-readme-ok-'))
  try {
    goodPlugin(dir)
    for (const line of [
      'dsh plugin --profile desktop add @bushizhanghan/dsh-good',
      'dsh plugin add @bushizhanghan/dsh-good --profile desktop',
      'dsh plugin --profile desktop add <pkg>',
      'dsh plugin --profile desktop add github:someone/repo',
    ]) {
      writeFileSync(join(dir, 'README.md'), `# good\n\n\`\`\`sh\n${line}\n\`\`\`\n`)
      const hits = checkDocs(dir).filter((f) => f.rule === 'readme-wrong-package')
      assert.deepEqual(hits, [], `should stay silent for: ${line}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-output-invalid: a result the output schema rejects is a blocker, and only when called', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-output-'))
  try {
    goodPlugin(dir)
    // The exact shape of a bug this gate shipped: a closed schema, one error
    // path still returning an undeclared key.
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'fixture'",
        'export function apply(ctx) {',
        "  ctx.tools.register({ name: 'closed_x', description: 'Reads a directory and returns its tool count.', parameters: { type: 'object', properties: {} },",
        "    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } } },",
        "    execute: async () => ({ ok: false, error: 'nope' }) })",
        '}',
      ].join('\n'),
    )
    const quiet = await checkToolRegistrations(dir)
    assert.ok(!quiet.findings.some((f) => f.rule === 'tool-output-invalid'), 'silent unless the tool is actually called')

    const r = await checkToolRegistrations(dir, { calls: ['closed_x'] })
    const hit = r.findings.find((f) => f.rule === 'tool-output-invalid')
    assert.ok(hit, r.findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /error/, 'the offending key is named')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-output-invalid stays silent when execute returns what the schema declares', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-output-ok-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      [
        "export const name = 'fixture'",
        'export function apply(ctx) {',
        "  ctx.tools.register({ name: 'good_x', description: 'Reads a directory and returns its tool count.', parameters: { type: 'object', properties: {} },",
        "    output: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, n: { type: 'integer' } } } },",
        '    execute: async () => ({ ok: true, n: 3 }) })',
        '}',
      ].join('\n'),
    )
    const r = await checkToolRegistrations(dir, { calls: ['good_x'] })
    assert.ok(!r.findings.some((f) => f.rule === 'tool-output-invalid'), r.findings.map((f) => f.rule).join(','))
    assert.ok(!r.findings.some((f) => f.rule === 'tool-call-throws'), r.findings.map((f) => f.rule).join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------
// Input fuzzing
// ---------------------------------------------------------------------

const fuzzPlugin = (dir, body) => {
  goodPlugin(dir)
  writeFileSync(join(dir, 'lib', 'index.js'), body)
}

test('tool-input-throws: a wrong-typed argument that reaches path code is caught, only when asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzz-'))
  try {
    fuzzPlugin(
      dir,
      [
        "import { join } from 'node:path'",
        "export const name = 'fuzz'",
        'export function apply(ctx) {',
        '  ctx.tools.register({',
        "    name: 'fuzz_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { dir: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        '    async execute(args) { return { ok: true, at: join(args.dir) } },',
        '  })',
        '}',
      ].join('\n'),
    )
    const off = await checkToolRegistrations(dir, {})
    assert.ok(!off.findings.some((f) => f.rule === 'tool-input-throws'), 'fuzzing is opt-in')

    const on = await checkToolRegistrations(dir, { fuzz: true })
    const hit = on.findings.find((f) => f.rule === 'tool-input-throws')
    assert.ok(hit, on.findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /fuzz_x\(dir: 123\)/)
    assert.match(hit.fix, /typeof args\.dir !== 'string'/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-input-throws: a guarded tool is silent, and skip keeps a launcher out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fuzz-ok-'))
  try {
    fuzzPlugin(
      dir,
      [
        "export const name = 'fuzz'",
        'export function apply(ctx) {',
        '  ctx.tools.register({',
        "    name: 'safe_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { dir: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        "    async execute(args) { if (typeof args.dir !== 'string') return { ok: false, error: 'dir must be a string' }; return { ok: true } },",
        '  })',
        '  ctx.tools.register({',
        "    name: 'launcher_x',",
        "    description: 'Reads a directory and returns its tool count.',",
        "    parameters: { type: 'object', properties: { app: { type: 'string' } } },",
        "    output: { schema: { type: 'json' } },",
        '    async execute(args) { throw new Error("launched " + args.app) },',
        '  })',
        '}',
      ].join('\n'),
    )
    const all = await checkToolRegistrations(dir, { fuzz: true })
    const rules = all.findings.filter((f) => f.rule === 'tool-input-throws').map((f) => f.title)
    assert.equal(rules.length, 1, rules.join(' | '))
    assert.match(rules[0], /launcher_x/, 'the guarded tool must not be reported')

    const skipped = await checkToolRegistrations(dir, { fuzz: true, fuzzSkip: ['launcher_x'] })
    assert.deepEqual(skipped.findings.filter((f) => f.rule === 'tool-input-throws'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------
// Post-publish polling
// ---------------------------------------------------------------------

test('waitForPublished: the 202-then-404 window is waited out, not reported as missing', async () => {
  let calls = 0
  const probe = async () => {
    calls += 1
    if (calls < 3) return [{ rule: 'publish-not-served', severity: 'warn', title: 'not yet' }]
    return [{ rule: 'publish-served', severity: 'info', title: 'match' }]
  }
  const r = await waitForPublished('@scope/pkg', '1.0.0', {}, { waitMs: 5000, intervalMs: 1, probe })
  assert.equal(calls, 3, 'it polls until the bytes appear')
  assert.ok(r.findings.some((f) => f.rule === 'publish-served'))
  assert.ok(r.waitedMs >= 0)
})

test('waitForPublished: waitMs 0 is a single shot, and a mismatch stops the poll', async () => {
  let calls = 0
  const probe = async () => {
    calls += 1
    return [{ rule: 'publish-served-mismatch', severity: 'error', title: 'different bytes' }]
  }
  const r = await waitForPublished('@scope/pkg', '1.0.0', {}, { waitMs: 0, probe })
  assert.equal(calls, 1)
  assert.ok(r.findings.some((f) => f.rule === 'publish-served-mismatch'))
})

test('waitForPublished: a wait that runs out is pending, not a failure', async () => {
  const probe = async () => [{ rule: 'publish-not-served', severity: 'warn', title: 'not yet' }]
  const r = await waitForPublished('@scope/pkg', '1.0.0', {}, { waitMs: 30, intervalMs: 1, probe })
  assert.equal(r.pending, true, 'the registry never caught up, so the answer is pending')
  assert.ok(!r.findings.some((f) => f.rule === 'publish-served-mismatch'))
})

// ---------------------------------------------------------------------
// Changelog consistency
// ---------------------------------------------------------------------

const changelogFixture = (version, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-changelog-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@x/y', version }, null, 2))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

test('checkChangelog: no file is a nudge, an entry for the current version is silent', () => {
  const a = changelogFixture('1.2.3')
  assert.deepEqual(checkChangelog(a).map((f) => f.rule), ['no-changelog'])

  const b = changelogFixture('1.2.3', { 'CHANGELOG.md': '# Changes\n\n## 1.2.3\n- did a thing\n\n## 1.2.2\n- older\n' })
  assert.deepEqual(checkChangelog(b).map((f) => f.rule), [])
})

test('checkChangelog: a bump without an entry is the drift it exists to catch', () => {
  const dir = changelogFixture('1.3.0', { 'CHANGELOG.md': '## 1.2.2\n- older\n' })
  const r = checkChangelog(dir)
  assert.equal(r.length, 1)
  assert.equal(r[0].rule, 'changelog-missing-version')
  assert.equal(r[0].severity, 'warn')
  assert.match(r[0].title, /no entry for 1\.3\.0/)
  assert.match(r[0].title, /newest heading is 1\.2\.2/)
})

test('checkChangelog: headings with a v prefix and brackets still match', () => {
  const dir = changelogFixture('2.0.0', { 'CHANGELOG.md': '### [v2.0.0]\n- big\n' })
  assert.deepEqual(checkChangelog(dir).map((f) => f.rule), [])
})

test('checkChangelog: a changelog with no version headings cannot be matched to a release', () => {
  const dir = changelogFixture('1.0.0', { 'CHANGELOG.md': '# Changes\n\n- stuff\n' })
  assert.deepEqual(checkChangelog(dir).map((f) => f.rule), ['changelog-no-versions'])
})

test('the client half: a bundle injected twice throws duplicate registration unless it guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-twice-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    // No window-level guard: the second evaluation calls load() again.
    writeFileSync(
      join(dir, 'lib', 'client.js'),
      `window.__ModuleLoader__.load({ id: 'twice', factory: () => ({ inject: [], apply: (ctx) => { ctx.slots.inject('x', () => {}) } }) })`,
    )
    const { findings, client } = await checkClientRuntime(dir)
    assert.match(String(client.doubleLoad), /duplicate factory registration/)
    const hit = findings.find((f) => f.rule === 'client-double-load')
    assert.ok(hit, 'expected client-double-load')
    assert.equal(hit.severity, 'warn')
    assert.match(hit.fix, /window\.__/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client half: a window-level guard makes the second injection a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-client-guard-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' } })
    writeFileSync(join(dir, 'lib', 'client.js'), goodClient)
    const { findings, client } = await checkClientRuntime(dir)
    assert.equal(client.doubleLoad, null)
    assert.equal(client.loaded, 1)
    assert.deepEqual(findings.map((f) => f.rule), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------
// Tool documentation: what the model is actually told
// ---------------------------------------------------------------------

const toolPlugin = (dir, fields) => {
  goodPlugin(dir)
  writeFileSync(
    join(dir, 'lib', 'index.js'),
    [
      "export const name = 'doc'",
      'export function apply(ctx) {',
      '  ctx.tools.register({',
      "    name: 'doc_x',",
      ...fields,
      '  })',
      '}',
    ].join('\n'),
  )
}

test('tool-no-description: a tool with no description is unselectable, not just undocumented', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-doc-none-'))
  try {
    toolPlugin(dir, ["    output: { schema: { type: 'json' } },", '    async execute() { return { ok: true } },'])
    const { findings } = await checkToolRegistrations(dir)
    const hit = findings.find((f) => f.rule === 'tool-no-description')
    assert.ok(hit, findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /doc_x/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-description-thin: repeating the name is not a description', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-doc-thin-'))
  try {
    toolPlugin(dir, [
      "    description: 'doc_x',",
      "    output: { schema: { type: 'json' } },",
      '    async execute() { return { ok: true } },',
    ])
    const { findings } = await checkToolRegistrations(dir)
    assert.ok(findings.some((f) => f.rule === 'tool-description-thin' && f.severity === 'warn'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool-no-parameters: reading args with no schema leaves every argument invisible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-doc-params-'))
  try {
    toolPlugin(dir, [
      "    description: 'Reads a session directory and returns the turn count.',",
      "    output: { schema: { type: 'json' } },",
      '    async execute(args) { return { ok: true, at: args.dir } },',
    ])
    const { findings } = await checkToolRegistrations(dir)
    const hit = findings.find((f) => f.rule === 'tool-no-parameters')
    assert.ok(hit, findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /args\.dir/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pack-ships-junk: a backup copy inside a named directory ships to every consumer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-junk-'))
  try {
    goodPlugin(dir)
    writeFileSync(join(dir, 'lib', 'client.js.bak-20261026'), '// old copy of the bundle\n')
    const { findings } = await checkPack(dir)
    const hit = findings.find((f) => f.rule === 'pack-ships-junk')
    assert.ok(hit, findings.map((f) => f.rule).join(','))
    assert.equal(hit.severity, 'warn')
    assert.match(hit.detail, /client\.js\.bak-20261026/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pack-ships-junk: a clean package says nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-junk-ok-'))
  try {
    goodPlugin(dir)
    const { findings } = await checkPack(dir)
    assert.ok(!findings.some((f) => f.rule === 'pack-ships-junk'), findings.map((f) => f.rule).join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market-fork-of-listed: a fork of an already-listed repo must say so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fork-'))
  try {
    goodPlugin(dir, { repository: { type: 'git', url: 'git+https://github.com/bushizhanghan/dsh-workbuddy-harness.git' } })
    const entries = [{ name: 'upstream', url: 'https://github.com/Faide-cyber/dsh-workbuddy', category: 'model' }]
    const repoInfo = { fork: true, created_at: '2026-01-01T00:00:00Z', parent: { full_name: 'Faide-cyber/dsh-workbuddy' } }
    const rules = (await checkMarketReadiness(dir, { entries, repoInfo, releaseInfo: {} })).map((f) => f.rule)
    assert.ok(rules.includes('market-fork-of-listed'), rules.join(','))
    assert.ok(rules.includes('market-fork-undisclosed'), rules.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market-fork-of-listed: naming the upstream clears the undisclosed warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fork-ok-'))
  try {
    goodPlugin(dir, { repository: { type: 'git', url: 'git+https://github.com/bushizhanghan/dsh-workbuddy-harness.git' } })
    writeFileSync(join(dir, 'README.md'), '# Fork\n\nA fork of Faide-cyber/dsh-workbuddy. Do not install both.\n')
    const entries = [{ name: 'upstream', url: 'https://github.com/Faide-cyber/dsh-workbuddy', category: 'model' }]
    const repoInfo = { fork: true, created_at: '2026-01-01T00:00:00Z', parent: { full_name: 'Faide-cyber/dsh-workbuddy' } }
    const rules = (await checkMarketReadiness(dir, { entries, repoInfo, releaseInfo: {} })).map((f) => f.rule)
    assert.ok(rules.includes('market-fork-of-listed'), rules.join(','))
    assert.ok(!rules.includes('market-fork-undisclosed'), rules.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market-fork-of-listed: a plain repo is not treated as a fork', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fork-none-'))
  try {
    goodPlugin(dir)
    const repoInfo = { fork: false, created_at: '2026-01-01T00:00:00Z' }
    const rules = (await checkMarketReadiness(dir, { entries: [], repoInfo, releaseInfo: {} })).map((f) => f.rule)
    assert.deepEqual(rules, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// GitHub was unreachable for an hour and six of my nine plugins were told they
// had no tag. They all did. When origin cannot be read the local tag list proves
// nothing, because the commit was pushed through the API and local HEAD is a
// different commit from the one that shipped.
test('an unreadable origin is not reported as a missing tag', async () => {
  const cases = [
    ['origin exists but cannot be read', 'origin\n', ['git-tag-unverified']],
    ['the repo has no origin at all', '', ['git-tag-missing']],
  ]
  for (const [label, remotes, want] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-tag-unver-'))
    try {
      goodPlugin(dir)
      const got = (await checkTraceability(dir, { inside: 'true', status: '', remote: null, remotes, atHead: '' })).map((f) => f.rule)
      assert.deepEqual(got, want, label)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('git tags are judged against the shipped commit, not the local one', async () => {
  const cases = [
    ['tag on the shipped commit', { head: 'aaaa', tags: { 'v1.0.0': 'aaaa' } }, []],
    ['tag on another commit', { head: 'aaaa', tags: { 'v1.0.0': 'bbbb' } }, ['git-tag-elsewhere']],
    ['no tag at all', { head: 'aaaa', tags: {} }, ['git-tag-missing']],
  ]
  for (const [label, remote, want] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-tag-remote-'))
    try {
      goodPlugin(dir)
      const got = (await checkTraceability(dir, { inside: 'true', status: '', remote })).map((f) => f.rule)
      assert.deepEqual(got, want, label)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})


// A gate that never runs the suite reports on paperwork: nine of my plugins
// shipped a test script that could not work, and every rule stayed quiet.
const testRunFixture = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-run-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'run-x', version: '1.0.0', type: 'module' }))
  mkdirSync(join(dir, 'test'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'test', name), body)
  return dir
}

test('checkTestRun: a failing suite is an error, a passing one is silent', async () => {
  const good = testRunFixture({
    'a.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fine', () => assert.equal(1, 1))\n",
  })
  const bad = testRunFixture({
    'a.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('broken', () => assert.equal(1, 2))\n",
  })
  try {
    assert.deepEqual(await checkTestRun(good), [])
    const findings = await checkTestRun(bad)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].rule, 'tests-fail')
    assert.equal(findings[0].severity, 'error')
    assert.match(findings[0].title, /broken/)
  } finally {
    rmSync(good, { recursive: true, force: true })
    rmSync(bad, { recursive: true, force: true })
  }
})

test('checkTestRun: a missing test directory is left to checkTests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-norun-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'run-y', version: '1.0.0', type: 'module' }))
    assert.deepEqual(await checkTestRun(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// Three rules shipped with their severity slot filled by the *next* rule name,
// because a string replace aimed at RULE_ORDER matched an earlier F(...) call
// instead. Nothing failed: a finding whose severity is not error/warn/info
// simply falls out of every counter and never appears in the report. Scan the
// source, because the damage is in the argument order, not the behaviour.
test('every finding is constructed with a severity the report understands', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'lib', 'engine.js'), 'utf8')
  const offenders = []
  let seen = 0
  for (const m of src.matchAll(/F\(\s*'(?:[^'\\]|\\.)*',\s*([^,\n]+)/g)) {
    seen += 1
    const sev = m[1].trim()
    const literal = /^'(?:error|warn|info)'$/.test(sev)
    const ternary = /'(?:error|warn|info)'\s*:\s*'(?:error|warn|info)'/.test(sev)
    if (!literal && !ternary) offenders.push(sev)
  }
  assert.ok(seen > 100, 'the scan found the call sites')
  assert.deepEqual(offenders, [])
})

test('a young repo is a warning, not a rule name in the severity slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-young-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@x/young',
        version: '1.0.0',
        type: 'module',
        repository: { type: 'git', url: 'git+https://github.com/x/young.git' },
        exports: { '.': './lib/index.js' },
        files: ['lib'],
      }),
    )
    const findings = await checkMarketReadiness(dir, {
      entries: [],
      repoInfo: { created_at: new Date(Date.now() - 3_600_000).toISOString(), fork: false, full_name: 'x/young' }, releaseInfo: {},
    })
    const tooNew = findings.find((f) => f.rule === 'market-repo-too-new')
    assert.ok(tooNew, 'the rule fires')
    assert.equal(tooNew.severity, 'warn')
    assert.match(tooNew.title, /1\.0h old/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the test-script and output-schema findings keep their severities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-sev-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@x/sev', version: '1.0.0', type: 'module', scripts: { test: 'node --test test/' } }),
    )
    mkdirSync(join(dir, 'test'), { recursive: true })
    writeFileSync(join(dir, 'test', 'a.test.mjs'), "import { test } from 'node:test'\ntest('ok', () => {})\n")
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(
      join(dir, 'lib', 'index.js'),
      "export const name = 'sev'\nexport const inject = []\nexport function apply(ctx) {\n  ctx.tools.register({ name: 'sev_x', description: 'Returns a count from a directory path.', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) })\n}\n",
    )
    const scriptFinding = checkTests(dir).find((f) => f.rule === 'test-script-dir-arg')
    assert.ok(scriptFinding, 'the rule fires')
    assert.equal(scriptFinding.severity, 'warn')
    const { findings } = await checkToolRegistrations(dir, { timeoutMs: 20_000 })
    const noSchema = findings.find((f) => f.rule === 'tool-missing-output-schema')
    assert.ok(noSchema, 'the rule fires')
    assert.equal(noSchema.severity, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// A catalogue entry may install a release asset rather than npm. When the newest
// release is older than the directory, the entry serves code the description no
// longer describes — a reviewer blocked a submission for exactly that.
test('a GitHub release that lags package.json is a warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-rel-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@x/rel',
        version: '1.2.7',
        type: 'module',
        repository: { type: 'git', url: 'git+https://github.com/x/rel.git' },
      }),
    )
    const base = { entries: [], repoInfo: { created_at: '2026-01-01T00:00:00Z', fork: false }, releaseInfo: {} }
    const behind = await checkMarketReadiness(dir, { ...base, releaseInfo: { tag_name: 'v1.2.6' } })
    const found = behind.find((f) => f.rule === 'market-release-behind')
    assert.ok(found, 'the rule fires')
    assert.equal(found.severity, 'warn')
    assert.match(found.title, /1\.2\.6.*1\.2\.7/)

    const same = await checkMarketReadiness(dir, { ...base, releaseInfo: { tag_name: 'v1.2.7' } })
    assert.equal(same.filter((f) => f.rule === 'market-release-behind').length, 0)

    const none = await checkMarketReadiness(dir, { ...base, releaseInfo: {} })
    assert.equal(none.filter((f) => f.rule === 'market-release-behind').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Losing the GitHub call removes three checks at once — repo age and both fork
// checks. Reporting nothing there reads as "checked and fine", which is exactly
// how a fork submission reaches a reviewer with its upstream undisclosed.
test('a blocked GitHub API is reported, not silently skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-gh-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@x/gh',
        version: '1.0.0',
        type: 'module',
        repository: { type: 'git', url: 'git+https://github.com/x/gh.git' },
      }),
    )
    const findings = await checkMarketReadiness(dir, { entries: [], repoUnavailable: 'HTTP 403' })
    const found = findings.find((f) => f.rule === 'github-unavailable')
    assert.ok(found, 'the rule fires')
    assert.equal(found.severity, 'warn')
    assert.match(found.title, /three market checks/)
    assert.match(found.detail, /NOT a clean market report/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable releases API is not a release that matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-rel2-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@x/rel2',
        version: '1.2.7',
        type: 'module',
        repository: { type: 'git', url: 'git+https://github.com/x/rel2.git' },
      }),
    )
    const base = { entries: [], repoInfo: { created_at: '2026-01-01T00:00:00Z', fork: false }, releaseInfo: {} }
    const findings = await checkMarketReadiness(dir, { ...base, releaseUnavailable: 'HTTP 500' })
    const found = findings.find((f) => f.rule === 'market-release-unverified')
    assert.ok(found, 'the rule fires')
    assert.equal(found.severity, 'info')
    // 404 is a real answer — this repository has no release at all — so it stays quiet.
    const none = await checkMarketReadiness(dir, { ...base, releaseInfo: {} })
    assert.equal(none.filter((f) => f.rule === 'market-release-unverified').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a finding with an unknown severity is named instead of vanishing', () => {
  assert.deepEqual(straySeverities([{ rule: 'a', severity: 'warn' }, { rule: 'b', severity: 'info' }]), [])
  assert.deepEqual(straySeverities([{ rule: 'b', severity: 'warn' }, { rule: 'x', severity: 'market-fork-of-listed' }]), ['x'])
  assert.deepEqual(straySeverities([{ severity: 'nope' }]), ['<no rule>'])
})


// npm force-includes README and LICENSE, not the changelog: a CHANGELOG.md the
// files field omits exists on disk, gets updated every version, and never
// reaches the registry page.
test('a changelog that files omits is called out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-cl-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@x/cl',
        version: '1.0.0',
        type: 'module',
        files: ['lib', 'README.md', 'LICENSE'],
        exports: { '.': './lib/index.js' },
      }),
    )
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), "export const name = 'cl'\nexport function apply() {}\n")
    writeFileSync(join(dir, 'README.md'), '# cl\n\ndsh plugin --profile desktop add @x/cl\n')
    writeFileSync(join(dir, 'LICENSE'), 'MIT License\n')
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- first\n')
    const missing = (await checkPack(dir)).findings.find((f) => f.rule === 'changelog-not-shipped')
    assert.ok(missing, 'the rule fires when files omits it')
    assert.equal(missing.severity, 'warn')
    assert.match(missing.title, /CHANGELOG\.md/)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    pkg.files = ['lib', 'README.md', 'LICENSE', 'CHANGELOG.md']
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    const shipped = (await checkPack(dir)).findings.find((f) => f.rule === 'changelog-not-shipped')
    assert.equal(shipped, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// Documented paths rot silently: rename a file, and the README keeps telling
// people to run something that no longer exists.
test('a README that names a file which does not exist is called out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-path-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'README.md'),
      '# x\n\ndsh plugin --profile desktop add @x/x\n\nRun `node test/integration.test.mjs` next to `lib/index.js`.\n',
    )
    const got = checkDocs(dir).filter((f) => f.rule === 'readme-path-missing')
    assert.equal(got.length, 1)
    assert.equal(got[0].severity, 'warn')
    assert.match(got[0].detail, /test\/integration\.test\.mjs/)
    assert.ok(!/lib\/index\.js/.test(got[0].detail), 'an existing file is not reported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// npm publishes to `latest` whatever the version suffix says, so a -beta goes
// out to everyone who installs by name. Nothing warns and the publish is green.
test('a prerelease that would land on latest is called out', () => {
  const cases = [
    ['1.2.0-beta.1 with no publishConfig', { version: '1.2.0-beta.1' }, 1],
    ['1.2.0-beta.1 with publishConfig.tag next', { version: '1.2.0-beta.1', publishConfig: { tag: 'next' } }, 0],
    ['1.2.0-beta.1 with publishConfig.tag latest', { version: '1.2.0-beta.1', publishConfig: { tag: 'latest' } }, 1],
    ['a plain 1.2.0', { version: '1.2.0' }, 0],
  ]
  for (const [label, patch, want] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'pg-pre-'))
    try {
      goodPlugin(dir)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, ...patch }))
      const got = checkPackageJson(dir).filter((f) => f.rule === 'prerelease-published-as-latest')
      assert.equal(got.length, want, label)
      if (want) assert.equal(got[0].severity, 'warn')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// `--tag next` leaves latest alone: the new version is on the registry and
// `npm i <name>` still resolves to the old one.
test('a published version that is not what latest points at is called out', async () => {
  const doc = (latest) => ({ versions: { '2.0.0': {} }, 'dist-tags': { latest } })
  const behind = await checkVersionTaken('x', '2.0.0', { doc: doc('1.0.0') })
  // version-taken fires too: the version really is on the registry.
  assert.deepEqual(behind.map((f) => f.rule), ['version-taken', 'publish-tag-not-latest'])
  assert.equal(behind.find((f) => f.rule === 'publish-tag-not-latest').severity, 'warn')
  const fine = await checkVersionTaken('x', '2.0.0', { doc: doc('2.0.0') })
  assert.deepEqual(fine.map((f) => f.rule), ['version-taken'])
  // not published yet: neither rule fires
  const fresh = await checkVersionTaken('x', '3.0.0', { doc: doc('2.0.0') })
  assert.deepEqual(fresh.map((f) => f.rule), [])
})


test('console.log is reported once per file, not once per call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-log-'))
  try {
    goodPlugin(dir)
    writeFileSync(
      join(dir, 'lib', 'noisy.js'),
      'export const a = () => { console.log(1); console.log(2); console.log(3) }\n',
    )
    const findings = checkLibHygiene(dir).filter((f) => f.rule === 'lib-console-log')
    assert.equal(findings.length, 1)
    assert.match(findings[0].title, /3 time\(s\)/)
    assert.match(findings[0].title, /line 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('console.log in the client bundle is not host-log residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-logc-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './client': './lib/client.js' }, dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(join(dir, 'lib', 'client.js'), 'console.log("panel mounted")\n')
    assert.deepEqual(checkLibHygiene(dir).filter((f) => f.rule === 'lib-console-log'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entryFile follows exports["."] instead of assuming lib/index.js', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-entry-'))
  try {
    goodPlugin(dir)
    writeFileSync(join(dir, 'index.mjs'), 'export const name = "x"\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@me/x', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' } }, null, 2),
    )
    assert.equal(entryFile(dir), join(dir, 'index.mjs'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entryFile returns null when the manifest names no file that exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-entry2-'))
  try {
    goodPlugin(dir)
    rmSync(join(dir, 'lib'), { recursive: true, force: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@me/x', version: '1.0.0', type: 'module', main: './gone.js' }, null, 2),
    )
    assert.equal(entryFile(dir), null)
    const { findings } = await checkToolRegistrations(dir)
    assert.deepEqual(findings.map((f) => f.rule), ['entry-missing'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Local development: the profile's node_modules link, pnpm store, mount row
// ---------------------------------------------------------------------------

test('checkLocalLink reports link-not-installed when the profile has no entry for the package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-link1-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-linkprof1-'))
  try {
    goodPlugin(dir)
    const r = checkLocalLink(dir, { profileDir: profile })
    assert.equal(r.kind, 'missing')
    assert.equal(r.resolves, false)
    assert.equal(r.path, join(profile, 'node_modules', '@bushizhanghan', 'dsh-good'))
    assert.deepEqual(r.findings.map((f) => f.rule), ['link-not-installed'])
    assert.equal(r.findings[0].severity, 'info')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a junction into the profile resolves and is reported as a junction, not a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-link2-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-linkprof2-'))
  try {
    goodPlugin(dir)
    const linkPath = join(profile, 'node_modules', '@bushizhanghan', 'dsh-good')
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(dir, linkPath, 'junction')
    const r = checkLocalLink(dir, { profileDir: profile })
    assert.equal(r.kind, 'junction')
    assert.equal(r.resolves, true)
    assert.equal(String(r.target).toLowerCase(), dir.toLowerCase())
    assert.deepEqual(r.findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a junction whose target is gone is link-target-missing, the failure that hid the Web UI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-link3-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-linkprof3-'))
  try {
    goodPlugin(dir)
    const target = join(profile, 'checkout')
    mkdirSync(target, { recursive: true })
    const linkPath = join(profile, 'node_modules', '@bushizhanghan', 'dsh-good')
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'junction')
    rmSync(target, { recursive: true, force: true })
    const r = checkLocalLink(dir, { profileDir: profile })
    assert.equal(r.resolves, false)
    assert.equal(String(r.target).toLowerCase(), target.toLowerCase())
    assert.deepEqual(r.findings.map((f) => f.rule), ['link-target-missing'])
    assert.equal(r.findings[0].severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a plain directory copy is link-stale-copy only when its version differs from the checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-link4-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-linkprof4-'))
  try {
    goodPlugin(dir)
    const copy = join(profile, 'node_modules', '@bushizhanghan', 'dsh-good')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: '@bushizhanghan/dsh-good', version: '0.9.0' }))
    const stale = checkLocalLink(dir, { profileDir: profile })
    assert.equal(stale.kind, 'copy')
    assert.deepEqual(stale.findings.map((f) => f.rule), ['link-stale-copy'])
    assert.equal(stale.findings[0].severity, 'warn')
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: '@bushizhanghan/dsh-good', version: '1.0.0' }))
    assert.deepEqual(checkLocalLink(dir, { profileDir: profile }).findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('checkStoreConflict names both pnpm majors and the ERR_PNPM_UNEXPECTED_STORE consequence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-store-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-storeprof-'))
  try {
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    const stateFile = join(profile, 'node_modules', '.modules.yaml')
    writeFileSync(stateFile, JSON.stringify({ storeDir: 'C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v10', layoutVersion: 5 }))
    const conflict = checkStoreConflict(dir, { profileDir: profile })
    assert.equal(conflict.profileMajor, 10)
    assert.equal(conflict.bundledMajor, 11)
    assert.equal(conflict.conflict, true)
    assert.deepEqual(conflict.findings.map((f) => f.rule), ['pnpm-store-conflict'])
    assert.equal(conflict.findings[0].severity, 'warn')
    assert.match(conflict.findings[0].title, /v10.*v11/)
    assert.match(conflict.findings[0].detail, /ERR_PNPM_UNEXPECTED_STORE/)
    // the same store against a matching bundled major is clean, and the major is overridable
    writeFileSync(stateFile, JSON.stringify({ storeDir: 'C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v11' }))
    assert.deepEqual(checkStoreConflict(dir, { profileDir: profile }).findings, [])
    assert.equal(checkStoreConflict(dir, { profileDir: profile, bundledPnpmMajor: 11 }).conflict, false)
    assert.equal(checkStoreConflict(dir, { profileDir: profile, bundledPnpmMajor: 10 }).conflict, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('checkMountEntry separates a top-level row from an insert row and from absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-mount-'))
  const profile = mkdtempSync(join(tmpdir(), 'pg-mountprof-'))
  try {
    goodPlugin(dir)
    const patch = join(profile, 'cordis.patch.yml')
    writeFileSync(patch, '- id: dsh-good\n  name: "@bushizhanghan/dsh-good"\n')
    const top = checkMountEntry(dir, { profileDir: profile })
    assert.equal(top.entryFound, true)
    assert.equal(top.shape, 'top-level')
    assert.deepEqual(top.findings.map((f) => f.rule), ['patch-entry-top-level'])
    assert.equal(top.findings[0].severity, 'error')

    writeFileSync(patch, '- insert:\n    - id: dsh-good\n      name: "@bushizhanghan/dsh-good"\n')
    const inserted = checkMountEntry(dir, { profileDir: profile })
    assert.equal(inserted.entryFound, true)
    assert.equal(inserted.shape, 'insert')
    assert.deepEqual(inserted.findings, [])

    writeFileSync(patch, '- insert:\n    - id: other\n      name: "@me/other"\n')
    const absent = checkMountEntry(dir, { profileDir: profile })
    assert.equal(absent.entryFound, false)
    assert.equal(absent.shape, 'absent')
    assert.deepEqual(absent.findings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a missing @deepseek-ai peer is a warn, not a load failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-peer-'))
  try {
    goodPlugin(dir)
    writeFileSync(join(dir, 'lib', 'index.js'), 'import "@deepseek-ai/dsh-settings"\nexport const name = "x"\nexport function apply() {}\n')
    const { findings } = await checkToolRegistrations(dir)
    assert.deepEqual(findings.map((f) => f.rule), ['entry-import-unresolved'])
    assert.equal(findings[0].severity, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a patch-only package is not asked to export apply', () => {
  const build = (mountName) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-patchonly-'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@tt-a1i/archify-dsh',
        version: '1.0.0',
        type: 'module',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: x\n      name: "${mountName}"\n`)
    writeFileSync(join(dir, 'lib', 'index.js'), "export const name = 'archify-dsh'\n")
    return dir
  }

  // It only inserts someone else's service, so its own entry is a helper
  // library. @tt-a1i/archify-dsh shipped exactly this shape.
  const foreign = build('@deepseek-ai/dsh-skill-filesystem')
  try {
    const rules = checkEntrySource(foreign).map((f) => f.rule)
    assert.ok(!rules.includes('no-apply-export'), 'a patch-only package owes no apply export')
    assert.ok(!rules.includes('no-inject'))
  } finally {
    rmSync(foreign, { recursive: true, force: true })
  }

  // A package that mounts itself is a real plugin and still gets checked.
  const self = build('@tt-a1i/archify-dsh')
  try {
    const rules = checkEntrySource(self).map((f) => f.rule)
    assert.ok(rules.includes('no-apply-export'))
  } finally {
    rmSync(self, { recursive: true, force: true })
  }
})

test('no-test-files accepts TypeScript specs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-tsspec-'))
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', type: 'module' }))
    writeFileSync(join(dir, 'tests', 'auth.spec.ts'), 'export const x = 1\n')
    assert.ok(!checkTests(dir).some((f) => f.rule === 'no-test-files'))

    writeFileSync(join(dir, 'tests', 'auth.ts'), 'export const x = 1\n')
    rmSync(join(dir, 'tests', 'auth.spec.ts'))
    assert.ok(checkTests(dir).some((f) => f.rule === 'no-test-files'), 'a plain .ts helper is not a test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exports-target-missing is reported for a subpath nobody wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exports-'))
  try {
    goodPlugin(dir, { exports: { '.': './lib/index.js', './engine': './lib/engine.js' } })
    const missing = checkExportsTargets(dir)
    assert.equal(missing.length, 1)
    assert.equal(missing[0].rule, 'exports-target-missing')
    assert.equal(missing[0].severity, 'error')
    assert.match(missing[0].title, /exports\["\.\/engine"\] points at lib\/engine\.js/)

    writeFileSync(join(dir, 'lib', 'engine.js'), 'export const engine = true\n')
    assert.deepEqual(checkExportsTargets(dir), [], 'a file that exists is not a finding')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pack-omits-export catches a file that exists but never ships', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-export-'))
  try {
    // files names the entry, so npm packs lib/index.js and nothing else from lib/.
    goodPlugin(dir, {
      exports: { '.': './lib/index.js', './engine': './lib/engine.js' },
      files: ['lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    })
    writeFileSync(join(dir, 'lib', 'engine.js'), 'export const engine = true\n')
    const { findings, pack } = await checkPack(dir)
    assert.ok(!pack.files.some((f) => f.path === 'lib/engine.js'), 'the fixture must really omit it')
    const hit = findings.find((f) => f.rule === 'pack-omits-export')
    assert.ok(hit, `expected pack-omits-export, got ${JSON.stringify(findings.map((f) => f.rule))}`)
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /exports\["\.\/engine"\] points at lib\/engine\.js, which npm did not pack/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bin-target-missing names the command, not just the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-bin-missing-'))
  try {
    goodPlugin(dir, { bin: { 'good-cli': 'bin/good.js' } })
    const hit = checkBin(dir).find((f) => f.rule === 'bin-target-missing')
    assert.ok(hit, 'a bin pointing at nothing has to be reported')
    assert.equal(hit.severity, 'error')
    assert.match(hit.title, /bin "good-cli" points at bin\/good\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bin-no-shebang is a warning, and a shebang silences it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-bin-shebang-'))
  try {
    goodPlugin(dir, { bin: 'bin/good.js' })
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'good.js'), 'console.log("hi")\n')
    const bare = checkBin(dir).filter((f) => f.rule === 'bin-no-shebang')
    assert.equal(bare.length, 1)
    assert.equal(bare[0].severity, 'warn')
    // a string bin is named after the package, scope stripped
    assert.match(bare[0].title, /bin "dsh-good"/)

    writeFileSync(join(dir, 'bin', 'good.js'), '#!/usr/bin/env node\nconsole.log("hi")\n')
    assert.deepEqual(checkBin(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('npm packs a bin target even when files says otherwise', async () => {
  // npm force-includes bin, main, README, LICENSE and package.json. That is why there is
  // no pack-omits-bin rule: the tarball cannot lose a bin target, so the only real bin
  // failures are the ones checkBin looks at statically (missing file, missing shebang).
  const dir = mkdtempSync(join(tmpdir(), 'gate-pack-bin-'))
  try {
    goodPlugin(dir, {
      bin: { 'good-cli': 'bin/good.js' },
      files: ['lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    })
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'good.js'), '#!/usr/bin/env node\nconsole.log("hi")\n')
    const { pack } = await checkPack(dir)
    assert.ok(pack.files.some((f) => f.path === 'bin/good.js'), 'npm includes bin regardless of files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a library is not asked for a patch, a plugin is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-patch-gate-'))
  try {
    // no dsh field: this is a helper library that nothing mounts
    goodPlugin(dir, { dsh: undefined })
    rmSync(join(dir, 'cordis.patch.yml'), { force: true })
    assert.deepEqual(
      checkPatchYml(dir).filter((f) => f.rule === 'no-patch-file'),
      [],
      'a package that never claimed to be a bundle does not owe the host a patch',
    )

    // same files, but now it declares itself a bundle
    goodPlugin(dir, {})
    rmSync(join(dir, 'cordis.patch.yml'), { force: true })
    const hit = checkPatchYml(dir).find((f) => f.rule === 'no-patch-file')
    assert.ok(hit, 'a declared bundle without a patch is mounted by nothing')
    assert.equal(hit.severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diffPack names every difference between what ships and what is live', () => {
  const local = [
    { path: 'lib/index.js', size: 100 },
    { path: 'lib/new.js', size: 10 },
    { path: 'README.md', size: 5 },
  ]
  const live = [
    { path: 'lib/index.js', size: 90 },
    { path: 'lib/gone.js', size: 7 },
    { path: 'README.md', size: 5 },
  ]
  const d = diffPack(local, live)
  assert.deepEqual(d.added, ['lib/new.js'])
  assert.deepEqual(d.removed, ['lib/gone.js'])
  assert.deepEqual(d.changed, ['lib/index.js'])
  assert.equal(d.same, false)
  assert.equal(diffPack(local, local).same, true, 'identical size lists are not a change')
  assert.equal(diffPack(null, undefined).same, true, 'missing input is not a difference')
})

test('diffPack sees a change that keeps the size the same', () => {
  const one = [{ path: 'lib/index.js', size: 100, hash: 'aaaa' }]
  const other = [{ path: 'lib/index.js', size: 100, hash: 'bbbb' }]
  assert.deepEqual(diffPack(one, other).changed, ['lib/index.js'], 'a rebuild that only moves bytes is still a change')
  assert.deepEqual(diffPack(one, [{ path: 'lib/index.js', size: 100, hash: 'aaaa' }]).changed, [])
  // without hashes on one side there is nothing better than size to compare
  assert.deepEqual(diffPack([{ path: 'a.js', size: 1 }], [{ path: 'a.js', size: 1 }]).changed, [])
})

test('a README that advertises a tool nobody registers is called out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-readme-'))
  writeFileSync(join(dir, 'README.md'), 'Call `gate_x` first, then `gate_old` if that fails.\n')
  const rules = checkReadmeTruth(dir, ['gate_x', 'gate_y']).map((f) => f.rule)
  assert.ok(rules.includes('readme-tool-stale'), 'a name that no longer exists is the point of this rule')
  assert.ok(rules.includes('readme-tool-undocumented'), 'gate_y is registered and not mentioned')
  assert.deepEqual(checkReadmeTruth(dir, ['gate_x', 'gate_old']), [], 'both names exist, nothing to say')
  rmSync(dir, { recursive: true, force: true })
})

test('two packages inserting the same mount id is an error, patch rows are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-mount-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@me/chat-ui', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    ['- patch:', '    - id: some-host-service', '- insert:', '    - id: chat-ui', "      name: '@me/chat-ui'", ''].join('\n'),
  )
  assert.deepEqual(mountIds(dir), ['chat-ui'], 'only insert: rows claim an id')

  const clash = checkMountIdCollision(dir, { installed: [{ id: 'chat-ui', name: '@other/plugin' }] })
  assert.equal(clash.length, 1)
  assert.equal(clash[0].severity, 'error')
  assert.match(clash[0].title, /already claimed by @other\/plugin/)

  // the same package appears twice in a profile all the time; that is not a collision
  assert.deepEqual(checkMountIdCollision(dir, { installed: [{ id: 'chat-ui', name: '@me/chat-ui' }] }), [])
  assert.deepEqual(checkMountIdCollision(dir, { installed: [{ id: 'other', name: '@other/plugin' }] }), [])
  rmSync(dir, { recursive: true, force: true })
})

test('planRelease bumps and refuses, applyRelease writes without losing CRLF', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
  assert.equal(bumpVersion('1.2', 'patch'), null, 'not a three-part version')

  const dir = mkdtempSync(join(tmpdir(), 'pg-release-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@me/x', version: '1.2.3', type: 'module' }, null, 2) + '\n')
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\r\n\r\n## 1.2.3\r\n\r\nold\r\n')

  const plan = planRelease(dir, { bump: 'minor', summary: 'Adds a thing.' })
  assert.equal(plan.version, '1.3.0')
  assert.deepEqual(plan.changes.map((c) => c.kind), ['version', 'changelog'])
  assert.match(planRelease(dir, { version: '1.0.0' }).error, /not newer than 1\.2\.3/)

  const applied = applyRelease(dir, { bump: 'minor', summary: 'Adds a thing.', apply: true })
  assert.equal(applied.applied, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '1.3.0')
  const text = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  assert.match(text, /## 1\.3\.0/)
  assert.ok(text.includes('\r\n'), 'CRLF is kept')
  assert.ok(!/[^\r]\n/.test(text), 'no stray LF was introduced')
  assert.ok(!/(\r\n){3,}/.test(text), 'no three-blank-line gap')
  rmSync(dir, { recursive: true, force: true })
})

test('planRelease creates a CHANGELOG when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-release2-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@me/y', version: '0.0.1' }, null, 2) + '\n')
  const plan = planRelease(dir, { bump: 'patch' })
  assert.deepEqual(plan.changes.map((c) => c.kind), ['version', 'changelog-create'])
  assert.match(plan.changes[1].text, /^# Changelog\n\n## 0\.0\.2/)
  rmSync(dir, { recursive: true, force: true })
})

test('a version lookup never treats a failed request as "not published"', async () => {
  const { registryVersion } = await import('../lib/engine.js')
  const bad = await registryVersion('not a name', '1.0.0')
  assert.equal(bad.unknown, true)
  const unreachable = await registryVersion('@me/pkg', '1.0.0', { registry: 'http://127.0.0.1:9', timeoutMs: 1500 })
  assert.equal(unreachable.unknown, true)
})
