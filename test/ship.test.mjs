import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MARKET_MIN_REPO_AGE_MS, ensureRepo, gh, marketEntry, marketEta, npmPublish, openMarketPR, pushWorktree, saveSecrets, secretState, worktreeFiles, readShipState, recordShip, entryExists } from '../lib/ship.js'

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

test('the plugin declares the credential service it reads', async () => {
  const mod = await import('../lib/index.js')
  assert.ok(mod.inject.includes('credentials'), 'without this the store may not exist yet when the tools run')
  assert.ok(mod.inject.includes('tools'))
})

async function toolCtx(tools) {
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    on() {},
    effect() {},
    setInterval() {},
    setTimeout() {},
    log() {},
    credentials: {
      _m: new Map(),
      async set(ref, value) { this._m.set(ref, value) },
      async resolve(ref) { return this._m.get(ref) || '' },
      async unset(ref) { this._m.delete(ref) },
    },
  }
  const mod = await import('../lib/index.js')
  await mod.apply(ctx, {})
  return ctx
}

function fixturePlugin(dir) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@me/ship-fixture',
    version: '1.0.0',
    type: 'module',
    description: 'fixture',
    files: ['lib', 'cordis.patch.yml', 'README.md'],
    exports: { '.': './lib/index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    repository: { type: 'git', url: 'git+https://github.com/me/ship-fixture.git' },
  }, null, 2) + '\n')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), "export const name = 'ship-fixture'\nexport const inject = []\nexport function apply() {}\n")
  writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: ship-fixture\n      name: '@me/ship-fixture'\n")
  writeFileSync(join(dir, 'README.md'), '# ship-fixture\n\nA fixture.\n')
  writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
}

test('without confirm nothing leaves the machine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ship-'))
  fixturePlugin(dir)
  const tools = []
  await toolCtx(tools)
  const ship = tools.find((t) => t.name === 'publish_gate_ship')
  const res = await ship.execute({ dir, steps: ['check', 'npm', 'market'] })
  assert.equal(res.published, false)
  assert.deepEqual(res.planned, ['npm', 'market'])
  assert.equal(res.ok, true, 'planning is not a failure')
  assert.match(res.next, /confirm: true/)
  const npmStep = res.steps.find((x) => x.step === 'npm')
  assert.equal(npmStep.planned, true)
  assert.match(npmStep.detail, /planned/)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing npm token is named, not turned into an npm error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ship2-'))
  fixturePlugin(dir)
  const tools = []
  await toolCtx(tools)
  const ship = tools.find((t) => t.name === 'publish_gate_ship')
  const res = await ship.execute({ dir, steps: ['npm'], confirm: true })
  assert.equal(res.ok, false)
  const npmStep = res.steps.find((x) => x.step === 'npm')
  assert.match(npmStep.detail, /no npm token/)
  assert.equal(res.published, false)
  rmSync(dir, { recursive: true, force: true })
})

test('recordShip remembers what was shipped, per package', () => {
  const home = mkdtempSync(join(tmpdir(), 'pg-home-'))
  assert.deepEqual(readShipState(home), {}, 'nothing recorded yet')
  assert.equal(recordShip({ name: '@me/a', version: '1.0.0', repo: 'me/a' }, home).ok, true)
  assert.equal(recordShip({ name: '@me/b', version: '2.0.0' }, home).ok, true)
  assert.equal(recordShip({ name: '@me/a', version: '1.0.1' }, home).ok, true)
  const state = readShipState(home)
  assert.equal(state['@me/a'].version, '1.0.1', 'a new ship updates the same entry')
  assert.equal(state['@me/a'].repo, 'me/a', 'and keeps what was known before')
  assert.match(state['@me/a'].at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(state['@me/b'].version, '2.0.0')
  assert.equal(recordShip({}, home).ok, false, 'no name, nothing to record')
  rmSync(home, { recursive: true, force: true })
})

test('a missing token is returned as a question, not just a sentence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ship3-'))
  fixturePlugin(dir)
  const tools = []
  await toolCtx(tools)
  const ship = tools.find((t) => t.name === 'publish_gate_ship')
  const res = await ship.execute({ dir, steps: ['repo'], confirm: true })
  assert.equal(res.ok, false)
  assert.equal(res.needs.length, 1)
  assert.equal(res.needs[0].key, 'githubToken')
  assert.match(res.needs[0].ask, /stored once/)
  rmSync(dir, { recursive: true, force: true })
})

test('entryExists tells listed from not listed, and says when it cannot tell', async () => {
  const three = (status) => (path, init) => Promise.resolve(
    status === 200
      ? { ok: true, status: 200, data: { sha: 'abc' } }
      : { ok: false, status, why: 'HTTP ' + status },
  )
  const listed = await entryExists('t', { path: 'data/plugins/me__x.yml', transport: three(200) })
  assert.deepEqual([listed.ok, listed.exists, listed.sha], [true, true, 'abc'])
  const missing = await entryExists('t', { path: 'data/plugins/me__x.yml', transport: three(404) })
  assert.deepEqual([missing.ok, missing.exists], [true, false], '404 is a real answer: not listed')
  const blocked = await entryExists('t', { path: 'data/plugins/me__x.yml', transport: three(500) })
  assert.equal(blocked.ok, false, 'a 500 is not "not listed"')
  assert.match(blocked.why, /could not read the catalogue/)
})

