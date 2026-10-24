// Open the market PR for dsh-publish-gate.
const token = process.env.DSH_GH_TOKEN
const h = { Authorization: `Bearer ${token}`, 'User-Agent': 'dsh-publish', 'Content-Type': 'application/json' }

const branch = 'add-dsh-publish-gate'
const main = await (await fetch('https://api.github.com/repos/bushizhanghan/awesome-dsh-plugin/git/ref/heads/main', { headers: h })).json()

const br = await fetch('https://api.github.com/repos/bushizhanghan/awesome-dsh-plugin/git/refs', {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha }),
})
console.log('branch:', br.status)

const fs = await import('node:fs')
const entry = fs.readFileSync('E:/dsh-publish-gate/market-entry.yml', 'utf8')
const content = Buffer.from(entry, 'utf8').toString('base64')

const commit = await fetch('https://api.github.com/repos/bushizhanghan/awesome-dsh-plugin/contents/data/plugins/bushizhanghan__dsh-publish-gate.yml', {
  method: 'PUT',
  headers: h,
  body: JSON.stringify({ message: 'Add bushizhanghan/dsh-publish-gate (DSH plugin pre-publish gate)', content, branch }),
})
const commitBody = await commit.json()
console.log('commit:', commit.status, commitBody?.content?.name || commitBody?.message || '')

const body = {
  title: 'Add bushizhanghan/dsh-publish-gate (DSH plugin pre-publish gate)',
  head: `bushizhanghan:${branch}`,
  base: 'main',
  body: [
    'Add [bushizhanghan/dsh-publish-gate](https://github.com/bushizhanghan/dsh-publish-gate) to the curated list.',
    '',
    'Publishing a DSH plugin is seven steps, and every step has a failure that stays silent until it costs you the publish: a `files` field that omits `lib/` so the tarball has no code, a BOM that makes `JSON.parse` throw an error that never mentions a BOM, a patch `insert` row at the wrong indent so the plugin installs and never mounts, a bare npm name that returns a 403 no granular token can diagnose. This plugin makes all of them checkable before you spend the publish.',
    '',
    'Six agent tools: `publish_gate` (full static + network gate, returns `safeToPublish`), `publish_gate_patch` (the patch-only check — the first thing to run when a plugin "installed but the tools never appeared"), `publish_gate_market` (validate the submission entry YAML), `publish_gate_next_version` (current version, whether the registry already has it, what to bump to), `publish_gate_doctor` (sweep a directory of plugin checkouts and rank by blockers), `publish_gate_commands` (the publish pipeline in order, with what this machine has already done).',
    '',
    '26 rules, all deterministic file or API checks — no LLM, so a wrong answer is a rule bug you can read. The gate bootstraps itself: its tests use four already-published plugins as fixtures and assert they come back with zero blockers, which keeps the rules from crying wolf.',
    '',
    '- npm: [@bushizhanghan/dsh-publish-gate](https://www.npmjs.com/package/@bushizhanghan/dsh-publish-gate) (published, v0.1.0)',
    '- Category: dev',
    '',
    'Entry file: `data/plugins/bushizhanghan__dsh-publish-gate.yml`',
  ].join('\n'),
}

const pr = await fetch('https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls', {
  method: 'POST',
  headers: h,
  body: JSON.stringify(body),
})
const prBody = await pr.json()
console.log('PR:', pr.status, prBody.number ? `#${prBody.number} ${prBody.html_url}` : prBody.message || '')
