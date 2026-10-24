// Integration test: boot the plugin against a fake ctx and drive the tools
// against the real published plugins.
import { apply } from '../lib/index.js'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }

const results = []
try {
  apply(fakeCtx, { networkTimeoutMs: 8000 })
  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

  const expected = ['publish_gate', 'publish_gate_patch', 'publish_gate_market', 'publish_gate_next_version', 'publish_gate_doctor', 'publish_gate_commands']
  results.push([`${expected.length} tools registered`, expected.every((n) => registry.has(n))])

  // 1. gate over a real published plugin
  const gate = await call('publish_gate', { dir: 'E:/dsh-page-monitor', skipNetwork: true })
  results.push(['publish_gate runs on a real plugin', gate.ok === true && gate.blockers === 0 && gate.safeToPublish === true])
  results.push(['publish_gate produces a report string', typeof gate.report === 'string' && /clean|no blockers/.test(gate.report)])

  // 2. a broken plugin is caught
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const broken = mkdtempSync(join(tmpdir(), 'gate-broken-'))
  try {
    mkdirSync(join(broken, 'lib'), { recursive: true })
    writeFileSync(join(broken, 'package.json'), '\uFEFF' + JSON.stringify({ name: 'x', version: '1.0.0' }))
    writeFileSync(join(broken, 'cordis.patch.yml'), '- id: x\n  name: "x"\n')
    writeFileSync(join(broken, 'lib', 'index.js'), "const fs = require('node:fs')\nexport const name = 'x'\n")
    const bad = await call('publish_gate', { dir: broken, skipNetwork: true })
    const rules = bad.findings.map((f) => f.rule)
    results.push(['publish_gate catches BOM', rules.includes('utf8-bom')])
    results.push(['publish_gate catches wrong-indent insert', rules.includes('insert-wrong-indent')])
    results.push(['publish_gate catches require in ESM', rules.includes('require-in-esm')])
    results.push(['publish_gate reports unsafe', bad.safeToPublish === false && bad.blockers > 0])
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }

  // 3. patch-only scope
  const patch = await call('publish_gate_patch', { dir: 'E:/dsh-openfoam-doctor' })
  results.push(['publish_gate_patch is clean on a shipped plugin', patch.ok === true && patch.findings.filter((f) => f.severity === 'error').length === 0])

  // 4. market entry validation
  const market = await call('publish_gate_market', {
    text: 'name: dsh-good\ncategory: nonsense\ndescription:\n  en: only english\n',
  })
  const marketRules = market.findings.map((f) => f.rule)
  results.push(['market gate catches missing url', marketRules.includes('market-no-url')])
  results.push(['market gate catches bad category', marketRules.includes('market-bad-category')])

  // 5. next version, with a real registry probe
  const next = await call('publish_gate_next_version', { dir: 'E:/dsh-page-monitor' })
  results.push(['next_version reports current + suggestion', next.ok === true && next.current === '0.1.0' && next.suggested === '0.1.1'])
  results.push(['next_version sees the live version', Array.isArray(next.taken)])

  // 6. multi-plugin sweep over the workspace
  const doctor = await call('publish_gate_doctor', { root: 'E:/' })
  results.push(['doctor sweep finds plugins', doctor.ok === true && doctor.plugins.length >= 4])
  results.push(['doctor sweep ranks by blockers', doctor.plugins.every((p, i, a) => i === 0 || a[i - 1].blockers >= p.blockers)])

  // 7. commands
  const cmds = await call('publish_gate_commands', { dir: 'E:/dsh-page-monitor', owner: 'bushizhanghan' })
  results.push(['commands lists the pipeline', cmds.ok === true && cmds.steps.length === 6 && cmds.steps[0].done === true])
  results.push(['commands flags unscoped names', /UNSCOPED/.test(JSON.stringify(cmds.steps)) === false])
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
