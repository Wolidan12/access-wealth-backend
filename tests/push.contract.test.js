// Web Push contract for the installed app (PWA + Android TWA).
//
// A fake web-push module is injected into require.cache so delivery,
// pruning, urgency and payload shape are asserted deterministically —
// without any real push service. Quiet-hours logic is driven by the
// test-only PUSH_NOW_OVERRIDE clock hook (NODE_ENV=test only).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---- stub web-push BEFORE anything requires it ---- */
const pushCalls = [];
const failRules = new Map(); // endpoint → statusCode (e.g. 410) to simulate dead subscriptions

const wpPath = require.resolve('web-push');
require.cache[wpPath] = {
    id: wpPath,
    filename: wpPath,
    loaded: true,
    exports: {
        generateVAPIDKeys: () => ({ publicKey: 'BTestPublicKey', privateKey: 'test-private' }),
        setVapidDetails: () => {},
        sendNotification: async (subscription, payloadText, options) => {
            pushCalls.push({ subscription, payload: JSON.parse(payloadText), options });
            const statusCode = failRules.get(subscription.endpoint);
            if (statusCode) {
                const err = new Error(`push service answered ${statusCode}`);
                err.statusCode = statusCode;
                throw err;
            }
            return { statusCode: 201 };
        }
    }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-wealth-push-test-'));
process.env.JWT_SECRET = 'test-jwt-secret-access-wealth';
process.env.NODE_ENV = 'test';
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
process.env.PORT = '0';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'AdminPush1!';
process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey_AccessWealthHQ_0123456789abcdef0123456789abcdef0123456789abcdef01';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';
process.env.VAPID_SUBJECT = 'mailto:test@accesswealthhq.com';

const { startServer, dbReady, dbGetAsync, pushService } = require('../server');
const { isQuietHours, nextQuietExit } = require('../push');

let server;
let baseUrl;
let userToken;
let adminToken;
const USERNAME = `push.user.${Date.now()}@test.com`;

const EP1 = 'http://127.0.0.1:9876/fake/push/device-1';
const EP2 = 'http://127.0.0.1:9876/fake/push/device-2';

async function call(method, urlPath, { token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = JSON.parse(await res.text());
    return { status: res.status, data };
}

async function waitForSchema() {
    await dbReady;
    for (let i = 0; i < 40; i += 1) {
        const row = await dbGetAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'`).catch(() => null);
        if (row) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('push schema did not initialize');
}

async function waitForPushes(count, timeoutMs = 3000) {
    const t0 = Date.now();
    while (pushCalls.length < count && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pushCalls.length >= count, `expected >= ${count} push(es) delivered, got ${pushCalls.length}`);
}

async function waitForDb(assertion, timeoutMs = 3000) {
    const t0 = Date.now();
    for (;;) {
        const result = await assertion();
        if (result) return;
        if (Date.now() - t0 > timeoutMs) throw new Error('waitForDb timed out');
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function settlePushSilence(ms = 200) {
    await new Promise((r) => setTimeout(r, ms));
}

async function depositAndApprove(amount) {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f030005fe02fea72b96640000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('amount', String(amount));
    fd.append('transaction_ref', `PUSH-${Date.now()}-${Math.random()}`);
    fd.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png');
    const dep = await fetch(`${baseUrl}/api/request-deposit/upload`, { method: 'POST', headers: { Authorization: `Bearer ${userToken}` }, body: fd });
    assert.equal(dep.status, 200, 'fixture deposit should submit');
    const list = await call('GET', '/api/admin/deposits?status=pending', { token: adminToken });
    const id = list.data.deposits[0].id;
    const ok = await call('POST', '/api/admin/approve-deposit', { token: adminToken, body: { depositId: id } });
    assert.equal(ok.status, 200);
}

before(async () => {
    server = await new Promise((resolve) => {
        const s = startServer(0, '127.0.0.1');
        s.on('listening', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await waitForSchema();

    for (let i = 0; i < 60 && !adminToken; i += 1) {
        const login = await call('POST', '/api/login', { body: { username: 'admin@accesswealth.com', password: 'AdminPush1!' } });
        if (login.status === 200) adminToken = login.data.token;
        else await new Promise((r) => setTimeout(r, 100));
    }
    const reg = await call('POST', '/api/register', { body: { username: USERNAME, password: 'pw123456' } });
    userToken = reg.data.token;
});

after(() => new Promise((resolve) => server.close(resolve)));

/* ---------------- endpoint contract ---------------- */

test('GET /api/push/vapid-public-key → { success, enabled, publicKey } JSON, public', async () => {
    const res = await call('GET', '/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.enabled, true);
    assert.equal(typeof res.data.publicKey, 'string');
    assert.ok(res.data.publicKey.length > 20);
});

test('subscribe requires auth and stores { endpoint, keys.{p256dh,auth} } per user', async () => {
    const noAuth = await call('POST', '/api/push/subscribe', { body: { endpoint: EP1, keys: { p256dh: 'p', auth: 'a' } } });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.data.success, false);
    assert.equal(typeof noAuth.data.error, 'string');

    const sub = await call('POST', '/api/push/subscribe', {
        token: userToken,
        body: { endpoint: EP1, keys: { p256dh: 'p256dh-device1', auth: 'auth-device1' } }
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    assert.equal(sub.data.success, true);
    assert.equal(typeof sub.data.message, 'string');

    const row = await dbGetAsync(`SELECT username, endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?`, [EP1]);
    assert.equal(row.username, USERNAME);
    assert.equal(row.p256dh, 'p256dh-device1');
});

test('re-subscribing the same endpoint upserts (key rotation) — never errors, never duplicates', async () => {
    const again = await call('POST', '/api/push/subscribe', {
        token: userToken,
        body: { endpoint: EP1, keys: { p256dh: 'p256dh-ROTATED', auth: 'auth-device1-v2' } }
    });
    assert.equal(again.status, 200);
    const count = await dbGetAsync(`SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = ?`, [EP1]);
    assert.equal(count.c, 1);
    const row = await dbGetAsync(`SELECT p256dh FROM push_subscriptions WHERE endpoint = ?`, [EP1]);
    assert.equal(row.p256dh, 'p256dh-ROTATED');
});

test('subscription validation rejects bad endpoints/keys with the error envelope', async () => {
    const bad = await call('POST', '/api/push/subscribe', { token: userToken, body: { endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.success, false);
    const evil = await call('POST', '/api/push/subscribe', { token: userToken, body: { endpoint: 'http://evil.example.com/x', keys: { p256dh: 'x', auth: 'y' } } });
    assert.equal(evil.status, 400, 'plain-HTTP non-localhost endpoints are refused');
});

/* ---------------- event pushes ---------------- */

test('deposit approved → immediate money-critical push with {title, body, url} to the member', async () => {
    delete process.env.PUSH_NOW_OVERRIDE; // non-quiet window is default for critical events anyway
    const before = pushCalls.length;
    await depositAndApprove(7000);
    await waitForPushes(before + 1);
    assert.equal(pushCalls.length, before + 1, 'exactly one push for the subscribing device');
    const callObj = pushCalls[before];
    assert.equal(callObj.subscription.endpoint, EP1, 'push targets the member device, not the admin');
    assert.equal(callObj.payload.title, 'Deposit approved');
    assert.match(callObj.payload.body, /₦7,000/);
    assert.equal(callObj.payload.url, '/dashboard.html', 'payload url is an app route');
    assert.equal(callObj.payload.event, 'deposit_approved');
    assert.equal(callObj.options.urgency, 'high');
    assert.ok(callObj.options.TTL > 0);
});

test('plan activation → plan_activated push to /plans.html', async () => {
    const before = pushCalls.length;
    const act = await call('POST', '/api/activate', { token: userToken, body: { package_id: 'starter_basic' } });
    assert.equal(act.status, 200, JSON.stringify(act.data));
    await waitForPushes(before + 1);
    assert.equal(pushCalls.length, before + 1);
    assert.equal(pushCalls[before].payload.event, 'plan_activated');
    assert.equal(pushCalls[before].payload.title, 'Plan activated');
    assert.equal(pushCalls[before].payload.url, '/plans.html');
});

test('money-critical pushes fire even deep in quiet hours (23:45 Lagos)', async () => {
    process.env.PUSH_NOW_OVERRIDE = '2026-08-28T22:45:00.000Z'; // 23:45 Lagos
    assert.equal(isQuietHours(new Date(process.env.PUSH_NOW_OVERRIDE)), true);
    const before = pushCalls.length;
    await depositAndApprove(5000);
    await waitForPushes(before + 1);
    assert.equal(pushCalls.length, before + 1, 'critical money events are exempt from quiet hours');
    delete process.env.PUSH_NOW_OVERRIDE;
});

test('approve-withdrawal pushes NOTHING; complete-withdrawal pushes withdrawal_paid', async () => {
    const wd = await call('POST', '/api/request-withdrawal', {
        token: userToken,
        body: { amount: 3000, wallet_type: 'balance', bank_details: { bank_name: 'T', account_number: '1234567890', account_holder: 'P' } }
    });
    assert.equal(wd.status, 200, JSON.stringify(wd.data));
    const list = await call('GET', '/api/admin/withdrawals?status=pending', { token: adminToken });
    const id = list.data.withdrawals[0].id;

    const before = pushCalls.length;
    assert.equal((await call('POST', '/api/admin/approve-withdrawal', { token: adminToken, body: { id } })).status, 200);
    await settlePushSilence();
    assert.equal(pushCalls.length, before, 'approval (processing) must not notify — money has not landed');

    assert.equal((await call('POST', '/api/admin/complete-withdrawal', { token: adminToken, body: { id } })).status, 200);
    await waitForPushes(before + 1);
    assert.equal(pushCalls.length, before + 1);
    assert.equal(pushCalls[before].payload.event, 'withdrawal_paid');
    assert.equal(pushCalls[before].payload.title, 'Withdrawal paid');
    assert.equal(pushCalls[before].payload.url, '/dashboard.html');
});

/* ---------------- quiet hours (deferral) ---------------- */

test('broadcast during quiet hours is queued, not sent, then flushed at 07:00 Lagos', async () => {
  try {
    process.env.PUSH_NOW_OVERRIDE = '2026-08-28T22:30:00.000Z'; // 23:30 Lagos
    const before = pushCalls.length;
    const bc = await call('POST', '/api/admin/broadcast', { token: adminToken, body: { title: 'Night news', message: 'Quiet-hours test broadcast' } });
    assert.equal(bc.status, 200);
    await settlePushSilence();
    assert.equal(pushCalls.length, before, 'broadcast must NOT be pushed at 23:30');

    const queued = await dbGetAsync(`SELECT title, url FROM push_queue`, []);
    assert.ok(queued, 'a queued push row must exist');
    assert.equal(queued.url, '/announcements.html');

    // Morning comes...
    process.env.PUSH_NOW_OVERRIDE = '2026-08-29T06:05:00.000Z'; // 07:05 Lagos
    // The flush job queries by the REAL clock for due items — the queue row was
    // stored with deliver_at computed from the overridden clock, i.e. 06:00Z.
    const flushed = await pushService.flushDueQueue();
    assert.ok(flushed.flushed >= 1, 'queued broadcast flushes after quiet hours');
    await waitForPushes(before + 1);
    assert.equal(pushCalls.length, before + 1);
    assert.equal(pushCalls[before].payload.title, 'Night news');
    const empty = await dbGetAsync(`SELECT COUNT(*) AS c FROM push_queue`, []);
    assert.equal(empty.c, 0, 'queue drained after flush');
  } finally {
    delete process.env.PUSH_NOW_OVERRIDE;
  }
});

/* ---------------- pruning ---------------- */

test('subscriptions that 404/410 at the push service are pruned', async () => {
  // Broadcasts observe quiet hours; pin the clock to Lagos midday so this
  // prune check is deterministic regardless of wall-clock time.
  process.env.PUSH_NOW_OVERRIDE = '2026-08-28T11:00:00.000Z'; // 12:00 Lagos
  try {
    await call('POST', '/api/push/subscribe', { token: userToken, body: { endpoint: EP2, keys: { p256dh: 'p2', auth: 'a2' } } });
    failRules.set(EP2, 410);

    const before = pushCalls.length;
    await call('POST', '/api/admin/broadcast', { token: adminToken, body: { title: 'Prune test', message: 'Clean dead devices' } });
    await waitForPushes(before + 2); // EP1 (ok) + EP2 (410 → prune)

    await waitForDb(async () => {
        const gone = await dbGetAsync(`SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = ?`, [EP2]);
        return gone.c === 0;
    });
    const alive = await dbGetAsync(`SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = ?`, [EP1]);
    assert.equal(alive.c, 1, 'healthy subscriptions are untouched');
  } finally {
    delete process.env.PUSH_NOW_OVERRIDE;
    failRules.clear();
  }
});

/* ---------------- unsubscribe ---------------- */

test('unsubscribe via POST then DELETE removes the subscription', async () => {
    await call('POST', '/api/push/subscribe', { token: userToken, body: { endpoint: EP2, keys: { p256dh: 'p2', auth: 'a2' } } });

    const byPost = await call('POST', '/api/push/unsubscribe', { token: userToken, body: { endpoint: EP2 } });
    assert.equal(byPost.status, 200);
    assert.equal(byPost.data.removed, 1);

    const delByDelete = await call('DELETE', '/api/push/subscribe', { token: userToken, body: { endpoint: EP1 } });
    assert.equal(delByDelete.status, 200);
    assert.equal(delByDelete.data.removed, 1);

    const left = await dbGetAsync(`SELECT COUNT(*) AS c FROM push_subscriptions`, []);
    assert.equal(left.c, 0);
});

/* ---------------- quiet-hours pure logic ---------------- */

test('quiet-hours boundaries: 23:00+ and before 07:00 Lagos are quiet', () => {
    // Lagos = UTC+1, no DST.
    assert.equal(isQuietHours(new Date('2026-08-28T21:59:00Z', )), false); // 22:59 Lagos
    assert.equal(isQuietHours(new Date('2026-08-28T22:00:00Z')), true);   // 23:00 Lagos
    assert.equal(isQuietHours(new Date('2026-08-29T05:59:00Z')), true);   // 06:59 Lagos
    assert.equal(isQuietHours(new Date('2026-08-29T06:00:00Z')), false);  // 07:00 Lagos

    const fromNight = nextQuietExit(new Date('2026-08-28T22:30:00Z'));    // 23:30 Lagos
    assert.equal(fromNight.toISOString(), '2026-08-29T06:00:00.000Z',    // 07:00 Lagos next morning
        `expected 2026-08-29T06:00:00Z, got ${fromNight.toISOString()}`);
    const earlyMorning = nextQuietExit(new Date('2026-08-29T01:15:00Z')); // 02:15 Lagos
    assert.equal(earlyMorning.toISOString(), '2026-08-29T06:00:00.000Z');
});
