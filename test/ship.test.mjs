import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MARKET_MIN_REPO_AGE_MS,
  ensureRepo,
  gh,
  marketEntry,
  marketEta,
  npmPublish,
  openMarketPR,
  pushWorktree,
  saveSecrets,
  secretState,
  worktreeFiles,
} from '../lib/ship.js'

const fakeStore = (seed = {}) => {
  const map = new Map(Object.entries(seed))
  return {
    map,
    set: async (ref, value) => void map.set(String(ref), value),
    resolve: async (ref) => map.get(String(ref)) || '',
    unset: async (ref) => void map.delete(String(ref)),
  }
}

test('marketEta is unknown without a creation date and exact with one', () => {
  assert.deepEqual(marketEta(null), { known: false, ready: false, earliestAt: null, waitMs: null })
  const created = '2026-01-01T00:00:00Z'
  const sameDay = marketEta(created, Date.parse(created) + 3600_000)
  assert.equal(sameDay.known, true)
  assert.equal(sameDay.ready, false)
  assert.equal(sameDay.earliestAt, '2026-01-02T00:00:00.000Z')
  assert.equal(sameDay.waitMs, MARKET_MIN_REPO_AGE_MS - 3600_000)
  assert.equal(marketEta(created, Date.parse(created) + MARKET_MIN_REPO_AGE_MS + 1).ready, true)
})

test('marketEntry writes the shape the catalogue documents', () => {
  const yaml = marketEntry({ url: 'https://github.com/me/pkg', name: 'me/pkg', category: 'tools', en: 'Does one thing.\nWell.', zh: '做一件事。' })
  assert.match(yaml, /^url: https:\/\/github\.com\/me\/pkg$/m)
  assert.match(yaml, /^name: me\/pkg$/m)
  assert.match(yaml, /^category: tools$/m)
  assert.match(yaml, /^ {2}en: >-$/m)
  assert.match(yaml, /^ {4}Does one thing\.$/m)
  assert.match(yaml, /^ {4}Well\.$/m)
})

test('secrets are stored once, reported as flags, and never echoed back', async () => {
  const ctx = { credentials: fakeStore() }
  const empty = await secretState(ctx)
  assert.equal(empty.stored, true)
  assert.deepEqual(empty.missing, ['npmToken', 'githubToken'])

  const saved = await saveSecrets(ctx, { npmToken: 'npm_secret_value', githubToken: 'gh_secret_value', npmUser: 'me' })
  assert.deepEqual(saved.saved, ['NPM_TOKEN', 'GITHUB_TOKEN', 'NPM_USER'])
  assert.equal(JSON.stringify(saved).includes('npm_secret_value'), false)
  assert.equal(JSON.stringify(saved).includes('gh_secret_value'), false)

  const after = await secretState(ctx)
  assert.equal(after.npmToken, true)
  assert.equal(after.githubToken, true)
  assert.equal(after.missing.length, 0)

  const cleared = await saveSecrets(ctx, { forget: ['npmToken'] })
  assert.deepEqual(cleared.saved, ['-NPM_TOKEN'])
  assert.equal((await secretState(ctx)).npmToken, false)
})

test('secretState reads the environment when the host has no store', async () => {
  const key = 'NPM_TOKEN'
  const before = process.env[key]
  process.env[key] = 'from_env'
  try {
    const state = await secretState({})
    assert.equal(state.stored, false)
    assert.equal(state.npmToken, true)
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
})

test('ensureRepo creates only when GitHub says 404', async () => {
  const created = []
  const transport = async (path, init) => {
    if (path === '/repos/me/new' && init.method === 'GET') return { ok: false, status: 404, text: 'Not Found' }
    if (path === '/user/repos') {
      created.push(init.body)
      return { ok: true, status: 201, data: { full_name: 'me/new' } }
    }
    return { ok: true, status: 200, data: { created_at: '2026-01-01T00:00:00Z' } }
  }
  const made = await ensureRepo('t', 'me/new', { transport, description: 'x' })
  assert.equal(made.ok, true)
  assert.equal(made.created, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].name, 'new')

  const existing = await ensureRepo('t', 'me/old', {
    transport: async () => ({ ok: true, status: 200, data: { created_at: '2026-01-01T00:00:00Z' } }),
  })
  assert.equal(existing.created, false)
})

