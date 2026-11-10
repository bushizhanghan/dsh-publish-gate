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
      // GET on a public repo needs no credential; only the mutating calls do.
      // Requiring a token here made `status` say "not on GitHub yet" about a
      // repo that had been published from for days, and it also wasted the one
      // thing a token buys: 5000 requests an hour instead of 60.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
const WANTED_TOPICS = ['dsh', 'dsh-plugin']

/**
 * The market pull request template requires the repository to carry the
 * `dsh-plugin` topic; without it the entry is rejected even though everything
 * else is right. Setting it here is cheaper than explaining the rejection later.
 */
export async function ensureTopics(token, slug, existing, opts = {}) {
  const have = Array.isArray(existing) ? existing.map(String) : []
  const missing = WANTED_TOPICS.filter((t) => !have.includes(t))
  if (missing.length === 0) return { ok: true, added: [], topics: have }
  const res = await gh(token, `/repos/${slug}/topics`, {
    method: 'PUT',
    body: { names: [...have, ...missing] },
    transport: opts.transport,
  })
  if (!res.ok) return { ok: false, added: [], why: `PUT /repos/${slug}/topics → ${res.status}` }
  return { ok: true, added: missing, topics: res.data?.names || [...have, ...missing] }
}

export async function ensureRepo(token, slug, opts = {}) {
  const seen = await gh(token, `/repos/${slug}`, { transport: opts.transport })
  if (seen.ok && seen.data) {
    const topics = await ensureTopics(token, slug, seen.data.topics, opts)
    return { ok: true, created: false, repo: seen.data, topics }
  }
  if (seen.status !== 404) {
    return { ok: false, created: false, why: `GET /repos/${slug} → ${seen.status} ${String(seen.text || '').slice(0, 200)}` }
  }
  const [owner, name] = String(slug).split('/')
  // /user/repos always creates under the authenticated account. A slug like
  // "someorg/pkg" has to go through the org endpoint instead, or the repository
  // silently lands in the wrong place and the push below 404s.
  const me = await gh(token, '/user', { transport: opts.transport })
  const login = me.ok ? String(me.data?.login || '') : ''
  const inOrg = Boolean(owner && name && login && owner.toLowerCase() !== login.toLowerCase())
  const created = await gh(token, inOrg ? `/orgs/${owner}/repos` : '/user/repos', {
    method: 'POST',
    body: { name: name || slug, private: opts.private === true, description: opts.description || '' },
    transport: opts.transport,
  })
  if (!created.ok) {
    return { ok: false, created: false, why: `POST /user/repos → ${created.status} ${String(created.text || '').slice(0, 200)}` }
  }
  const topics = await ensureTopics(token, slug, created.data?.topics, opts)
  return { ok: true, created: true, repo: created.data, topics }
}

/**
 * A package published without \`repository\` shows no source link on npm and makes
 * every later status call answer "not on GitHub yet" even though the repository
 * exists. The repo step just learned the slug, so record it before the push.
 */
