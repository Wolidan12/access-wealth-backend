const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-wealth-test-'));
process.env.JWT_SECRET = 'test-jwt-secret-access-wealth';
process.env.NODE_ENV = 'test';
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
process.env.PORT = '0';

const {
    app,
    db,
    dbReady,
    dbRunAsync,
    dbGetAsync,
    JWT_ISSUER,
    JWT_AUDIENCE
} = require('../server');

let server;
let baseUrl;

async function request(method, urlPath, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = { raw: text };
    }
    return { status: response.status, data };
}

async function registerUser(username) {
    const password = 'password123';
    const registered = await request('POST', '/api/register', {
        body: { username, password }
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.data));
    assert.equal(registered.data.success, true);
    return { username, password, token: registered.data.token, user: registered.data.user };
}

async function waitForSchema() {
    await dbReady;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const row = await dbGetAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`);
            if (row) {
                await dbGetAsync('SELECT id FROM investment_packages LIMIT 1');
                return;
            }
        } catch (_) {
            // schema still applying
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Database schema did not become ready in time');
}

before(async () => {
    await waitForSchema();
    server = await new Promise((resolve) => {
        const httpServer = app.listen(0, '127.0.0.1', () => resolve(httpServer));
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => db.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('current-plan user successfully claims daily earnings', async () => {
    const account = await registerUser(`current_${Date.now()}@example.com`);
    const userRow = await dbGetAsync('SELECT id FROM users WHERE username = ?', [account.username]);

    await dbRunAsync(
        `UPDATE users SET planActivated = 'true', activePackage = 'Growth Plus', activePackageId = 'growth_plus' WHERE id = ?`,
        [userRow.id]
    );
    await dbRunAsync(
        `INSERT INTO user_investments
         (user_id, username, package_id, package_name, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
         VALUES (?, ?, 'growth_plus', 'Growth Plus', 10000, 0.04, 15, 400, 16000, 5000, 0, 'active', datetime('now'))`,
        [userRow.id, account.username]
    );

    const active = await request('GET', '/api/active-investment', { token: account.token });
    assert.equal(active.status, 200);
    assert.equal(active.data.success, true);
    assert.equal(active.data.hasActive, true);
    assert.equal(active.data.investment.package_id, 'growth_plus');
    assert.equal(active.data.investment.daily_earning, 400);

    const claim = await request('POST', '/api/claim-daily-task', { token: account.token });
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.equal(claim.data.success, true);
    assert.equal(claim.data.dailyEarning, 400);
    assert.equal(claim.data.newBalance, 400);
    assert.ok(claim.data.next_claim_at);
});

test('legacy-plan user successfully claims daily earnings', async () => {
    const account = await registerUser(`legacy_${Date.now()}@example.com`);
    const userRow = await dbGetAsync('SELECT id FROM users WHERE username = ?', [account.username]);

    // No user_investments row — only the historical user-level plan fields.
    await dbRunAsync(
        `UPDATE users SET planActivated = 'true', activePackage = 'Growth Plus', activePackageId = NULL WHERE id = ?`,
        [userRow.id]
    );

    const login = await request('POST', '/api/login', {
        body: { username: account.username, password: account.password }
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.planActivated, 'true');
    assert.equal(login.data.user.activePackage, 'Growth Plus');
    assert.equal(login.data.user.activePackageId, 'growth_plus');

    const sync = await request('POST', '/api/user/sync', { token: login.data.token });
    assert.equal(sync.status, 200);
    assert.equal(sync.data.user.planActivated, 'true');
    assert.equal(sync.data.user.activePackage, 'Growth Plus');

    const active = await request('GET', '/api/active-investment', { token: login.data.token });
    assert.equal(active.status, 200);
    assert.equal(active.data.hasActive, true);
    assert.equal(active.data.investment.package_name, 'Growth Plus');
    assert.equal(active.data.investment.daily_earning, 400);
    assert.equal(active.data.investment.capital, 10000);

    const claim = await request('POST', '/api/claim-daily-task', { token: login.data.token });
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.equal(claim.data.success, true);
    assert.equal(claim.data.dailyEarning, 400);
    assert.equal(claim.data.newBalance, 400);
    assert.ok(claim.data.next_claim_at);
});

test('user with no plan is denied', async () => {
    const account = await registerUser(`none_${Date.now()}@example.com`);
    const active = await request('GET', '/api/active-investment', { token: account.token });
    assert.equal(active.status, 200);
    assert.equal(active.data.success, true);
    assert.equal(active.data.hasActive, false);
    assert.equal(active.data.investment, null);

    const claim = await request('POST', '/api/claim-daily-task', { token: account.token });
    assert.equal(claim.status, 403);
    assert.match(String(claim.data.error || ''), /activate/i);
});

test('second claim inside 24 hours is denied', async () => {
    const account = await registerUser(`twice_${Date.now()}@example.com`);
    const userRow = await dbGetAsync('SELECT id FROM users WHERE username = ?', [account.username]);
    await dbRunAsync(
        `UPDATE users SET planActivated = 'true', activePackage = 'Starter Basic', activePackageId = 'starter_basic' WHERE id = ?`,
        [userRow.id]
    );
    await dbRunAsync(
        `INSERT INTO user_investments
         (user_id, username, package_id, package_name, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
         VALUES (?, ?, 'starter_basic', 'Starter Basic', 500, 0.03, 10, 15, 650, 250, 0, 'active', datetime('now'))`,
        [userRow.id, account.username]
    );

    const first = await request('POST', '/api/claim-daily-task', { token: account.token });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.dailyEarning, 15);

    const second = await request('POST', '/api/claim-daily-task', { token: account.token });
    assert.equal(second.status, 400);
    assert.equal(second.data.already_claimed, true);
});

test('expired token returns HTTP 401, then refresh and retry succeed', async () => {
    const account = await registerUser(`expired_${Date.now()}@example.com`);
    const userRow = await dbGetAsync('SELECT * FROM users WHERE username = ?', [account.username]);
    await dbRunAsync(
        `UPDATE users SET planActivated = 'true', activePackage = 'Starter Bronze', activePackageId = 'starter_bronze' WHERE id = ?`,
        [userRow.id]
    );
    await dbRunAsync(
        `INSERT INTO user_investments
         (user_id, username, package_id, package_name, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
         VALUES (?, ?, 'starter_bronze', 'Starter Bronze', 1500, 0.03, 10, 45, 1950, 750, 0, 'active', datetime('now'))`,
        [userRow.id, account.username]
    );

    const expiredToken = jwt.sign(
        { id: userRow.id, username: userRow.username, role: 'user' },
        process.env.JWT_SECRET,
        { expiresIn: '-10s', issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
    );

    const denied = await request('POST', '/api/claim-daily-task', { token: expiredToken });
    assert.equal(denied.status, 401);
    assert.equal(denied.data.code, 'TOKEN_INVALID');

    const refreshed = await request('POST', '/api/refresh-token', { token: expiredToken });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
    const freshToken = refreshed.data.token
        || refreshed.data.accessToken
        || refreshed.data.access_token
        || refreshed.data.newToken;
    assert.ok(freshToken);
    assert.equal(refreshed.data.user.planActivated, 'true');
    assert.equal(refreshed.data.user.activePackage, 'Starter Bronze');

    const retry = await request('POST', '/api/claim-daily-task', { token: freshToken });
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.success, true);
    assert.equal(retry.data.dailyEarning, 45);
    assert.equal(retry.data.newBalance, 45);
});
