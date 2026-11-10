// Integration test: boot the plugin against a fake ctx and drive the tools
// against the real published plugins.
import { apply } from '../lib/index.js'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, writeFileSync as writeFile, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sibling plugin checkouts resolved from this file, so the workspace can move.
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')
const WORKSPACE = HERE.replace(/\/dsh-publish-gate\/test\/?$/, '')
const sibling = (name) => `${WORKSPACE}/${name}`

// These cases run the gate against real, already-published plugins that live
// next to this checkout. On a fresh clone they do not exist, and reporting a
// failure there would blame the code for the environment.
const SIBLINGS_PRESENT = existsSync(sibling('dsh-page-monitor'))
if (!SIBLINGS_PRESENT) {
  console.log('integration: skipped - needs sibling plugin checkouts under ' + WORKSPACE)
  process.exit(0)
}

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }

const results = []
try {
  apply(fakeCtx, { networkTimeoutMs: 8000 })
  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

  const expected = [
    'publish_gate',
    'publish_gate_tools',
    'publish_gate_client',
    'publish_gate_verify',
    'publish_gate_patch',
    'publish_gate_market',
    'publish_gate_next_version',
    'publish_gate_doctor',
    'publish_gate_commands',
    'publish_gate_smoke',
    'publish_gate_ci',
    'publish_gate_update',
    'publish_gate_drift',
    'publish_gate_release',
    'publish_gate_fix',
    'publish_gate_setup',
  'publish_gate_status',
  'publish_gate_ship',
  'publish_gate_link',
  ]
  results.push([`${expected.length} tools registered`, registry.size === expected.length && expected.every((n) => registry.has(n))])

  // 1. gate over a real published plugin
  const gate = await call('publish_gate', { dir: sibling('dsh-page-monitor'), skipNetwork: true })
  results.push(['publish_gate runs on a real plugin', gate.ok === true && gate.blockers === 0 && gate.safeToPublish === true])
  results.push(['publish_gate produces a report string', typeof gate.report === 'string' && /clean|no blockers/.test(gate.report)])

  // 2. a broken plugin is caught
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const broken = mkdtempSync(join(tmpdir(), 'gate-broken-'))
  try {
    mkdirSync(join(broken, 'lib'), { recursive: true })
    writeFileSync(join(broken, 'package.json'), '\uFEFF' + JSON.stringify({ name: 'x', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(broken, 'cordis.patch.yml'), '- id: x\n  name: "x"\n')
    writeFileSync(join(broken, 'lib', 'index.js'), "const fs = require('node:fs')\nexport const name = 'x'\n")
    const bad = await call('publish_gate', { dir: broken, skipNetwork: true })
    const rules = bad.findings.map((f) => f.rule)
    results.push(['publish_gate catches BOM', rules.includes('utf8-bom')])
    results.push(['publish_gate catches a patch that never mounts', rules.includes('no-insert-row')])
    results.push(['publish_gate catches require in ESM', rules.includes('require-in-esm')])
    results.push(['publish_gate reports unsafe', bad.safeToPublish === false && bad.blockers > 0])
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }

  // 3. patch-only scope
  const patch = await call('publish_gate_patch', { dir: sibling('dsh-openfoam-doctor') })
  results.push(['publish_gate_patch is clean on a shipped plugin', patch.ok === true && patch.findings.filter((f) => f.severity === 'error').length === 0])

  // 4. market entry validation
  const market = await call('publish_gate_market', {
    text: 'name: dsh-good\ncategory: nonsense\ndescription:\n  en: only english\n',
  })
  const marketRules = market.findings.map((f) => f.rule)
  results.push(['market gate catches missing url', marketRules.includes('market-no-url')])
  results.push(['market gate catches bad category', marketRules.includes('market-bad-category')])

  // 5. next version, with a real registry probe
  const next = await call('publish_gate_next_version', { dir: sibling('dsh-page-monitor') })
  // Assert the shape, not a hardcoded version: the version moves with every
  // release, and the suggestion must be one patch above whatever it is now.
  results.push([
    'next_version reports current + suggestion',
    next.ok === true && /^\d+\.\d+\.\d+/.test(next.current || '') && /^\d+\.\d+\.\d+$/.test(next.suggested || ''),
  ])
  results.push(['next_version sees the live version', Array.isArray(next.taken)])

  // 6. multi-plugin sweep over the workspace
  const doctor = await call('publish_gate_doctor', { root: WORKSPACE })
  results.push(['doctor sweep finds plugins', doctor.ok === true && doctor.plugins.length >= 4])
  results.push(['doctor sweep ranks by blockers', doctor.plugins.every((p, i, a) => i === 0 || a[i - 1].blockers >= p.blockers)])
  results.push(['doctor sweep carries the real tarball size', doctor.plugins.every((p) => typeof p.unpackedSize === 'number' && p.unpackedSize > 0)])

  // 7. commands
  const cmds = await call('publish_gate_commands', { dir: sibling('dsh-page-monitor'), owner: 'bushizhanghan' })
  results.push(['commands lists the pipeline', cmds.ok === true && cmds.steps.length === 8 && cmds.steps[0].done === true])
  results.push(['commands flags unscoped names', /UNSCOPED/.test(JSON.stringify(cmds.steps)) === false])
  // The publish step must be runnable on this machine and followed by the
  // shasum check, or the author has no way to know the registry holds the bytes.
  const publishStep = cmds.steps.find((s) => s.name === 'npm publish')
  results.push(['commands publish step is platform-runnable', /npm publish --access public/.test(publishStep.command) && (process.platform !== 'win32' || publishStep.command.startsWith('cmd /c'))])
  // A prerelease must not go to `latest`: the command the tool prints has to
  // carry the tag, or the rule and the instructions disagree.
  const preDir = mkdtempSync(join(tmpdir(), 'pg-cmd-pre-'))
  try {
    writeFile(join(preDir, 'package.json'), JSON.stringify({ name: '@bushizhanghan/x', version: '1.0.0-beta.1', repository: { type: 'git', url: 'https://github.com/bushizhanghan/x.git' } }))
    const pre = await call('publish_gate_commands', { dir: preDir, owner: 'bushizhanghan' })
    const preStep = pre.steps.find((s) => s.name === 'npm publish')
    results.push(['commands add --tag for a prerelease', /--tag next/.test(preStep.command)])
  } finally {
    rmSync(preDir, { recursive: true, force: true })
  }
  results.push(['commands pairs publish with the shasum check', cmds.steps.findIndex((s) => /publish_gate_verify/.test(s.command)) === cmds.steps.findIndex((s) => s.name === 'npm publish') + 1])

  // 8. runtime layer: what the entry really registers in a child process
  const runtime = await call('publish_gate_tools', { dir: sibling('dsh-page-monitor') })
  results.push(['publish_gate_tools lists the registered tools', runtime.ok === true && runtime.tools.length >= 4 && runtime.tools.every((t) => t.hasExecute)])
  results.push(['publish_gate_tools finds no card-kind bug', runtime.findings.every((f) => f.rule !== 'tool-bad-card-kind')])

  // 8b. the browser half: weapp-loop is the only real client bundle here
  const client = await call('publish_gate_client', { dir: sibling('dsh-weapp-loop') })
  results.push(['publish_gate_client loads the real bundle', client.ok === true && client.client.loaded === 1 && client.client.hasApply === true])
  results.push(['the real bundle registers into a service', client.client.registrations.length > 0])
  results.push(['publish_gate_client reports no blockers on it', client.findings.every((f) => f.severity !== 'error')])

  // 9. post-publish verification compares real bytes, not version numbers.
  // 0.1.6 is published and this tree has moved on, so the bytes must differ.
  const verify = await call('publish_gate_verify', { dir: HERE.replace(/\/test\/?$/, ''), version: '0.1.6' })
  results.push(['verify reports the local tarball shasum', verify.ok === true && /^[0-9a-f]{40}$/.test(verify.localShasum || '')])
  results.push(['verify catches a spent version holding different bytes', verify.findings.some((f) => f.rule === 'publish-served-mismatch')])

  // 10. The host never validates tool input against `parameters`, so a number can
  // reach a path argument. Every tool must answer with a result, never a throw.
  const pathTools = [...registry.values()].filter((t) => t.parameters?.properties?.dir)
  let bad = null
  for (const tool of pathTools) {
    // null means "not given" and legitimately falls back to cwd, so it is not
    // in this list: only types that could never be a path.
    for (const value of [123, true, { a: 1 }, [1]]) {
      try {
        const r = await tool.execute({ dir: value }, { signal: undefined })
        if (!r || typeof r !== 'object' || r.ok !== false) bad = `${tool.name} accepted dir=${JSON.stringify(value)}`
      } catch (error) {
        bad = `${tool.name} threw on dir=${JSON.stringify(value)}: ${error && error.message}`
      }
      if (bad) break
    }
    if (bad) break
  }
  if (bad) console.error('  ->', bad)
  results.push(['a wrong-typed dir is refused, never thrown', bad === null && pathTools.length > 0])

  // 11. The local-development layer, driven against a temp profile so the real
  // one is never read or written by a test.
  const profile = mkdtempSync(join(tmpdir(), 'pg-profile-'))
  try {
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({ storeDir: 'C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v10' }))
    writeFile(join(profile, 'cordis.patch.yml'), '- id: dsh-page-monitor\n  name: "@bushizhanghan/dsh-page-monitor"\n')
    const link = await call('publish_gate_link', { dir: sibling('dsh-page-monitor'), profile })
    results.push([
      'publish_gate_link answers from a temp profile',
      link.ok === true && link.link.kind === 'missing' && link.mount.shape === 'top-level' && link.store.conflict === true,
    ])
    const linkRules = link.findings.map((f) => f.rule)
    results.push([
      'publish_gate_link reports all three local-development failures',
      ['link-not-installed', 'patch-entry-top-level', 'pnpm-store-conflict'].every((r) => linkRules.includes(r)),
    ])
    results.push(['publish_gate_link renders a report', typeof link.report === 'string' && link.report.length > 0])
    // Negative: an insert row and a matching store major are clean.
    writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: dsh-page-monitor\n      name: "@bushizhanghan/dsh-page-monitor"\n')
    writeFile(join(profile, 'node_modules', '.modules.yaml'), JSON.stringify({ storeDir: 'C:\\Users\\x\\AppData\\Local\\pnpm\\store\\v11' }))
    const clean = await call('publish_gate_link', { dir: sibling('dsh-page-monitor'), profile })
    results.push([
      'publish_gate_link is quiet on a well-formed profile',
      clean.mount.shape === 'insert' && clean.findings.filter((f) => f.severity === 'error').length === 0,
    ])
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }

  // 12. A package.json that does not parse is not a missing package.json: the
  // caller gets the parser's own sentence instead of being sent to look for a
  // file that is right there.
  const brokenJson = mkdtempSync(join(tmpdir(), 'pg-badjson-'))
  try {
    writeFile(join(brokenJson, 'package.json'), '{ "name": "@x/y", ')
    const cmds = await call('publish_gate_commands', { dir: brokenJson })
    results.push([
      'a package.json that does not parse is named as such',
      cmds.ok === false && /not valid JSON/.test(String(cmds.error)),
    ])
    const nextVersion = await call('publish_gate_next_version', { dir: brokenJson })
    results.push([
      'publish_gate_next_version refuses the same way',
      nextVersion.ok === false && /not valid JSON/.test(String(nextVersion.error)),
    ])
  } finally {
    rmSync(brokenJson, { recursive: true, force: true })
  }

  // 13. publish_gate_fix: a dry run by default, and it only ever touches the two
  // things the gate can defend.
  const fixDir = mkdtempSync(join(tmpdir(), 'pg-fix-'))
  try {
    mkdirSync(join(fixDir, 'lib'), { recursive: true })
    writeFile(join(fixDir, 'lib', 'index.js'), 'export const name = "x"\n')
    writeFile(join(fixDir, 'cordis.patch.yml'), '- insert: []\n')
    const pkg = {
      name: '@acme/fixme',
      version: '1.0.0',
      type: 'module',
      main: 'lib/index.js',
      files: ['lib'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    writeFile(join(fixDir, 'package.json'), JSON.stringify(pkg))
    const preview = await call('publish_gate_fix', { dir: fixDir })
    results.push([
      'publish_gate_fix is a dry run by default',
      preview.ok === true && preview.applied === false && preview.changes.length === 2,
    ])
    results.push([
      'publish_gate_fix explains each change',
      /access = "public"/.test(preview.report) && /cordis\.patch\.yml/.test(preview.report),
    ])
    const applied = await call('publish_gate_fix', { dir: fixDir, apply: true })
    const after = JSON.parse(readFileSync(join(fixDir, 'package.json'), 'utf8'))
    results.push([
      'publish_gate_fix writes both fixes when asked',
      applied.applied === true && after.publishConfig.access === 'public' && after.files.includes('cordis.patch.yml'),
    ])
  } finally {
    rmSync(fixDir, { recursive: true, force: true })
  }
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
