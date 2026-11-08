import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareUpdate, checkCandidate, checkUpdate } from '../lib/engine.js'

function pluginDir(version, name = '@bushizhanghan/dsh-someday') {
  const dir = mkdtempSync(join(tmpdir(), 'pg-upd-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, type: 'module', exports: { '.': './lib/index.js' } }, null, 2),
  )
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "x"\nexport function apply() {}\n')
  return dir
}

test('compareUpdate: same version is info, older registry is a warning, newer is silence', () => {
  assert.deepEqual(compareUpdate('1.2.3', '1.2.3').map((f) => [f.rule, f.severity]), [['candidate-same-version', 'info']])
  assert.deepEqual(compareUpdate('1.2.3', '1.2.2').map((f) => [f.rule, f.severity]), [['candidate-older', 'warn']])
  assert.deepEqual(compareUpdate('1.2.3', '1.3.0'), [])
})

test('compareUpdate says nothing when either side is unknown', () => {
  assert.deepEqual(compareUpdate(null, '1.0.0'), [])
  assert.deepEqual(compareUpdate('1.0.0', null), [])
})

test('checkUpdate stops at the version compare when the install is already current', async () => {
  const dir = pluginDir('2.0.0')
  try {
    const res = await checkUpdate(dir, { latest: '2.0.0' })
    assert.equal(res.upToDate, true)
    assert.equal(res.current, '2.0.0')
    assert.equal(res.latest, '2.0.0')
    assert.deepEqual(res.findings.map((f) => f.rule), ['candidate-same-version'])
    assert.equal(res.candidate, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkUpdate without a name and without a package.json refuses instead of guessing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'pg-upd-empty-'))
  try {
    const res = await checkUpdate(empty, {})
    assert.deepEqual(res.findings.map((f) => f.rule), ['candidate-unavailable'])
    assert.match(res.findings[0].title, /could not tell which package/)
    assert.equal(res.upToDate, null)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('an unreachable candidate is reported as incomplete, never as a pass', async () => {
  const res = await checkCandidate('@bushizhanghan/dsh-surely-not-published-xyz', '9.9.9', { timeoutMs: 5000 })
  // Registry answered 404 (or the network failed): either way nothing was
  // downloaded, and the finding has to say so.
  assert.equal(res.dir, null)
  assert.equal(res.tarball, null)
  assert.deepEqual(res.findings.map((f) => f.rule), ['candidate-unavailable'])
  assert.equal(res.findings[0].severity, 'warn')
  assert.match(res.findings[0].detail, /NOT a clean verdict/)
})
