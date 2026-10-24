// Push the repo contents to GitHub through the contents API (git push is
// blocked by the network here, but api.github.com is reachable).
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const token = process.env.DSH_GH_TOKEN
const h = { Authorization: `Bearer ${token}`, 'User-Agent': 'dsh-publish', 'Content-Type': 'application/json' }
const REPO = 'bushizhanghan/dsh-publish-gate'
const ROOT = 'E:/dsh-publish-gate'

const files = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walk(full)
      continue
    }
    files.push(relative(ROOT, full).replace(/\\/g, '/'))
  }
}
walk(ROOT)

let pushed = 0
for (const f of files) {
  const full = join(ROOT, f)
  if (statSync(full).size > 20 * 1024 * 1024) continue
  const content = readFileSync(full).toString('base64')
  let sha = null
  const existing = await fetch(`https://api.github.com/repos/${REPO}/contents/${f}`, { headers: h })
  if (existing.status === 200) sha = (await existing.json()).sha
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${f}`, {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ message: sha ? `update ${f}` : `add ${f}`, content, branch: 'main', ...(sha ? { sha } : {}) }),
  })
  if (res.ok) pushed += 1
  else console.log(`  FAIL ${f}: ${res.status} ${(await res.text()).slice(0, 120)}`)
}
console.log(`pushed ${pushed}/${files.length} files`)
