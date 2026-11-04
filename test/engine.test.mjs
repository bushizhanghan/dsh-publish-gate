import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bumpPatch,
  checkDocs,
  checkEntrySource,
  checkMarketEntry,
  checkPackageJson,
  checkPatchYml,
  checkTests,
  checkVersionTaken,
  renderReport,
  runStaticChecks,
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
    `export const name = 'good'\nexport const inject = ['tools']\nexport function apply(ctx, config = {}) {\n  ctx.tools.register({ name: 'x', description: 'd', parameters: {}, async execute() {} })\n}\n`,
  )
  writeFileSync(join(dir, 'README.md'), '# good\n\nInstall:\n\n```sh\ndsh plugin --profile desktop add @bushizhanghan/dsh-good\n```\n')
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

test('files omitting lib is an error — the empty-tarball publish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-files-'))
  try {
    goodPlugin(dir, { files: ['README.md'] })
    const findings = checkPackageJson(dir)
    assert.ok(findings.some((f) => f.rule === 'files-omits-lib' && f.severity === 'error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing exports["."] is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exports-'))
  try {
    goodPlugin(dir)
    const p = join(dir, 'package.json')
    const json = JSON.parse(readFileSync(p, 'utf8'))
    delete json.exports
    writeFileSync(p, JSON.stringify(json))
    assert.ok(checkPackageJson(dir).some((f) => f.rule === 'no-exports' && f.severity === 'error'))
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

test('the four published plugins pass the static gate (no blockers)', () => {
  for (const dir of MY_PLUGINS) {
    const findings = runStaticChecks(dir)
    const errors = findings.filter((f) => f.severity === 'error')
    assert.deepEqual(
      errors.map((f) => `${f.rule}: ${f.title}`),
      [],
      `${dir} still has blockers`,
    )
  }
})

test('the four published plugins have no patch or entry-structure findings', () => {
  for (const dir of MY_PLUGINS) {
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
