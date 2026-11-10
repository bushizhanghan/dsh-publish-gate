// The half of publishing a person cannot delegate to a linter: getting the code
// onto GitHub, the tarball onto npm, and the entry into the market catalogue.
//
// Every step is resumable and reports what actually happened. Nothing here
// guesses: a step that could not run says so instead of returning ok.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { entryFile, readPkgJson } from './engine.js'

const runFile = promisify(execFile)

/** Credential references this plugin stores in the host store. */
export const SECRETS = {
  npmToken: 'NPM_TOKEN',
  githubToken: 'GITHUB_TOKEN',
  npmUser: 'NPM_USER',
}

/** The market only accepts a repository that is at least a day old. */
export const MARKET_MIN_REPO_AGE_MS = 24 * 60 * 60 * 1000

const secretStore = (ctx) => {
  const api = ctx?.credentials
  return api && typeof api.set === 'function' && typeof api.resolve === 'function' ? api : null
}

export async function secretValue(ctx, ref) { return readSecret(ctx, ref) }

async function readSecret(ctx, ref) {
  const store = secretStore(ctx)
  if (store) {
    try {
      const value = await store.resolve(ref)
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch {
      // A provider that cannot answer is not a value; fall through to the environment.
    }
  }
  const fromEnv = process.env[ref]
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : ''
}

/**
 * Which credentials exist, without ever returning one. `stored` says whether the
 * host has a writable store at all, so a caller knows if "give it once" is possible.
 */
export async function secretState(ctx) {
  const [npmToken, githubToken, npmUser] = await Promise.all(
    Object.values(SECRETS).map((ref) => readSecret(ctx, ref)),
  )
  return {
    stored: Boolean(secretStore(ctx)),
    npmToken: Boolean(npmToken),
    githubToken: Boolean(githubToken),
    npmUser: npmUser || '',
    missing: [
      ...(npmToken ? [] : ['npmToken']),
      ...(githubToken ? [] : ['githubToken']),
    ],
  }
}

/**
 * Save the credentials the user hands over once. Values never come back out of
 * this module; only which references are now configured.
 */
export async function saveSecrets(ctx, args = {}) {
  const store = secretStore(ctx)
  const saved = []
  const refused = []
  for (const [field, ref] of Object.entries(SECRETS)) {
    const value = args[field]
    if (typeof value !== 'string' || !value.trim()) continue
    if (!store) {
      refused.push({ ref, why: 'this host has no writable credential store' })
      continue
    }
    try {
      await store.set(ref, value.trim())
      saved.push(ref)
    } catch (error) {
      refused.push({ ref, why: String(error?.message || error) })
    }
  }
  const forget = Array.isArray(args.forget) ? args.forget : []
  for (const field of forget) {
    const ref = SECRETS[field]
    if (!ref) continue
    if (!store) {
      refused.push({ ref, why: 'this host has no writable credential store' })
      continue
    }
    try {
      await store.unset(ref)
      saved.push(`-${ref}`)
    } catch (error) {
      refused.push({ ref, why: String(error?.message || error) })
    }
  }
  return { saved, refused, state: await secretState(ctx) }
}

/** A GitHub API call that classifies failure instead of throwing. */
export async function gh(token, path, { method = 'GET', body, transport } = {}) {
  if (typeof transport === 'function') return transport(path, { method, body })
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-publish-gate',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { ok: res.ok, status: res.status, data, text }
}

/** Create the repository when it is missing, and leave an existing one alone. */
export async function ensureRepo(token, slug, opts = {}) {
  const seen = await gh(token, `/repos/${slug}`, { transport: opts.transport })
  if (seen.ok && seen.data) {
    return { ok: true, created: false, repo: seen.data }
  }
  if (seen.status !== 404) {
    return { ok: false, created: false, why: `GET /repos/${slug} → ${seen.status} ${String(seen.text || '').slice(0, 200)}` }
  }
  const [owner, name] = String(slug).split('/')
  const created = await gh(token, owner && name ? '/user/repos' : '/user/repos', {
    method: 'POST',
    body: { name: name || slug, private: opts.private === true, description: opts.description || '' },
    transport: opts.transport,
  })
  if (!created.ok) {
    return { ok: false, created: false, why: `POST /user/repos → ${created.status} ${String(created.text || '').slice(0, 200)}` }
  }
  return { ok: true, created: true, repo: created.data }
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** Every file that belongs in the repository, with a size ceiling per file. */
export function worktreeFiles(dir, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const files = []
  const tooBig = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.size > maxBytes) tooBig.push({ path: relative(dir, full).replace(/\\/g, '/'), bytes: stat.size })
      else files.push({ path: relative(dir, full).replace(/\\/g, '/'), full })
    }
  }
  walk(dir)
  return { files, tooBig }
}