export function ensureRepositoryField(dir, slug, opts = {}) {
  const p = join(dir, 'package.json')
  const raw = readFileSync(p, 'utf8')
  const json = readPkgJson(dir)
  const want = `git+https://github.com/${slug}.git`
  const current = typeof json.repository === 'string' ? json.repository : json.repository?.url
  if (current) {
    const same = String(current).replace(/\.git$/, '').toLowerCase().endsWith(String(slug).toLowerCase())
    if (same) return { ok: true, changed: false, url: current }
  }
  if (json.repository && !opts.overwrite) return { ok: true, changed: false, url: current, why: 'a different repository is already declared' }
  json.repository = { type: 'git', url: want }
  const CR = String.fromCharCode(13)
  const LF = String.fromCharCode(10)
  const nl = raw.includes(CR + LF) ? CR + LF : LF
  writeFileSync(p, JSON.stringify(json, null, 2).replace(/\n/g, nl) + nl)
  return { ok: true, changed: true, url: want }
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
    // GitHub answers 409 "Git Repository is empty" to every git-data call on a
    // repository with no commits, which is exactly the state of a repository we
    // just created. The contents API is allowed to make the first commit, so use
    // it per file and stop pretending the git-data path works there.
    if (!blob.ok && blob.status === 409) return pushByContents(token, slug, dir, message, { ...opts, branch })
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

/** First commit of an empty repository, one file at a time through /contents. */
export async function pushByContents(token, slug, dir, message, opts = {}) {
  const branch = opts.branch || 'main'
  const { files, tooBig } = worktreeFiles(dir)
  if (tooBig.length > 0) {
    return { ok: false, why: `${tooBig.length} file(s) exceed the upload ceiling`, tooBig }
  }
  let last = null
  for (const file of files) {
    const put = await gh(token, `/repos/${slug}/contents/${file.path}`, {
      method: 'PUT',
      body: {
        message,
        content: readFileSync(file.full).toString('base64'),
        branch,
      },
      transport: opts.transport,
    })
    if (!put.ok) return { ok: false, why: `contents ${file.path} → ${put.status} ${String(put.text || '').slice(0, 120)}` }
    last = put.data?.commit?.sha || last
  }
  return { ok: true, commit: last, files: files.length, method: 'contents' }
}

/**
 * Publishing a version twice is not allowed by npm, and the error you get back
 * (E403 "cannot publish over") says nothing about whether the registry already
 * holds the same bytes. Rerunning the chain after a successful release used to
 * look like a failure; it is not a failure, it is a no-op.
 */
export function decidePublish(localShasum, existing) {
  if (!localShasum || !existing || !existing.shasum) return 'publish'
  return String(existing.shasum) === String(localShasum) ? 'already' : 'conflict'
}

/**
 * Who npm thinks you are. `npm publish` reads ~/.npmrc, so a machine can publish
 * perfectly well without ever handing this plugin a token - demanding one anyway
 * is how "npm missing" appeared while `npm publish` was working from the same shell.
 */
export async function npmIdentity(opts = {}) {
  if (typeof opts.run === 'function') return opts.run()
  const isWin = process.platform === 'win32'
  const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const argv = isWin ? ['/d', '/s', '/c', 'npm whoami'] : ['whoami']
  try {
    const { stdout } = await runFile(cmd, argv, { cwd: opts.dir || process.cwd(), timeout: opts.timeoutMs || 20_000, windowsHide: true })
    const user = String(stdout || '').trim().split(/\r?\n/).pop() || ''
    return user ? { ok: true, user } : { ok: false, why: 'npm whoami printed nothing' }
  } catch (error) {
    return { ok: false, why: String(error?.stderr || error?.message || error).slice(0, 200) }
  }
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

/**
 * What happened to the pull request after you opened it. A listing is not done when
 * the PR is opened - it is done when it is merged, and the reviewer usually writes
 * why it is not merged yet. Answering that from this machine used to mean opening
 * github.com and reading the thread by hand.
 */
export async function marketPrState(token, prUrl, opts = {}) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(String(prUrl || ''))
  if (!m) return { known: false, why: 'no pull request url was recorded for this plugin' }
  const [, owner, repo, number] = m
  const pr = await gh(token, `/repos/${owner}/${repo}/pulls/${number}`, { transport: opts.transport })
  if (!pr.ok) return { known: false, why: `pull request #${number} → ${pr.status}` }
  const out = {
    known: true,
    number: Number(number),
    state: String(pr.data?.state || 'unknown'),
    merged: Boolean(pr.data?.merged),
    title: String(pr.data?.title || ''),
  }
  const comments = await gh(token, `/repos/${owner}/${repo}/issues/${number}/comments`, { transport: opts.transport })
  if (comments.ok && Array.isArray(comments.data) && comments.data.length) {
    const last = comments.data[comments.data.length - 1]
    out.lastComment = {
      from: String(last?.user?.login || 'someone'),
      at: String(last?.created_at || ''),
      body: String(last?.body || '').replace(/\s+/g, ' ').slice(0, 300),
    }
  }
  return out
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
  // A fork that is behind upstream makes the pull request carry every commit we
  // are missing. Upstream conflicts (409) and old forks without the endpoint (404)
  // are not fatal - branching from the current tip still produces one clean file.
  const synced = await gh(token, `/repos/${repoSlug}/merge-upstream`, { method: 'POST', body: { branch: base }, transport })
  const forkTip = await gh(token, `/repos/${repoSlug}/git/ref/heads/${base}`, { transport })
  const upTip = forkTip.ok ? forkTip : await gh(token, `/repos/${upstream}/git/ref/heads/${base}`, { transport })
  const branch = opts.branch || `market-${opts.slug}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const branchRef = await gh(token, `/repos/${repoSlug}/git/ref/heads/${branch}`, { transport })
  if (!branchRef.ok && upTip.data?.object?.sha) {
    // Re-running after a failure must not 422 on an existing branch, and a fresh
    // fork has no branch to write to at all.
    await gh(token, `/repos/${repoSlug}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: upTip.data.object.sha },
      transport,
    })
  }
  const existing = await gh(token, `/repos/${repoSlug}/contents/${opts.entryPath}?ref=${branch}`, { transport })
  const put = await gh(token, `/repos/${repoSlug}/contents/${opts.entryPath}`, {
    method: 'PUT',
    body: {
      message: `Add ${opts.name}`,
      content: Buffer.from(opts.yaml, 'utf8').toString('base64'),
      branch,
      ...(existing.ok && existing.data?.sha ? { sha: existing.data.sha } : {}),
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

/** owner/name from any of the shapes people put in package.json.repository. */
export function slugOfRepo(value) {
  const text = String(value || '')
  const at = text.includes('github.com/') ? text.split('github.com/')[1] : text.includes('github.com:') ? text.split('github.com:')[1] : ''
  if (!at) return null
  const parts = at.replace(/\.git$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts[0] + '/' + parts[1] : null
}

/** What the chain knows about one plugin right now. */
export async function chainState(token, dir, opts = {}) {
  const pkg = readPkgJson(dir)
  const out = { name: pkg?.name || null, version: pkg?.version || null, entry: null, repo: null, published: null, market: null }
  const entry = entryFile(dir)
  out.entry = entry ? relative(dir, entry).replace(/\\/g, '/') : null
  // Only the repository lookup needs a GitHub token. Asking npm whether this version
  // exists does not, and gating both behind the token made status answer "not
  // published yet" on a machine that had published twenty versions from the shell.
  if (!pkg?.name) return out
  out.repo = pkg.repository?.url || pkg.repository || null
  const slug = typeof out.repo === 'string' ? slugOfRepo(out.repo) : null
  if (slug) {
    const repo = await gh(token, `/repos/${slug}`, { transport: opts.transport })
    if (repo.ok) {
      out.repo = { slug, createdAt: repo.data.created_at, private: repo.data.private, eta: marketEta(repo.data.created_at, opts.now) }
    }
  }
  try {
    const res = await (opts.fetchImpl || fetch)(`https://registry.npmjs.org/${String(pkg.name).replace('/', '%2f')}`, { headers: { 'user-agent': 'dsh-publish-gate' } })
    if (res.ok) {
      const doc = await res.json()
      out.published = { latest: doc['dist-tags']?.latest || null, hasThisVersion: Boolean(doc.versions?.[pkg.version]) }
    } else if (res.status !== 404) {
      out.published = { latest: null, hasThisVersion: false, unreachable: true }
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

// The catalogue entry is keyed by repository and carries only a url, so a new
// release does not need a new pull request. Opening one every time would be noise
// for the maintainer and a 422 for us when the branch already exists.
export async function entryExists(token, { upstream = 'awesome-dsh-plugin/awesome-dsh-plugin', path, transport } = {}) {
  if (!path) return { ok: false, why: 'no entry path' }
  const res = await gh(token, `/repos/${upstream}/contents/${path}`, { transport })
  if (res.ok) return { ok: true, exists: true, sha: res.data?.sha || null }
  if (res.status === 404) return { ok: true, exists: false }
  return { ok: false, exists: false, why: 'could not read the catalogue: ' + (res.why || res.status) }
}
