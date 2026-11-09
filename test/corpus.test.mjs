// Regression corpus: the six shapes that real published plugins had, each of
// which the gate used to report as broken. Every case names the package it came
// from, so a future rule change that reintroduces one of these is caught here
// rather than on someone else's plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildGateWorkflow,
  checkPackageJson,
  checkPublishIdentity,
  checkTests,
  checkEntrySource,
  entryFile,
  mountsSelf,
  renderMarkdown,
  unsafeTarEntry,
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