/** Upload the working tree and move the branch, through the data API. */
export async function pushWorktree(token, slug, dir, message, opts = {}) {
  const branch = opts.branch || 'main'
  const { files, tooBig } = worktreeFiles(dir)
  if (tooBig.length > 0) {
    return { ok: false, why: `${tooBig.length} file(s) exceed the upload ceiling`, tooBig }
  }
  const api = opts.transport
  const tree = []
  for (const file of files) {
    const body = readFileSync(file.full)
    const blob = await gh(token, `/repos/${slug}/git/blobs`, {
      method: 'POST',
      body: { content: body.toString('base64'), encoding: 'base64' },
      transport: api,
    })
    if (!blob.ok) return { ok: false, why: `blob ${file.path} → ${blob.status}` }
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha })
  }
  const newTree = await gh(token, `/repos/${slug}/git/trees`, { method: 'POST', body: { tree }, transport: api })
  if (!newTree.ok) return { ok: false, why: `tree → ${newTree.status}` }
  const head = await gh(token, `/repos/${slug}/git/ref/heads/${branch}`, { transport: api })
  const parents = head.ok && head.data?.object?.sha ? [head.data.object.sha] : []
  const commit = await gh(token, `/repos/${slug}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.data.sha, parents },
    transport: api,
  })
  if (!commit.ok) return { ok: false, why: `commit → ${commit.status} ${String(commit.text || '').slice(0, 160)}` }
  const moved = head.ok
    ? await gh(token, `/repos/${slug}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.data.sha, force: false }, transport: api })
    : await gh(token, `/repos/${slug}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.data.sha }, transport: api })
  if (!moved.ok) return { ok: false, why: `ref → ${moved.status}` }
  return { ok: true, commit: commit.data.sha, files: files.length }
}

/** Publish the tarball. The token goes in the environment, never in argv. */
export async function npmPublish(dir, opts = {}) {
  const args = ['publish', '--access', 'public', '--ignore-scripts']
  if (opts.dryRun === true) args.push('--dry-run')
  const env = { ...process.env }
  if (opts.token) env.NODE_AUTH_TOKEN = opts.token
  if (typeof opts.run === 'function') return opts.run(args, { cwd: dir, env })
  const isWin = process.platform === 'win32'
  const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const argv = isWin ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args
  try {
    const { stdout, stderr } = await runFile(cmd, argv, { cwd: dir, env, timeout: opts.timeoutMs || 120_000, windowsHide: true })
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || error?.message || error) }
  }
}

/** The catalogue entry, in the shape the market repository documents. */
export function marketEntry({ url, name, category, en, zh }) {
  const fold = (textValues) =>
    textValues
      .trim()
      .split(/\r?\n/)
      .map((line) => (line ? '    ' + line : ''))
      .join('\n')
  return [
    `url: ${url}`,
    `name: ${name}`,
    `category: ${category}`,
    'description:',
    '  en: >-',
    fold(en),
    '  zh: >-',
    fold(zh),
    '',
  ].join('\n')
}

/** When the market gate opens for a repository that was just created. */
export function marketEta(createdAt, now = Date.now()) {
  const created = createdAt ? Date.parse(createdAt) : NaN
  if (!Number.isFinite(created)) return { known: false, ready: false, earliestAt: null, waitMs: null }
  const earliest = created + MARKET_MIN_REPO_AGE_MS
  return {
    known: true,
    ready: now >= earliest,
    earliestAt: new Date(earliest).toISOString(),
    waitMs: Math.max(0, earliest - now),
  }
}

/**
 * Open the catalogue pull request: fork, one file on a branch, then the PR.
 * The upstream never receives a direct write.
 */
export async function openMarketPR(token, opts = {}) {
  const upstream = opts.upstream || 'awesome-dsh-plugin/awesome-dsh-plugin'
  const transport = opts.transport
  const me = await gh(token, '/user', { transport })
  if (!me.ok) return { ok: false, why: `GET /user → ${me.status}` }
  const login = me.data.login
  const forked = await gh(token, `/repos/${upstream}/forks`, { method: 'POST', body: {}, transport })
  if (!forked.ok && forked.status !== 422) return { ok: false, why: `fork → ${forked.status} ${String(forked.text || '').slice(0, 160)}` }
  const repoSlug = forked.ok && forked.data?.full_name ? forked.data.full_name : `${login}/${upstream.split('/')[1]}`
  const up = await gh(token, `/repos/${upstream}`, { transport })
  const base = up.data?.default_branch || 'main'
  const head = await gh(token, `/repos/${repoSlug}/git/ref/heads/${base}`, { transport })
  const branch = opts.branch || `market-${opts.slug}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const put = await gh(token, `/repos/${repoSlug}/contents/${opts.entryPath}`, {
    method: 'PUT',
    body: {
      message: `Add ${opts.name}`,
      content: Buffer.from(opts.yaml, 'utf8').toString('base64'),
      branch,
      ...(head.ok ? { sha: undefined } : {}),
    },
    transport,
  })
  if (!put.ok) return { ok: false, why: `contents PUT → ${put.status} ${String(put.text || '').slice(0, 200)}` }
  const pr = await gh(token, `/repos/${upstream}/pulls`, {
    method: 'POST',
    body: { title: opts.title, head: `${login}:${branch}`, base, body: opts.body || '' },
    transport,
  })
  if (!pr.ok) return { ok: false, why: `PR → ${pr.status} ${String(pr.text || '').slice(0, 200)}` }
  return { ok: true, url: pr.data.html_url, number: pr.data.number }
}

