// Regression corpus: the six shapes that real published plugins had, each of
// which the gate used to report as broken. Every case names the package it came
// from, so a future rule change that reintroduces one of these is caught here
// rather than on someone else's plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

import {
  buildGateWorkflow,
  applyFixes,
  checkPackageJson,
  checkTraceability,
  planFixes,
  checkPublishIdentity,
  checkTests,
  checkEntrySource,
  entryFile,
  mountsSelf,
  renderMarkdown,
  unsafeTarEntry,
  unsafeTarLink,
  runStaticChecks,
} from '../lib/engine.js'

function fixture(build) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-corpus-'))
  try {
    build(dir)
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

const rules = (findings) => findings.map((f) => f.rule)

test('corpus: @liustack/modlens puts the entry in dsh/, not lib/', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'dsh'), { recursive: true })
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: '@liustack/modlens',
        version: '3.27.3',
        type: 'module',
        exports: { '.': './dsh/index.js' },
        files: ['dsh', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    writeFileSync(join(d, 'cordis.patch.yml'), '- insert:\n    - id: m\n      name: "@liustack/modlens"\n')
    writeFileSync(join(d, 'dsh', 'index.js'), "export const name = 'm'\nexport const inject = []\nexport function apply() {}\n")
  })
  try {
    assert.equal(entryFile(dir), join(dir, 'dsh', 'index.js'))
    const out = checkPackageJson(dir).filter((f) => f.rule === 'files-omits-lib' && f.severity === 'error')
    assert.deepEqual(out, [], 'the entry is not under lib/, so files owes nothing to lib/')
    assert.deepEqual(rules(checkEntrySource(dir)).filter((r) => r.startsWith('no-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: an object exports["./client"] still reaches the client layer', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: '@michengai/dsh-codex-ui',
        version: '1.0.0',
        type: 'module',
        main: './lib/index.js',
        exports: { '.': './lib/index.js', './client': { types: './lib/client.d.ts', default: './lib/client.js' } },
        files: ['lib', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    writeFileSync(join(d, 'cordis.patch.yml'), '- insert:\n    - id: c\n      name: "@michengai/dsh-codex-ui"\n')
    writeFileSync(join(d, 'lib', 'index.js'), "export const name = 'c'\nexport function apply() {}\n")
    writeFileSync(join(d, 'lib', 'client.js'), "window.__ModuleLoader__.load({ id: 'c', factory: () => ({}) })\n")
  })
  try {
    const found = rules(runStaticChecks(dir))
    assert.ok(!found.includes('client-without-export'), 'exports["./client"] exists, in object form')
    assert.ok(!found.includes('client-file-missing'), 'the target file exists')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: @tt-a1i/archify-dsh is a patch-only library and owes no apply', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: '@tt-a1i/archify-dsh',
        version: '1.0.0',
        type: 'module',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    writeFileSync(
      join(d, 'cordis.patch.yml'),
      "- insert:\n    - id: archify-skill-filesystem\n      name: '@deepseek-ai/dsh-skill-filesystem'\n",
    )
    writeFileSync(join(d, 'lib', 'index.js'), "export const name = 'archify-dsh'\n")
  })
  try {
    assert.equal(mountsSelf(dir), false)
    assert.ok(!rules(checkEntrySource(dir)).includes('no-apply-export'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: multi-line exports { apply, inject } are exports, not an absence', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: '@huanlin/dsh-plugin-better-sidebar-plugin-office',
        version: '1.0.0',
        type: 'module',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    writeFileSync(join(d, 'cordis.patch.yml'), '- insert:\n    - id: o\n      name: "@huanlin/dsh-plugin-better-sidebar-plugin-office"\n')
    writeFileSync(join(d, 'lib', 'index.js'), "const apply = 1\nconst inject = []\nexport {\n  apply,\n  inject,\n}\n")
  })
  try {
    assert.ok(!rules(checkEntrySource(dir)).includes('no-apply-export'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: dsh-workbuddy tests in TypeScript still count as tests', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'tests'), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'dsh-workbuddy', version: '1.0.0', type: 'module' }))
    writeFileSync(join(d, 'tests', 'auth.spec.ts'), 'export const x = 1\n')
  })
  try {
    assert.ok(!rules(checkTests(dir)).includes('no-test-files'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: an org scope is not a scope mismatch, it is a note', async () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: '@bushizhanghan/dsh-x', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    )
    writeFileSync(join(d, 'lib', 'index.js'), "export const name = 'x'\nexport function apply() {}\n")
  })
  try {
    const out = await checkPublishIdentity(dir, { whoami: 'bushizhanghan-org' })
    const mismatch = out.filter((f) => f.rule === 'npm-scope-mismatch')
    assert.equal(mismatch.length, 1)
    assert.equal(mismatch[0].severity, 'info', 'npm whoami reports a user, never an org')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderMarkdown groups by severity and keeps the fix', () => {
  const md = renderMarkdown([
    { rule: 'a-rule', severity: 'error', title: 'first', detail: 'why', fix: 'do x' },
    { rule: 'b-rule', severity: 'info', title: 'second' },
  ])
  assert.match(md, /^## publish gate/)
  assert.match(md, /\*\*1 error · 0 warn · 1 info\*\*/)
  assert.match(md, /### error \(1\)/)
  assert.match(md, /- \*\*`a-rule`\*\* — first\n  - why\n  - fix: do x/)
  assert.ok(md.indexOf('### error') < md.indexOf('### info'), 'errors come first')
  assert.match(renderMarkdown([]), /No findings\./)
  assert.match(renderMarkdown(undefined), /No findings\./, 'a missing list must not throw')
})

test('buildGateWorkflow runs the two things a runner can actually check', () => {
  const yaml = buildGateWorkflow({ nodeVersion: '24', branches: ['main', 'release'] })
  assert.match(yaml, /node-version: '24'/)
  assert.match(yaml, /branches: \[main, release\]/)
  assert.match(yaml, /node --test/)
  assert.match(yaml, /pack'?, '--dry-run'|npm pack --dry-run/)
  assert.match(yaml, /entry not in tarball/)
})

test('a tarball that can escape the extraction directory is refused', () => {
  assert.equal(unsafeTarEntry('package/index.js\npackage/lib/a.js'), null)
  assert.match(String(unsafeTarEntry('package/../../evil.js')), /evil/)
  assert.match(String(unsafeTarEntry('/etc/passwd')), /passwd/)
  assert.match(String(unsafeTarEntry('C:/Windows/System32/x.dll')), /System32/)
  assert.equal(unsafeTarEntry(''), null)
  assert.equal(unsafeTarEntry(undefined), null)
})

test('a tarball with a symlink member is refused, a dotted filename is not', () => {
  assert.equal(unsafeTarEntry('package/a..b.js'), null, 'a..b.js is a legal name')
  assert.ok(unsafeTarEntry('package/../out.js'))
  assert.equal(
    unsafeTarLink('-rw-r--r--  0 0 0  12 Jun  1 00:00 package/a.js\nlrwxrwxrwx  0 0 0   6 Jun  1 00:00 package/link -> ../x'),
    'lrwxrwxrwx  0 0 0   6 Jun  1 00:00 package/link -> ../x',
  )
  assert.equal(unsafeTarLink('-rw-r--r--  0 0 0  12 Jun  1 00:00 package/a.js'), null)
})

test('corpus: planFixes proposes only the manifest edits it can defend', () => {
  const dir = fixture((d) => {
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(join(d, 'lib', 'index.js'), 'export const name = "x"\n')
    writeFileSync(join(d, 'cordis.patch.yml'), '- insert: []\n')
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: '@acme/thing',
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        files: ['lib'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
  })
  try {
    const plan = planFixes(dir)
    assert.deepEqual(
      plan.changes.map((c) => c.kind),
      ['publishConfig.access', 'files'],
    )
    assert.equal(plan.changes[1].add, 'cordis.patch.yml')

    const preview = applyFixes(dir, { dryRun: true })
    assert.equal(preview.applied, false)
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).publishConfig, undefined)

    const done = applyFixes(dir, { dryRun: false })
    assert.equal(done.applied, true)
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(after.publishConfig.access, 'public')
    assert.deepEqual(after.files, ['lib', 'cordis.patch.yml'])

    assert.equal(planFixes(dir).changes.length, 0, 'a second run has nothing left to do')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corpus: a plugin inside a monorepo sees its own dirty files', async () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'acme-thing', version: '1.0.0' }))
  })
  try {
    const status = ' M sub/lib/index.js\n'
    const mine = await checkTraceability(dir, { status, prefix: 'sub/', packFiles: ['lib/index.js'], remote: null })
    assert.ok(
      mine.some((f) => f.rule === 'git-uncommitted'),
      'git prints repository-root paths, so the prefix has to be stripped before comparing',
    )
    const other = await checkTraceability(dir, { status, prefix: 'other/', packFiles: ['lib/index.js'], remote: null })
    assert.equal(
      other.some((f) => f.rule === 'git-uncommitted'),
      false,
      'a dirty file outside this package is not this package\'s problem',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the doctor finds plugins kept one level down in a workspace', async () => {
  const make = (manifest, holder) => {
    const root = mkdtempSync(join(tmpdir(), 'pg-ws-'))
    writeFileSync(join(root, manifest.name), manifest.body)
    const dir = join(root, holder, 'one')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@me/one',
        version: '1.0.0',
        type: 'module',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        files: ['lib', 'cordis.patch.yml'],
      }),
    )
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: one\n      name: '@me/one'\n")
    writeFileSync(join(dir, 'lib', 'index.js'), "export const name = 'one'\nexport const inject = []\nexport function apply() {}\n")
    return root
  }
  const tools = new Map()
  apply({ tools: { register: (t) => tools.set(t.name, t) } }, {})
  const doctor = tools.get('publish_gate_doctor')
  for (const [manifest, holder] of [
    [{ name: 'pnpm-workspace.yaml', body: "packages:\n  - 'packages/*'\n" }, 'packages'],
    [{ name: 'package.json', body: JSON.stringify({ private: true, workspaces: ['plugins/*'] }) }, 'plugins'],
  ]) {
    const root = make(manifest, holder)
    try {
      const res = await doctor.execute({ root, skipPack: true })
      assert.equal(res.ok, true, 'the sweep has to find the workspace glob, not just direct children')
      assert.deepEqual(res.plugins.map((x) => x.name), ['@me/one'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
