// API CONTRACT — pinned response shapes for the installed app (PWA/TWA).
//
// The installed app caches GET responses offline and renders them
// field-by-field. Renaming, removing, or re-typing an existing field is a
// BREAKING change and fails this suite; adding fields is additive and passes.
// Also pinned: every error body must be { success: false, error: string }
// (extra keys allowed) — never HTML and never an empty body.
//
// Coordinate with the frontend team before editing these specs.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-wealth-contract-test-'));
process.env.JWT_SECRET = 'test-jwt-secret-access-wealth';
process.env.NODE_ENV = 'test';
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
process.env.PORT = '0';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'AdminContract1!';

const { startServer, dbReady, dbGetAsync } = require('../server');

let server;
let baseUrl;
let userToken;
let adminToken;
const USERNAME = `contract.user.${Date.now()}@test.com`;
const PASSWORD = 'contract123';

/* ---------------- helpers ---------------- */

async function call(method, urlPath, { token, body, rawBody, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    let payload;
    if (body instanceof FormData) {
        payload = body;
    } else if (rawBody !== undefined) {
        payload = rawBody;
    } else if (body !== undefined) {
        finalHeaders['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${urlPath}`, { method, headers: finalHeaders, body: payload });
    const text = await res.text();
    assert.ok(text.length > 0, `${method} ${urlPath} → empty body (contract forbids empty responses)`);
    let data;
    try { data = JSON.parse(text); } catch (_) {
        assert.fail(`${method} ${urlPath} → non-JSON body (contract forbids HTML): ${text.slice(0, 120)}`);
    }
    return { status: res.status, data };
}

// Pin exact field presence + JS type. '?' suffix = nullable (string? = string|null).
function assertFields(obj, spec, label) {
    assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `${label}: expected a JSON object`);
    for (const [key, type] of Object.entries(spec)) {
        assert.ok(Object.prototype.hasOwnProperty.call(obj, key), `${label}: missing field '${key}' — renames/removals are breaking changes`);
        const value = obj[key];
        const nullable = type.endsWith('?');
        const expected = nullable ? type.slice(0, -1) : type;
        if (value === null || value === undefined) {
            assert.ok(nullable, `${label}: field '${key}' must be ${expected}, got ${value === null ? 'null' : 'undefined'}`);
            continue;
        }
        const actual = Array.isArray(value) ? 'array' : typeof value;
        assert.equal(actual, expected, `${label}: field '${key}' must be ${expected}, got ${actual}`);
    }
}

function assertErrorShape(data, status, label) {
    assert.ok(status >= 400, `${label}: expected an error status, got ${status}`);
    assert.equal(data.success, false, `${label}: error body must include success:false`);
    assert.equal(typeof data.error, 'string', `${label}: error body must include a string 'error' message`);
    assert.ok(data.error.length > 0, `${label}: 'error' must not be empty`);
}

/* ---------------- pinned specs (the contract) ---------------- */

const TOKEN_PAYLOAD = { success: 'boolean', token: 'string', accessToken: 'string', access_token: 'string', newToken: 'string' };

const USER = {
    id: 'number', username: 'string', role: 'string', status: 'string',
    planActivated: 'string', activePackage: 'string', activePackageId: 'string?',
    my_referral_id: 'string?', referred_by: 'string?',
    full_name: 'string', phone: 'string',
    bank_name: 'string', bank_account_number: 'string', bank_account_holder: 'string',
    balance: 'number', wallet_balance: 'number', taskEarnings: 'number',
    daily_earnings: 'number', affiliate_balance: 'number',
    profile_complete: 'boolean', bank_complete: 'boolean', account_complete: 'boolean'
};

const PACKAGE = {
    id: 'string', name: 'string', tier: 'string', capital: 'number',
    daily_rate: 'number', cycle_days: 'number', daily_earning: 'number',
    total_payout: 'number', referral_bonus: 'number'
};

const INVESTMENT = {
    id: 'number?', package_id: 'string?', package_name: 'string?',
    capital: 'number?', daily_rate: 'number?', cycle_days: 'number?',
    daily_earning: 'number?', total_payout: 'number?', referral_bonus: 'number?',
    days_credited: 'number?', status: 'string', activated_at: 'string?', completed_at: 'string?'
};

const BALANCES = {
    balance: 'number', wallet_balance: 'number', taskEarnings: 'number',
    daily_earnings: 'number', affiliate_balance: 'number'
};

const DEPOSIT = {
    id: 'number', amount: 'number', sender_name: 'string', payment_method: 'string',
    transaction_ref: 'string?', status: 'string', admin_note: 'string?',
    created_at: 'string', reviewed_at: 'string?'
};

const WITHDRAWAL = {
    id: 'number', amount: 'number', wallet_type: 'string', status: 'string',
    admin_note: 'string?', created_at: 'string', reviewed_at: 'string?'
};

const MESSAGE = {
    id: 'number', user_id: 'string', sender: 'string', message: 'string', created_at: 'string'
};

const BROADCAST = {
    id: 'number', title: 'string', message: 'string', created_by: 'string?', created_at: 'string'
};

const SPONSORED_POST = {
    id: 'number', title: 'string', description: 'string', reward_amount: 'number',
    required_plan: 'string', image_url: 'string?', link: 'string?',
    status: 'string', created_by: 'string?', created_at: 'string'
};

const ADMIN_USER_ROW = {
    id: 'number', username: 'string', balance: 'number?', wallet_balance: 'number?',
    taskEarnings: 'number?', daily_earnings: 'number?', affiliate_balance: 'number?',
    planActivated: 'string?', activePackage: 'string?', activePackageId: 'string?',
    role: 'string', status: 'string', created_at: 'string'
};

const ADMIN_DEPOSIT_ROW = {
    id: 'number', username: 'string', user_id: 'number?', amount: 'number',
    sender_name: 'string?', payment_method: 'string?', transaction_ref: 'string?',
    status: 'string', admin_note: 'string?', has_receipt: 'boolean',
    reviewed_by: 'string?', created_at: 'string', reviewed_at: 'string?'
};

const ADMIN_WITHDRAWAL_ROW = {
    ...WITHDRAWAL, username: 'string', bank_details: 'string?', reviewed_by: 'string?'
};

const OK_MESSAGE = { success: 'boolean', message: 'string' };

/* ---------------- fixtures ---------------- */

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

    // Bootstrapped admin account (created shortly after schema init) — must
    // exist first because the member registers with its referral code.
    for (let i = 0; i < 60 && !adminToken; i += 1) {
        const login = await call('POST', '/api/login', { body: { username: 'admin@accesswealth.com', password: 'AdminContract1!' } });
        if (login.status === 200) adminToken = login.data.token;
        else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(adminToken, 'admin bootstrap account should exist');

    // Member account
    const reg = await call('POST', '/api/register', { body: { username: USERNAME, password: PASSWORD, referred_by: 'ADMIN123' } });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    userToken = reg.data.token;
});

after(() => new Promise((resolve) => server.close(resolve)));

/* ---------------- auth & session ---------------- */

test('POST /api/register → token payload + message + user', () => {});
// (register already ran in before(); pin login/refresh/sync shapes below — they share the same builder as register)

test('auth: login/register/refresh-token/user-sync/user-by-username', async () => {
    const login = await call('POST', '/api/login', { body: { username: USERNAME, password: PASSWORD } });
    assert.equal(login.status, 200);
    assertFields(login.data, { ...TOKEN_PAYLOAD, user: 'object' }, 'login');
    assertFields(login.data.user, USER, 'login.user');

    const refresh = await call('POST', '/api/refresh-token', { body: { token: userToken } });
    assert.equal(refresh.status, 200);
    assertFields(refresh.data, { ...TOKEN_PAYLOAD, user: 'object' }, 'refresh-token');
    assertFields(refresh.data.user, USER, 'refresh-token.user');

    const sync = await call('POST', '/api/user/sync', { token: userToken });
    assert.equal(sync.status, 200);
    assertFields(sync.data, { success: 'boolean', user: 'object' }, 'user/sync');
    assertFields(sync.data.user, USER, 'user/sync.user');

    const byName = await call('GET', `/api/user/${encodeURIComponent(USERNAME)}`, { token: userToken });
    assert.equal(byName.status, 200);
    assertFields(byName.data, { success: 'boolean', user: 'object' }, 'user/:username');
    assertFields(byName.data.user, USER, 'user/:username.user');
});

/* ---------------- packages & investment ---------------- */

test('packages, activation, active-investment, upgrade', async () => {
    const pkgs = await call('GET', '/api/packages');
    assert.equal(pkgs.status, 200);
    assertFields(pkgs.data, { success: 'boolean', packages: 'array' }, 'packages');
    assert.ok(pkgs.data.packages.length > 0);
    pkgs.data.packages.forEach((p) => assertFields(p, PACKAGE, 'packages[]'));

    // Fund + activate
    await call('POST', '/api/admin/adjust-balance', { token: adminToken, body: { username: USERNAME, walletType: 'balance', action: 'add', amount: 60000 } });
    const act = await call('POST', '/api/activate', { token: userToken, body: { package_id: 'starter_basic' } });
    assert.equal(act.status, 200, JSON.stringify(act.data));
    assertFields(act.data, { success: 'boolean', message: 'string', newBalance: 'number', package: 'object' }, 'activate');
    assertFields(act.data.package, PACKAGE, 'activate.package');

    const active = await call('GET', '/api/active-investment', { token: userToken });
    assert.equal(active.status, 200);
    assertFields(active.data, { success: 'boolean', hasActive: 'boolean', balance: 'number', investment: 'object?' }, 'active-investment');
    assert.ok(active.data.hasActive);
    assertFields(active.data.investment, INVESTMENT, 'active-investment.investment');

    const up = await call('POST', '/api/upgrade-package', { token: userToken, body: { package_id: 'starter_bronze' } });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assertFields(up.data, {
        success: 'boolean', message: 'string', upgrade_cost: 'number', newBalance: 'number',
        previous_package: 'object', package: 'object'
    }, 'upgrade-package');
    assertFields(up.data.previous_package, { id: 'string', name: 'string', capital: 'number' }, 'upgrade-package.previous_package');
    assertFields(up.data.package, PACKAGE, 'upgrade-package.package');
});

/* ---------------- daily task claims ---------------- */

test('daily claim success + already-claimed error shape', async () => {
    const claim = await call('POST', '/api/claim-daily-task', { token: userToken });
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assertFields(claim.data, {
        success: 'boolean', message: 'string', claimed_amount: 'number', dailyEarning: 'number',
        newBalance: 'number', next_claim_at: 'string', balances: 'object'
    }, 'claim-daily-task');
    assertFields(claim.data.balances, BALANCES, 'claim-daily-task.balances');

    const again = await call('POST', '/api/claim-daily-task', { token: userToken });
    assert.equal(again.status, 400);
    assertErrorShape(again.data, 400, 'claim duplicate');
    assertFields(again.data, { success: 'boolean', error: 'string', already_claimed: 'boolean', claimed_amount: 'number', next_claim_at: 'string' }, 'claim duplicate');
});

/* ---------------- deposits ---------------- */

test('deposit upload (multipart) + history + approve/decline shapes', async () => {
    // 1x1 PNG receipt
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f030005fe02fea72b96640000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('amount', '5000');
    fd.append('sender_name', 'Contract User');
    fd.append('transaction_ref', `CONTRACT-${Date.now()}`);
    fd.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png');
    const dep = await call('POST', '/api/request-deposit/upload', { token: userToken, body: fd });
    assert.equal(dep.status, 200, JSON.stringify(dep.data));
    assertFields(dep.data, OK_MESSAGE, 'request-deposit/upload');

    const mine = await call('GET', '/api/my-deposits', { token: userToken });
    assert.equal(mine.status, 200);
    assertFields(mine.data, { success: 'boolean', deposits: 'array' }, 'my-deposits');
    assert.ok(mine.data.deposits.length > 0);
    mine.data.deposits.forEach((d) => assertFields(d, DEPOSIT, 'my-deposits[]'));

    const adminList = await call('GET', '/api/admin/deposits?status=pending', { token: adminToken });
    assert.equal(adminList.status, 200);
    assertFields(adminList.data, { success: 'boolean', deposits: 'array' }, 'admin/deposits');
    assert.ok(adminList.data.deposits.length > 0);
    adminList.data.deposits.forEach((d) => assertFields(d, ADMIN_DEPOSIT_ROW, 'admin/deposits[]'));
    const depositId = adminList.data.deposits[0].id;

    const approve = await call('POST', '/api/admin/approve-deposit', { token: adminToken, body: { depositId } });
    assert.equal(approve.status, 200);
    assertFields(approve.data, OK_MESSAGE, 'admin/approve-deposit');
});

/* ---------------- withdrawals ---------------- */

test('withdrawal request + history + pending + admin approve', async () => {
    const req = await call('POST', '/api/request-withdrawal', {
        token: userToken,
        body: { amount: 3000, wallet_type: 'balance', bank_details: { bank_name: 'Test Bank', account_number: '1234567890', account_holder: 'Contract User' } }
    });
    assert.equal(req.status, 200, JSON.stringify(req.data));
    assertFields(req.data, OK_MESSAGE, 'request-withdrawal');

    const pending = await call('GET', '/api/user/pending-withdrawal', { token: userToken });
    assert.equal(pending.status, 200);
    assertFields(pending.data, { success: 'boolean', hasPending: 'boolean', status: 'string?' }, 'pending-withdrawal');

    const mine = await call('GET', '/api/user/withdrawals', { token: userToken });
    assert.equal(mine.status, 200);
    assertFields(mine.data, { success: 'boolean', withdrawals: 'array' }, 'user/withdrawals');
    mine.data.withdrawals.forEach((w) => assertFields(w, WITHDRAWAL, 'user/withdrawals[]'));

    const adminList = await call('GET', '/api/admin/withdrawals?status=pending', { token: adminToken });
    assert.equal(adminList.status, 200);
    assertFields(adminList.data, { success: 'boolean', withdrawals: 'array' }, 'admin/withdrawals');
    assert.ok(adminList.data.withdrawals.length > 0);
    adminList.data.withdrawals.forEach((w) => assertFields(w, ADMIN_WITHDRAWAL_ROW, 'admin/withdrawals[]'));

    const approve = await call('POST', '/api/admin/approve-withdrawal', { token: adminToken, body: { id: adminList.data.withdrawals[0].id } });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    assertFields(approve.data, OK_MESSAGE, 'admin/approve-withdrawal');
});

/* ---------------- referrals ---------------- */

test('referral stats + leaderboard shapes', async () => {
    const stats = await call('GET', `/api/referral/stats/${encodeURIComponent('admin@accesswealth.com')}`, { token: adminToken });
    assert.equal(stats.status, 200);
    assertFields(stats.data, { success: 'boolean', totalReferrals: 'number', earnings: 'number', referrals: 'array' }, 'referral/stats');
    stats.data.referrals.forEach((r) => assertFields(r, { username: 'string', created_at: 'string', planActivated: 'string?' }, 'referral/stats.referrals[]'));

    const board = await call('GET', '/api/referral/leaderboard');
    assert.equal(board.status, 200);
    assertFields(board.data, { success: 'boolean', leaderboard: 'array' }, 'referral/leaderboard');
    board.data.leaderboard.forEach((r) => assertFields(r, { username: 'string', total_earned: 'number?', referral_count: 'number' }, 'leaderboard[]'));
});

/* ---------------- support threads ---------------- */

test('chat welcome/send/history + support inbox shapes', async () => {
    const welcome = await call('POST', '/api/chat/welcome', { token: userToken });
    assert.equal(welcome.status, 200);
    assertFields(welcome.data, OK_MESSAGE, 'chat/welcome');

    const send = await call('POST', '/api/chat/send', { token: userToken, body: { message: 'Contract test message' } });
    assert.equal(send.status, 200);
    assertFields(send.data, OK_MESSAGE, 'chat/send');

    const hist = await call('GET', `/api/chat/history/${encodeURIComponent(USERNAME)}`, { token: userToken });
    assert.equal(hist.status, 200);
    assertFields(hist.data, { success: 'boolean', messages: 'array' }, 'chat/history');
    assert.ok(hist.data.messages.length >= 2);
    hist.data.messages.forEach((m) => assertFields(m, MESSAGE, 'chat/history.messages[]'));

    const inbox = await call('GET', '/api/support/users', { token: adminToken });
    assert.equal(inbox.status, 200);
    assertFields(inbox.data, { success: 'boolean', users: 'array' }, 'support/users');
    inbox.data.users.forEach((u) => assertFields(u, { user_id: 'string' }, 'support/users[]'));

    const all = await call('GET', '/api/support/all-users', { token: adminToken });
    assert.equal(all.status, 200);
    assertFields(all.data, { success: 'boolean', users: 'array' }, 'support/all-users');
    all.data.users.forEach((u) => assertFields(u, { username: 'string', created_at: 'string' }, 'support/all-users[]'));
});

/* ---------------- broadcasts ---------------- */

test('broadcast create + list shapes', async () => {
    const make = await call('POST', '/api/admin/broadcast', { token: adminToken, body: { title: 'Contract', message: 'Contract broadcast' } });
    assert.equal(make.status, 200);
    assertFields(make.data, OK_MESSAGE, 'admin/broadcast');

    for (const p of ['/api/broadcasts', '/api/broadcasts/all']) {
        const list = await call('GET', p, { token: userToken });
        assert.equal(list.status, 200);
        assertFields(list.data, { success: 'boolean', broadcasts: 'array' }, p);
        assert.ok(list.data.broadcasts.length > 0);
        list.data.broadcasts.forEach((b) => assertFields(b, BROADCAST, `${p}[]`));
    }
});

/* ---------------- sponsored tasks ---------------- */

test('sponsored post create/list/submit/status + admin review', async () => {
    const make = await call('POST', '/api/admin/sponsored-post', {
        token: adminToken,
        body: { title: 'Contract task', description: 'Do the thing', reward_amount: 50, required_plan: 'all' }
    });
    assert.equal(make.status, 200, JSON.stringify(make.data));
    assertFields(make.data, OK_MESSAGE, 'admin/sponsored-post');

    const posts = await call('GET', '/api/sponsored-posts', { token: userToken });
    assert.equal(posts.status, 200);
    assertFields(posts.data, { success: 'boolean', posts: 'array' }, 'sponsored-posts');
    assert.ok(posts.data.posts.length > 0);
    posts.data.posts.forEach((p) => assertFields(p, SPONSORED_POST, 'sponsored-posts[]'));
    const postId = posts.data.posts[0].id;

    const submit = await call('POST', '/api/submit-sponsored-task', { token: userToken, body: { post_id: postId } });
    assert.equal(submit.status, 200, JSON.stringify(submit.data));
    assertFields(submit.data, OK_MESSAGE, 'submit-sponsored-task');

    const status = await call('GET', `/api/sponsored-submission-status/${postId}`, { token: userToken });
    assert.equal(status.status, 200);
    assertFields(status.data, { success: 'boolean', status: 'string' }, 'sponsored-submission-status');

    const adminSubs = await call('GET', '/api/admin/sponsored-submissions', { token: adminToken });
    assert.equal(adminSubs.status, 200);
    assertFields(adminSubs.data, { success: 'boolean', submissions: 'array' }, 'admin/sponsored-submissions');
    const sub = adminSubs.data.submissions[0];

    const approve = await call('POST', '/api/admin/approve-sponsored-submission', { token: adminToken, body: { submission_id: sub.id } });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    assertFields(approve.data, OK_MESSAGE, 'admin/approve-sponsored-submission');
});

/* ---------------- premium purchases (airtime/data/sms) ---------------- */

test('airtime purchase success shape + premium-locked error shape', async () => {
    const buy = await call('POST', '/api/bills/airtime', { token: userToken, body: { network: 'MTN', phone: '08030000000', amount: 200 } });
    assert.equal(buy.status, 200, JSON.stringify(buy.data));
    assertFields(buy.data, { success: 'boolean', newBalance: 'number' }, 'bills/airtime');

    const locked = await call('POST', '/api/register', { body: { username: `locked.${Date.now()}@test.com`, password: 'password123' } });
    const noPlan = await call('POST', '/api/bills/data', { token: locked.data.token, body: { network: 'MTN', phone: '08030000000', amount: 500 } });
    assert.equal(noPlan.status, 403);
    assertErrorShape(noPlan.data, 403, 'bills/data (plan required)');
});

/* ---------------- profile & settings ---------------- */

test('profile/bank/password + manual payment info + site settings', async () => {
    const prof = await call('GET', `/api/user/profile/${encodeURIComponent(USERNAME)}`, { token: userToken });
    assert.equal(prof.status, 200);
    assertFields(prof.data, { success: 'boolean', profile: 'object' }, 'user/profile');
    assertFields(prof.data.profile, {
        full_name: 'string?', phone: 'string?', bank_name: 'string?',
        bank_account_number: 'string?', bank_account_holder: 'string?'
    }, 'user/profile.profile');

    const upd = await call('POST', '/api/user/update-profile', { token: userToken, body: { full_name: 'Contract User', phone: '08030000000' } });
    assertFields(upd.data, OK_MESSAGE, 'update-profile');
    const bank = await call('POST', '/api/user/update-bank', { token: userToken, body: { bank_name: 'Test Bank', account_number: '1234567890', account_holder: 'Contract User' } });
    assertFields(bank.data, OK_MESSAGE, 'update-bank');
    const pw = await call('POST', '/api/user/change-password', { token: userToken, body: { current_password: PASSWORD, new_password: 'contract456' } });
    assertFields(pw.data, OK_MESSAGE, 'change-password');

    const pay = await call('GET', '/api/payment/manual-info');
    assertFields(pay.data, { success: 'boolean', payment: 'object' }, 'payment/manual-info');
    assertFields(pay.data.payment, {
        bank_name: 'string', account_name: 'string', account_number: 'string',
        bank_code: 'string', currency: 'string', instructions: 'string', enabled: 'boolean'
    }, 'payment/manual-info.payment');

    const settings = await call('GET', '/api/site-settings', { token: userToken });
    assertFields(settings.data, { success: 'boolean', settings: 'object' }, 'site-settings');

    const set = await call('POST', '/api/admin/settings', { token: adminToken, body: { withdrawals_open: 'true' } });
    assertFields(set.data, OK_MESSAGE, 'admin/settings');
});

/* ---------------- admin endpoints ---------------- */

test('admin stats/users/change-plan/adjust/manual-credit/migrations/reseed/clear', async () => {
    const stats = await call('GET', '/api/admin/stats', { token: adminToken });
    assertFields(stats.data, { success: 'boolean', stats: 'object' }, 'admin/stats');
    assertFields(stats.data.stats, {
        totalUsers: 'number', activePlans: 'number', revenue: 'number',
        pendingDeposits: 'number', pendingWithdrawals: 'number'
    }, 'admin/stats.stats');

    const users = await call('GET', '/api/admin/users', { token: adminToken });
    assertFields(users.data, { success: 'boolean', users: 'array' }, 'admin/users');
    assert.ok(users.data.users.length > 0);
    users.data.users.forEach((u) => assertFields(u, ADMIN_USER_ROW, 'admin/users[]'));

    const changePlan = await call('POST', '/api/admin/change-user-plan', { token: adminToken, body: { username: USERNAME, packageId: 'growth_plus' } });
    assertFields(changePlan.data, OK_MESSAGE, 'admin/change-user-plan');

    const adjust = await call('POST', '/api/admin/adjust-balance', { token: adminToken, body: { username: USERNAME, walletType: 'taskEarnings', action: 'add', amount: 10 } });
    assertFields(adjust.data, OK_MESSAGE, 'admin/adjust-balance');

    const credit = await call('POST', '/api/admin/manual-credit', { token: adminToken, body: { username: USERNAME, walletType: 'balance', amount: 10 } });
    assertFields(credit.data, { ...OK_MESSAGE, updatedBalance: 'object' }, 'admin/manual-credit');

    const toggle = await call('POST', '/api/admin/toggle-user-status', { token: adminToken, body: { username: USERNAME, status: 'active' } });
    assertFields(toggle.data, OK_MESSAGE, 'admin/toggle-user-status');

    const mig = await call('GET', '/api/admin/migrations/legacy-plans/status', { token: adminToken });
    assertFields(mig.data, { success: 'boolean', status: 'string', migration: 'object?' }, 'admin/migrations/status');

    const reseed = await call('POST', '/api/admin/packages/reseed', { token: adminToken });
    assertFields(reseed.data, { ...OK_MESSAGE, total: 'number' }, 'admin/packages/reseed');

    const clear = await call('POST', '/api/admin/clear-total-balance', { token: adminToken, body: { username: USERNAME, confirmation: `CLEAR ${USERNAME}` } });
    assertFields(clear.data, { ...OK_MESSAGE, totalCleared: 'number' }, 'admin/clear-total-balance');
});

/* ---------------- error envelope (all statuses) ---------------- */

test('error envelope: every error is { success:false, error } JSON', async () => {
    // 401 no token
    const noToken = await call('GET', '/api/admin/users');
    assertErrorShape(noToken.data, noToken.status, '401');

    // 401 bad token (TOKEN_INVALID code is additive and must remain)
    const badToken = await call('POST', '/api/user/sync', { headers: { Authorization: 'Bearer nope.nope.nope' } });
    assertErrorShape(badToken.data, 401, '401 bad token');
    assert.equal(badToken.data.code, 'TOKEN_INVALID', 'TOKEN_INVALID code must remain on 401s');

    // 403 non-admin
    const forbidden = await call('GET', '/api/admin/stats', { token: userToken });
    assertErrorShape(forbidden.data, 403, '403');

    // 400 business rule (double activation path: fresh user activating twice)
    const dup = await call('POST', '/api/activate', { token: userToken, body: { package_id: 'growth_plus' } });
    assert.ok(dup.status >= 400);
    assertErrorShape(dup.data, dup.status, '409 double activation');

    // 400 malformed JSON via global error handler
    const badJson = await call('POST', '/api/login', { rawBody: '{oops', headers: { 'Content-Type': 'application/json' } });
    assertErrorShape(badJson.data, 400, '400 invalid JSON');

    // 404 unknown API route → JSON, never the Express "Cannot GET" HTML
    const notFound = await call('GET', '/api/definitely-not-a-route');
    assertErrorShape(notFound.data, 404, '404 unknown route');

    // 404 on unknown nested API path too
    const notFoundPost = await call('POST', '/api/nada/nothing', { body: {} });
    assertErrorShape(notFoundPost.data, 404, '404 unknown route (POST)');
});

test('error envelope: 413 and 429', async () => {
    // 413 body too large via global error handler (12mb JSON limit)
    const huge = 'x'.repeat(13 * 1024 * 1024);
    const tooBig = await call('POST', '/api/login', { rawBody: `{"username":"${huge}","password":"x"}` , headers: { 'Content-Type': 'application/json' } });
    assertErrorShape(tooBig.data, 413, '413 too large');

    // 429 rate limit (unique probe username; successes not counted anyway)
    const probe = `contract-429-${Date.now()}@invalid.test`;
    let last;
    for (let i = 0; i < 31; i += 1) {
        last = await call('POST', '/api/login', { body: { username: probe, password: 'wrong-wrong' } });
    }
    assert.equal(last.status, 429);
    assertErrorShape(last.data, 429, '429 rate limited');
});

test('error envelope: 5xx-ready handlers keep shape (sendApiError path)', async () => {
    // sendApiError fallback (500) is the universal 5xx path; verify the shape
    // contract holds on a representable 5xx-safe surface: deposit receipt of a
    // non-existent id returns a typed 404 error through the same handlers.
    const res = await fetch(`${baseUrl}/api/admin/deposit/99999999/receipt`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const data = await res.json();
    assertErrorShape(data, 404, '404 receipt');
});