/** What the chain knows about one plugin right now. */
export async function chainState(token, dir, opts = {}) {
  const pkg = readPkgJson(dir)
  const out = { name: pkg?.name || null, version: pkg?.version || null, entry: null, repo: null, published: null, market: null }
  const entry = entryFile(dir)
  out.entry = entry ? relative(dir, entry).replace(/\\/g, '/') : null
  if (!pkg?.name || !token) return out
  out.repo = pkg.repository?.url || pkg.repository || null
  const slug = typeof out.repo === 'string' ? /github\.com[/:]([\w.-]+\/[\w.-]+)/.exec(out.repo)?.[1]?.replace(/\.git$/, '') : null
  if (slug) {
    const repo = await gh(token, `/repos/${slug}`, { transport: opts.transport })
    if (repo.ok) {
      out.repo = { slug, createdAt: repo.data.created_at, private: repo.data.private, eta: marketEta(repo.data.created_at, opts.now) }
    }
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/${String(pkg.name).replace('/', '%2f')}`, { headers: { 'user-agent': 'dsh-publish-gate' } })
    if (res.ok) {
      const doc = await res.json()
      out.published = { latest: doc['dist-tags']?.latest || null, hasThisVersion: Boolean(doc.versions?.[pkg.version]) }
    }
  } catch {
    out.published = { latest: null, hasThisVersion: false, unreachable: true }
  }
  return out
}

// A short memory of what was actually shipped, so the next run can say "you already
// published 0.3.0" instead of starting from zero. Not secrets: those live in the host
// credential store, keyed by reference.
export function shipStatePath(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(home, 'dsh-publish-gate', 'state.json')
}

export function readShipState(home) {
  try {
    const text = readFileSync(shipStatePath(home), 'utf8')
    const data = JSON.parse(text)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export function recordShip(entry, home) {
  if (!entry?.name) return { ok: false, why: 'no package name to record' }
  try {
    const file = shipStatePath(home)
    mkdirSync(dirname(file), { recursive: true })
    const data = readShipState(home)
    data[entry.name] = { ...(data[entry.name] || {}), ...entry, at: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, why: String(error?.message || error) }
  }
}
