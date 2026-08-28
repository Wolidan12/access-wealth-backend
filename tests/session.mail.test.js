// Session hardening + transactional-mail flows (PWA contract).
//
// Covers: token-epoch revocation (password change / logout-all / reset),
// per-account throttling that works across rotating IPs while shared-NAT
// users on one IP never lock each other out, bank-number masking + the
// dedicated reveal endpoint, and the real email flows (verification +
// code-based password reset) using the render-only json transport.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-wealth-session-test-'));
process.env.JWT_SECRET = 'test-jwt-secret-access-wealth';
process.env.NODE_ENV = 'test';
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
process.env.PORT = '0';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'AdminSession1!';
process.env.MAIL_TRANSPORT = 'json'; // render-only: no SMTP needed
process.env.MAIL_FROM = 'Access Wealth HQ <no-reply@accesswealthhq.com>';

const { startServer, dbReady, dbGetAsync } = require('../server');

let server;
let baseUrl;

async function call(method, urlPath, { token, body, xff } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (xff) headers['X-Forwarded-For'] = xff;
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
}

async function waitForSchema() {
    await dbReady;
    for (let i = 0; i < 40; i += 1) {
        const row = await dbGetAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`).catch(() => null);
        if (row) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('schema did not initialize');
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

async function waitForDbCode(username, purpose, timeoutMs = 3000) {
    const t0 = Date.now();
    for (;;) {
        const row = await dbGetAsync(`SELECT code FROM email_codes WHERE username = ? AND purpose = ? AND used_at IS NULL`, [username, purpose]);
        if (row && /^\d{6}$/.test(row.code)) return row;
        if (Date.now() - t0 > timeoutMs) return null;
        await new Promise((r) => setTimeout(r, 25));
    }
}

/* ---------------- token epoch revocation ---------------- */

test('password change revokes all sessions (installed apps included)', async () => {
    const username = `revoke.pw.${Date.now()}@test.com`;
    const reg = await call('POST', '/api/register', { body: { username, password: 'firstpass1' } });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const t1 = reg.data.token;

    const changed = await call('POST', '/api/user/change-password', { token: t1, body: { current_password: 'firstpass1', new_password: 'secondpass1' } });
    assert.equal(changed.status, 200);

    const use = await call('POST', '/api/user/sync', { token: t1 });
    assert.equal(use.status, 401);
    assert.equal(use.data.code, 'TOKEN_INVALID');

    const refresh = await call('POST', '/api/refresh-token', { body: { token: t1 } });
    assert.equal(refresh.status, 401, 'refresh-token chain must die with the session family');

    const login2 = await call('POST', '/api/login', { body: { username, password: 'secondpass1' } });
    assert.equal(login2.status, 200);
    await call('POST', '/api/user/sync', { token: login2.data.token }).then((r) => assert.equal(r.status, 200));
});

test('POST /api/user/logout-all revokes the whole family', async () => {
    const username = `revoke.all.${Date.now()}@test.com`;
    const reg = await call('POST', '/api/register', { body: { username, password: 'pw123456' } });
    const t1 = reg.data.token;

    assert.equal((await call('POST', '/api/user/sync', { token: t1 })).status, 200);
    const out = await call('POST', '/api/user/logout-all', { token: t1 });
    assert.equal(out.status, 200);
    assert.equal(out.data.success, true);
    assert.equal(typeof out.data.message, 'string');

    assert.equal((await call('POST', '/api/user/sync', { token: t1 })).status, 401);
    assert.equal((await call('POST', '/api/refresh-token', { body: { token: t1 } })).status, 401);
    assert.equal((await call('POST', '/api/login', { body: { username, password: 'pw123456' } })).status, 200, 'a fresh login mints a working token');
});

/* ---------------- per-account throttling ---------------- */

test('per-account throttle fires even when the source IP rotates', async () => {
    const probe = `throttle.${Date.now()}@test.com`;
    await call('POST', '/api/register', { body: { username: probe, password: 'pw123456' } });

    let lastStatus = 0;
    for (let i = 0; i < 9; i += 1) {
        // A different forwarded IP per attempt: defeats per-IP buckets only.
        const res = await call('POST', '/api/login', {
            body: { username: probe, password: 'wrong-pass' },
            xff: `198.51.100.${10 + i}`
        });
        lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, '9th bad attempt against one account must be 429 regardless of rotating IPs');
});

test('shared-network users on one IP do NOT lock each other out', async () => {
    // Five different (nonexistent) accounts, SAME source IP: each must get a
    // normal 400, never a 429 — the Lagos office/estate NAT case.
    for (let i = 0; i < 5; i += 1) {
        const res = await call('POST', '/api/login', {
            body: { username: `nat-user-${Date.now()}-${i}@test.com`, password: 'nope1234' },
            xff: '203.0.113.77'
        });
        assert.equal(res.status, 400, `distinct account ${i} on shared IP got ${res.status} instead of a normal auth failure`);
    }
});

/* ---------------- bank masking + reveal ---------------- */

test('bank numbers are masked on GET/sync, revealed only via the dedicated POST', async () => {
    const username = `mask.${Date.now()}@test.com`;
    const reg = await call('POST', '/api/register', { body: { username, password: 'pw123456' } });
    const token = reg.data.token;

    await call('POST', '/api/user/update-bank', { token, body: { bank_name: 'Moniepoint', account_number: '7012345678', account_holder: 'Mask Tester' } });

    const sync = await call('POST', '/api/user/sync', { token });
    assert.equal(sync.data.user.bank_account_number, '****5678');
    const rawRow = await dbGetAsync(`SELECT bank_account_number FROM users WHERE username = ?`, [username]);
    assert.equal(rawRow.bank_account_number, '7012345678', 'the DB keeps the real number — only API output is masked');

    const reveal = await call('POST', '/api/user/reveal-bank', { token });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.data.bank.bank_account_number, '7012345678');
    assert.match((reveal.headers.get('cache-control') || '').toLowerCase(), /no-store/);

    // Withdrawal without bank_details falls back to the saved account.
    await call('POST', '/api/admin/adjust-balance', {
        token: (await call('POST', '/api/login', { body: { username: 'admin@accesswealth.com', password: 'AdminSession1!' } })).data.token,
        body: { username, walletType: 'balance', action: 'add', amount: 5000 }
    });
    const wd = await call('POST', '/api/request-withdrawal', { token, body: { amount: 3000, wallet_type: 'balance' } });
    assert.equal(wd.status, 200, JSON.stringify(wd.data));
    const row = await dbGetAsync(`SELECT bank_details FROM withdrawals WHERE username = ? ORDER BY id DESC LIMIT 1`, [username]);
    assert.equal(JSON.parse(row.bank_details).account_number, '7012345678', 'withdrawal must persist the real saved number, never the mask');
});

/* ---------------- email flows (json transport) ---------------- */

test('password reset via emailed 6-digit code + revocation of old sessions', async () => {
    const username = `reset.${Date.now()}@test.com`;
    const reg = await call('POST', '/api/register', { body: { username, password: 'oldpass1' } });
    const oldToken = reg.data.token;

    const forgot = await call('POST', '/api/forgot-password', { body: { username } });
    assert.equal(forgot.status, 200, JSON.stringify(forgot.data));
    assert.equal(forgot.data.success, true);
    assert.ok(!/exists/.test(forgot.data.message) || /If that account exists/.test(forgot.data.message), 'anti-enumeration wording must stay');

    const row = await waitForDbCode(username, 'reset');
    assert.ok(row, 'a 6-digit reset code must be issued');

    const bad = await call('POST', '/api/reset-password', { body: { username, code: '000000', new_password: 'newpass12' } });
    assert.equal(bad.status === 400 || bad.data.error !== undefined, true, 'a wrong code must fail');

    const done = await call('POST', '/api/reset-password', { body: { username, code: row.code, new_password: 'newpass12' } });
    assert.equal(done.status, 200, JSON.stringify(done.data));

    assert.equal((await call('POST', '/api/user/sync', { token: oldToken })).status, 401, 'reset revokes the old session family');
    assert.equal((await call('POST', '/api/login', { body: { username, password: 'newpass12' } })).status, 200);

    // Codes are single-use.
    const reuse = await call('POST', '/api/reset-password', { body: { username, code: row.code, new_password: 'another12' } });
    assert.equal(reuse.status, 400);
});

test('forgot-password never reveals whether the account exists', async () => {
    const a = await call('POST', '/api/forgot-password', { body: { username: `ghost.${Date.now()}@nope.test` } });
    assert.equal(a.status, 200);
    assert.equal(a.data.success, true);
});

test('email verification end-to-end with the 6-digit code', async () => {
    const username = `verify.${Date.now()}@test.com`;
    const reg = await call('POST', '/api/register', { body: { username, password: 'pw123456' } });
    const token = reg.data.token;

    const req = await call('POST', '/api/email/request-verification', { token });
    assert.equal(req.status, 200, JSON.stringify(req.data));

    const row = await waitForDbCode(username, 'verify');
    assert.ok(row, 'verification code issued');

    assert.equal((await call('POST', '/api/email/verify', { token, body: { code: '123456' } })).status === 400, true);
    const ok = await call('POST', '/api/email/verify', { token, body: { code: row.code } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));

    const sync = await call('POST', '/api/user/sync', { token });
    assert.equal(sync.data.user.email_verified, true, 'serializeUser must surface email_verified after verification');
});

test('welcome/reset/verify email templates carry the app-install footer block', () => {
    // Template-level guarantee — pure render, no server needed.
    const { renderEmail } = require('../mailer');
    const { html } = renderEmail({
        title: 'Welcome to Access Wealth HQ',
        greeting: 'Hi,',
        paragraphs: ['Your account is ready.']
    });
    assert.match(html, /#112A46/, 'footer band must be deep blue #112A46');
    assert.match(html, /#d4af37/, 'footer button must be gold #d4af37');
    assert.match(html, /#0b1421/, 'button text must be #0b1421');
    assert.match(html, /Get the Access Wealth app/, 'footer heading');
    assert.match(html, /Open on your phone and choose Install app — works offline\./, 'exact footer copy');
    assert.match(html, /https:\/\/accesswealthhq\.com\/login\.html/, 'install link (pre-Play-listing)');
});