test('a slug in an organisation is created there, not in the account', async () => {
  const calls = []
  const transport = (path, init) => {
    calls.push((init.method || 'GET') + ' ' + path)
    if (path === '/user') return Promise.resolve({ ok: true, status: 200, data: { login: 'me' } })
    if (path.startsWith('/repos/')) return Promise.resolve({ ok: false, status: 404, why: 'HTTP 404' })
    return Promise.resolve({ ok: true, status: 201, data: { full_name: path.includes('/orgs/') ? 'someorg/pkg' : 'me/pkg' } })
  }
  const inOrg = await ensureRepo('t', 'someorg/pkg', { transport })
  assert.equal(inOrg.ok, true)
  assert.ok(calls.includes('POST /orgs/someorg/repos'), 'an org slug goes to the org endpoint')
  calls.length = 0
  await ensureRepo('t', 'me/pkg', { transport })
  assert.ok(calls.includes('POST /user/repos'), 'a personal slug still goes to /user/repos')
})

test('the dsh-plugin topic is set, because the market rejects the entry without it', async () => {
  const puts = []
  const transport = (path, init) => {
    if (path === '/repos/me/pkg') return Promise.resolve({ ok: true, status: 200, data: { topics: [] } })
    if (path === '/repos/me/pkg/topics') { puts.push(init.body.names.join(',')); return Promise.resolve({ ok: true, status: 200, data: { names: init.body.names } }) }
    return Promise.resolve({ ok: false, status: 500, why: 'unexpected ' + path })
  }
  const res = await ensureRepo('t', 'me/pkg', { transport })
  assert.equal(res.ok, true)
  assert.deepEqual(res.topics.added, ['dsh', 'dsh-plugin'])
  assert.deepEqual(puts, ['dsh,dsh-plugin'])

  const quiet = []
  const already = (path, init) => {
    if (path === '/repos/me/pkg') return Promise.resolve({ ok: true, status: 200, data: { topics: ['dsh', 'dsh-plugin', 'other'] } })
    quiet.push(path)
    return Promise.resolve({ ok: false, status: 500 })
  }
  const again = await ensureRepo('t', 'me/pkg', { transport: already })
  assert.deepEqual(again.topics.added, [])
  assert.deepEqual(quiet, [], 'no write when the topics are already there')
})

test('re-running the market step reuses the branch and replaces the file instead of 422', async () => {
  const seen = []
  const transport = async (path, init) => {
    seen.push((init.method || 'GET') + ' ' + path)
    if (path === '/user') return { ok: true, status: 200, data: { login: 'me' } }
    if (path.endsWith('/forks')) return { ok: true, status: 422, data: {} }
    if (path.includes('/merge-upstream')) return { ok: false, status: 409, text: 'conflict' }
    if (path === '/repos/awesome-dsh-plugin/awesome-dsh-plugin') return { ok: true, status: 200, data: { default_branch: 'main' } }
    if (path === '/repos/me/awesome-dsh-plugin/git/ref/heads/main') return { ok: true, status: 200, data: { object: { sha: 'tip' } } }
    if (path === '/repos/me/awesome-dsh-plugin/git/ref/heads/market-me-pkg') return { ok: false, status: 404, text: 'not found' }
    if (path === '/repos/me/awesome-dsh-plugin/git/refs') { seen.push('body:' + init.body.sha); return { ok: true, status: 201, data: {} } }
    if (path.includes('/contents/') && (!init.method || init.method === 'GET')) return { ok: true, status: 200, data: { sha: 'oldsha' } }
    if (path.includes('/contents/')) { seen.push('sha:' + (init.body.sha || 'none')); return { ok: true, status: 200, data: {} } }
    if (path.endsWith('/pulls')) return { ok: true, status: 201, data: { html_url: 'https://github.com/x/y/pull/2', number: 2 } }
    return { ok: false, status: 500, text: 'unexpected ' + path }
  }
  const res = await openMarketPR('t', { slug: 'me-pkg', name: '@me/pkg', entryPath: 'data/plugins/me__pkg.yml', yaml: 'url: x' + String.fromCharCode(10), transport })
  assert.equal(res.ok, true)
  assert.ok(seen.includes('body:tip'), 'the branch is created from the fork tip')
  assert.ok(seen.includes('sha:oldsha'), 'the existing file is replaced with its sha')
})

test('an empty repository commits through the contents API instead of failing on 409', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-empty-'))
  try {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@me/empty', version: '1.0.0' }))
    writeFileSync(join(dir, 'lib/index.js'), 'export const name = "empty"' + String.fromCharCode(10))
    const calls = []
    const transport = async (path, init) => {
      calls.push((init.method || 'GET') + ' ' + path.split('/').slice(-2).join('/'))
      if (path.includes('/git/blobs')) return { ok: false, status: 409, text: 'Git Repository is empty.' }
      if (path.includes('/contents/')) return { ok: true, status: 201, data: { commit: { sha: 'first' } } }
      return { ok: false, status: 500, text: 'unexpected ' + path }
    }
    const res = await pushWorktree('t', 'me/empty', dir, 'first commit', { transport })
    assert.equal(res.ok, true)
    assert.equal(res.method, 'contents')
    assert.equal(calls.filter((c) => c.startsWith('PUT')).length, 2, 'one PUT per file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