test('a 403 is reported instead of being read as "no repository"', async () => {
  const made = await ensureRepo('t', 'me/private', { transport: async () => ({ ok: false, status: 403, text: 'rate limited' }) })
  assert.equal(made.ok, false)
  assert.match(made.why, /403/)
})

test('worktreeFiles skips node_modules and refuses huge files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ship-'))
  mkdirSync(join(dir, 'lib'))
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = 1\n')
  writeFileSync(join(dir, 'node_modules', 'x', 'big.js'), 'x')
  writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(2048))
  const out = worktreeFiles(dir, { maxBytes: 1024 })
  assert.deepEqual(out.files.map((f) => f.path), ['lib/index.js'])
  assert.deepEqual(out.tooBig.map((f) => f.path), ['huge.bin'])
  rmSync(dir, { recursive: true, force: true })
})

test('pushWorktree uploads blobs then moves the branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ship2-'))
  writeFileSync(join(dir, 'index.js'), 'export const name = 1\n')
  const seen = []
  const transport = async (path, init) => {
    seen.push(path)
    if (path.endsWith('/git/blobs')) return { ok: true, status: 201, data: { sha: 'blob1' } }
    if (path.endsWith('/git/trees')) return { ok: true, status: 201, data: { sha: 'tree1' } }
    if (path.includes('/git/ref/heads/')) return { ok: true, status: 200, data: { object: { sha: 'parent1' } } }
    if (path.endsWith('/git/commits')) return { ok: true, status: 201, data: { sha: 'commit1' } }
    if (path.includes('/git/refs/heads/')) return { ok: true, status: 200, data: {} }
    return { ok: false, status: 500, text: 'unexpected ' + path }
  }
  const res = await pushWorktree('t', 'me/pkg', dir, 'msg', { transport })
  assert.equal(res.ok, true)
  assert.equal(res.commit, 'commit1')
  assert.equal(seen[0].endsWith('/git/blobs'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('openMarketPR forks, writes one file, then opens the pull request', async () => {
  const calls = []
  const transport = async (path, init) => {
    calls.push(path + ' ' + (init.method || 'GET'))
    if (path === '/user') return { ok: true, status: 200, data: { login: 'me' } }
    if (path.endsWith('/forks')) return { ok: true, status: 202, data: { full_name: 'me/awesome-dsh-plugin' } }
    if (path === '/repos/awesome-dsh-plugin/awesome-dsh-plugin') return { ok: true, status: 200, data: { default_branch: 'main' } }
    if (path.includes('/git/ref/heads/')) return { ok: true, status: 200, data: { object: { sha: 'sha1' } } }
    if (path.includes('/contents/')) return { ok: true, status: 201, data: {} }
    if (path.endsWith('/pulls')) return { ok: true, status: 201, data: { html_url: 'https://github.com/x/y/pull/1', number: 1 } }
    return { ok: false, status: 500, text: 'unexpected ' + path }
  }
  const res = await openMarketPR('t', {
    slug: 'me-pkg',
    name: '@me/pkg',
    entryPath: 'data/plugins/me__pkg.yml',
    yaml: 'url: x\n',
    transport,
  })
  assert.equal(res.ok, true)
  assert.equal(res.number, 1)
  assert.equal(calls.some((c) => c.includes('/contents/data/plugins/me__pkg.yml PUT')), true)
})

test('gh classifies a network failure instead of throwing', async () => {
  const res = await gh('t', '/x', {
    transport: async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' })
    },
  }).catch((error) => ({ threw: String(error.message) }))
  assert.equal(res.threw, 'fetch failed')
})

test('npmPublish never puts the token in argv', async () => {
  let seen = null
  const res = await npmPublish('E:/tmp', { token: 'npm_secret', run: async (args, opts) => ((seen = { args, env: opts.env }), { ok: true }) })
  assert.equal(res.ok, true)
  assert.equal(seen.args.includes('npm_secret'), false)
  assert.equal(seen.env.NODE_AUTH_TOKEN, 'npm_secret')
})
