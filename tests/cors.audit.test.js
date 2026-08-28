// CORS audit for the Access Wealth HQ PWA + Android TWA.
//
// Contract under test (applies to every /api/* route because CORS runs as
// app-level middleware before routing):
//   1. OPTIONS preflights answer 204 with Access-Control-Allow-Origin covering
//      the production domains, the www alias, http://localhost:4173,
//      http://localhost:3000 and scoped deploy-preview hosts.
//   2. Access-Control-Allow-Headers includes Authorization and Content-Type.
//   3. Access-Control-Allow-Methods includes GET/POST/PUT/PATCH/DELETE.
//   4. Error responses (400/401/403/429) keep the same CORS headers, so the
//      installed app reads the JSON error body instead of a CORS failure.
//   5. Unknown origins stay locked out (preflight succeeds but carries no
//      Allow-Origin, so the browser blocks the app call).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-wealth-cors-test-'));
process.env.JWT_SECRET = 'test-jwt-secret-access-wealth';
process.env.NODE_ENV = 'test';           // disables the dev "allow any origin" switch
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
process.env.PORT = '0';
// Deliberately incomplete FRONTEND_URL: proves configuration cannot shrink
// the built-in allowlist (defaults and config are unioned).
process.env.FRONTEND_URL = 'https://accesswealthhq.com';

const { startServer, dbReady, dbGetAsync } = require('../server');

let server;
let baseUrl;

const ALLOWED_ORIGINS = [
    'https://accesswealthhq.com',
    'https://www.accesswealthhq.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'https://3000-sandboxid1.e2b.app',                          // deploy preview (port-prefixed proxy)
    'https://access-wealth-backend-pr-7.up.railway.app'         // Railway preview of this service
];
const DISALLOWED_ORIGINS = [
    'https://evil.example.com',
    'https://random-app-12345.up.railway.app',                  // other apps on the same provider
    'https://unrelated.e2b.app',                                // non port-prefixed sandbox host
    'https://accesswealthhq.com.evil.example.com'               // look-alike phishing domain
];

function raw(method, urlPath, { origin, headers = {}, body } = {}) {
    const finalHeaders = { ...headers };
    if (origin) finalHeaders.Origin = origin;
    return fetch(`${baseUrl}${urlPath}`, { method, headers: finalHeaders, body });
}

function preflight(urlPath, origin, requestMethod = 'POST') {
    return raw('OPTIONS', urlPath, {
        origin,
        headers: {
            'Access-Control-Request-Method': requestMethod,
            'Access-Control-Request-Headers': 'authorization, content-type'
        }
    });
}

async function waitForSchema() {
    await dbReady;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const row = await dbGetAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`).catch(() => null);
        if (row) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('schema did not initialize in time');
}

before(async () => {
    server = await new Promise((resolve) => {
        const s = startServer(0, '127.0.0.1');
        s.on('listening', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await waitForSchema();
});

after(() => new Promise((resolve) => server.close(resolve)));

// ---- 1-3. Preflight matrix ------------------------------------------------
for (const origin of ALLOWED_ORIGINS) {
    test(`preflight allowed origin: ${origin}`, async () => {
        const res = await preflight('/api/login', origin);
        assert.ok([200, 204].includes(res.status), `expected 200/204, got ${res.status}`);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        const methods = (res.headers.get('access-control-allow-methods') || '').toUpperCase();
        for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            assert.ok(methods.includes(m), `Allow-Methods '${methods}' missing ${m}`);
        }
        const headers = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
        assert.ok(headers.includes('content-type'), `Allow-Headers '${headers}' missing Content-Type`);
        assert.ok(headers.includes('authorization'), `Allow-Headers '${headers}' missing Authorization`);
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
        assert.match(res.headers.get('vary') || '', /origin/i);
    });
}

test('preflight covers GET and PATCH request methods', async () => {
    for (const method of ['GET', 'PATCH']) {
        const res = await preflight('/api/packages', 'https://accesswealthhq.com', method);
        assert.ok([200, 204].includes(res.status));
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://accesswealthhq.com');
    }
});

test('preflight works on unknown /api/* paths (middleware runs before routing)', async () => {
    const res = await preflight('/api/not-a-real-route', 'https://accesswealthhq.com');
    assert.ok([200, 204].includes(res.status));
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://accesswealthhq.com');
});

test('www alias resolves even without being configured (origin aliasing)', async () => {
    const res = await preflight('/api/login', 'https://www.accesswealthhq.com');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.accesswealthhq.com');
});

// ---- 5. Disallowed origins stay blocked -----------------------------------
for (const origin of DISALLOWED_ORIGINS) {
    test(`preflight denies origin: ${origin}`, async () => {
        const res = await preflight('/api/login', origin);
        assert.equal(res.headers.get('access-control-allow-origin'), null,
            'disallowed origin must not receive Access-Control-Allow-Origin');
    });
}

test('actual request from denied origin carries no CORS headers', async () => {
    const res = await raw('GET', '/api/packages', { origin: 'https://evil.example.com' });
    assert.equal(res.status, 200); // response is still produced (curl/non-browser clients)
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});

// ---- 4. Error responses keep CORS headers ---------------------------------
const P = 'http://localhost:4173';

test('200 success response includes CORS headers', async () => {
    const res = await raw('GET', '/api/packages', { origin: P });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), P);
    const body = await res.json();
    assert.equal(body.success, true);
});

test('401 (missing token) keeps CORS headers + readable JSON body', async () => {
    const res = await raw('GET', '/api/admin/users', { origin: P });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), P);
    const body = await res.json();
    assert.match(body.error, /token|required/i);
});

test('401 (bad/expired token) keeps CORS headers with TOKEN_INVALID code', async () => {
    const res = await raw('POST', '/api/user/sync', {
        origin: P,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not.a.real.token' },
        body: '{}'
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), P);
    const body = await res.json();
    assert.equal(body.code, 'TOKEN_INVALID');
});

test('403 (non-admin on admin route) keeps CORS headers', async () => {
    const username = `cors.user.${Date.now()}@test.com`;
    const reg = await raw('POST', '/api/register', {
        origin: P,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password123' })
    });
    assert.equal(reg.status, 200);
    const { token } = await reg.json();

    const res = await raw('GET', '/api/admin/stats', {
        origin: P,
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), P);
    const body = await res.json();
    assert.match(body.error, /admin access required/i);
});

test('400 from the global error handler (malformed JSON) keeps CORS headers', async () => {
    const res = await raw('POST', '/api/login', {
        origin: P,
        headers: { 'Content-Type': 'application/json' },
        body: '{ this is not json'
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), P);
    const body = await res.json();
    assert.match(body.error, /valid json/i);
});

test('429 (rate limited) keeps CORS headers + readable JSON body', async () => {
    const probe = `cors-audit-probe-${Date.now()}@invalid.example`;
    let lastRes = null;
    for (let i = 0; i < 31; i += 1) {
        lastRes = await raw('POST', '/api/login', {
            origin: P,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: probe, password: 'wrong-password' })
        });
    }
    assert.equal(lastRes.status, 429, `expected final attempt to be 429, got ${lastRes.status}`);
    assert.equal(lastRes.headers.get('access-control-allow-origin'), P);
    const body = await lastRes.json();
    assert.match(body.error, /too many attempts/i);
});

test('denied origin on an error response gets no Allow-Origin (browser hides body)', async () => {
    const res = await raw('GET', '/api/admin/users', { origin: 'https://evil.example.com' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('no-Origin (same-origin/server-to-server) requests still work', async () => {
    const res = await raw('GET', '/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
});
