// Web Push service for Access Wealth HQ.
//
// Responsibilities:
//   - VAPID wiring from env (push is disabled gracefully when keys are unset)
//   - subscription persistence (one row per browser/device endpoint)
//   - event pushes: deposit approved, withdrawal paid, plan activated/upgraded,
//     broadcast alerts — payload shape { title, body, url }
//   - Nigeria quiet hours (23:00–07:00 Africa/WAT, no DST): critical money
//     events push immediately; non-critical events (broadcasts) are queued and
//     flushed when quiet hours end
//   - pruning: subscriptions whose push service answers 404/410 are deleted
//
// The module never throws into request handlers: push failures are logged and
// swallowed so an unreachable push service can never fail a money route.

let webpush = null;
try {
    webpush = require('web-push');
} catch (error) {
    console.warn('[push] web-push module unavailable; push notifications disabled:', error.message);
}

const NOTIFICATIONS_OFF = {
    enabled: false,
    publicKey: null
};

// tzNow: render the current wall-clock in the target timezone as UTC-shifted
// Date fields (Africa/Lagos = WAT, UTC+1 year-round, no DST changes).
function tzParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit', minute: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (t) => Number((parts.find((p) => p.type === t) || {}).value);
    return { minutes: get('hour') % 24 * 60 + get('minute') };
}

const QUIET_START_MIN = 23 * 60; // 23:00 inclusive
const QUIET_END_MIN = 7 * 60;    // quiet until 07:00 (exclusive)

// Pure functions — exported for tests.
function isQuietHours(date = new Date(), timeZone = 'Africa/Lagos') {
    const { minutes } = tzParts(date, timeZone);
    return minutes >= QUIET_START_MIN || minutes < QUIET_END_MIN;
}

// Next instant (UTC Date) when quiet hours end at/after `date` in timeZone.
function nextQuietExit(date = new Date(), timeZone = 'Africa/Lagos') {
    // Lagos has no DST; compute with a fixed +60min offset.
    const offsetMs = tzOffsetMs(timeZone, date);
    const shifted = new Date(date.getTime() + offsetMs);   // UTC fields read as Lagos wall clock
    const exit = new Date(shifted);
    exit.setUTCHours(QUIET_END_MIN / 60, 0, 0, 0);          // 07:00 wall clock
    if (shifted.getTime() >= exit.getTime()) {
        exit.setUTCDate(exit.getUTCDate() + 1);             // next morning
    }
    return new Date(exit.getTime() - offsetMs);
}

function tzOffsetMs(timeZone, date) {
    // ICU offset for the zone at that instant (stable for WAT: constant +1h).
    const utcGuess = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzGuess = new Date(date.toLocaleString('en-US', { timeZone }));
    return tzGuess.getTime() - utcGuess.getTime();
}

// Which event kinds may interrupt users at night.
// Money-critical = confirms funds moved; sent regardless of quiet hours.
const EVENT_POLICY = {
    deposit_approved: { critical: true, url: '/dashboard.html' },
    withdrawal_paid: { critical: true, url: '/dashboard.html' },
    plan_activated: { critical: true, url: '/plans.html' },
    plan_upgraded: { critical: true, url: '/plans.html' },
    broadcast: { critical: false, url: '/announcements.html' }
};

function createPushService({ dbRunAsync, dbAllAsync, dbGetAsync, now }) {
    const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
    const subject = String(process.env.VAPID_SUBJECT || 'mailto:admin@accesswealthhq.com').trim();
    const timeZone = String(process.env.APP_TIME_ZONE || 'Africa/Lagos').trim() || 'Africa/Lagos';
    const enabled = Boolean(webpush && publicKey && privateKey);
    // Test-only clock override (never active outside NODE_ENV=test).
    const clock = now || (() => new Date());

    if (enabled) {
        try {
            webpush.setVapidDetails(subject, publicKey, privateKey);
        } catch (error) {
            console.error('[push] invalid VAPID configuration; push disabled:', error.message);
            return makeDisabledService();
        }
    } else {
        console.warn('[push] VAPID keys not configured — push notifications disabled. Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY.');
    }

    function makeDisabledService() {
        return {
            enabled: false,
            publicKey: null,
            saveSubscription: async () => ({ ok: false, reason: 'disabled' }),
            removeSubscription: async () => 0,
            notifyUser: async () => ({ skipped: 'disabled' }),
            notifyAll: async () => ({ skipped: 'disabled' }),
            flushDueQueue: async () => ({ flushed: 0 }),
            _policy: EVENT_POLICY
        };
    }

    if (!enabled) return makeDisabledService();

    /* ---------------- persistence ---------------- */

    async function saveSubscription({ userId, username, endpoint, p256dh, auth, userAgent }) {
        const nowIso = new Date().toISOString();
        await dbRunAsync(
            `INSERT INTO push_subscriptions (user_id, username, endpoint, p256dh, auth, user_agent, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
                user_id = excluded.user_id,
                username = excluded.username,
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                updated_at = excluded.updated_at`,
            [userId, username, endpoint, p256dh, auth, userAgent || '', nowIso, nowIso]
        );
        return { ok: true };
    }

    async function removeSubscription(endpoint) {
        const result = await dbRunAsync(
            `DELETE FROM push_subscriptions WHERE endpoint = ?`,
            [endpoint]
        );
        return result && typeof result.changes === 'number' ? result.changes : 0;
    }

    /* ---------------- low-level send with pruning ---------------- */

    async function sendToRow(row, payload) {
        const subscription = {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth }
        };
        try {
            await webpush.sendNotification(subscription, JSON.stringify(payload), {
                TTL: 24 * 60 * 60,
                urgency: payload._critical ? 'high' : 'normal'
            });
            await dbRunAsync(
                `UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE endpoint = ?`,
                [row.endpoint]
            ).catch(() => {});
            return { ok: true };
        } catch (error) {
            const status = error && error.statusCode;
            // 404/410 = subscription is gone/invalid at the push service → prune.
            if (status === 404 || status === 410) {
                await dbRunAsync(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [row.endpoint]).catch(() => {});
                console.warn(`[push] pruned dead subscription (${status}) for ${row.username || 'unknown user'}`);
                return { ok: false, pruned: true };
            }
            console.warn(`[push] send failed for ${row.username || 'unknown user'}: HTTP ${status || '?'} ${error.message}`);
            return { ok: false, error: status || 'network' };
        }
    }

    async function sendToUsernames(usernames, payload) {
        const names = [...new Set(usernames.filter(Boolean))];
        if (!names.length) return { sent: 0 };
        const placeholders = names.map(() => '?').join(',');
        const rows = await dbAllAsync(
            `SELECT endpoint, p256dh, auth, username FROM push_subscriptions WHERE LOWER(username) IN (${names.map(() => 'LOWER(?)').join(',')})`,
            names
        );
        let sent = 0;
        for (const row of rows) {
            const r = await sendToRow(row, payload);
            if (r.ok) sent += 1;
        }
        return { sent, attempted: rows.length };
    }

    /* ---------------- quiet-hours queue ---------------- */

    async function queueBroadcast(payload, deliverAt) {
        await dbRunAsync(
            `INSERT INTO push_queue (target_username, title, body, url, deliver_at) VALUES (NULL, ?, ?, ?, ?)`,
            [payload.title, payload.body, payload.url, deliverAt.toISOString()]
        );
    }

    async function flushDueQueue() {
        // Due-ness uses the same injected clock as the quiet-hours decision, so
        // the queue is internally consistent (and testable).
        const due = await dbAllAsync(
            `SELECT id, target_username, title, body, url FROM push_queue WHERE deliver_at <= ?`,
            [clock().toISOString()]
        );
        let flushed = 0;
        for (const item of due) {
            const payload = { title: item.title, body: item.body, url: item.url };
            const result = item.target_username
                ? await sendToUsernames([item.target_username], { ...payload, event: 'queued_member', _critical: false })
                : await broadcastNow({ ...payload, event: 'broadcast', _critical: false });
            await dbRunAsync(`DELETE FROM push_queue WHERE id = ?`, [item.id]).catch(() => {});
            flushed += 1;
            console.warn(`[push] flushed queued item #${item.id} (sent to ${result.sent} device(s))`);
        }
        return { flushed };
    }

    async function broadcastNow(payload) {
        const rows = await dbAllAsync(
            `SELECT endpoint, p256dh, auth, username FROM push_subscriptions`, []
        );
        let sent = 0;
        for (const row of rows) {
            const r = await sendToRow(row, payload);
            if (r.ok) sent += 1;
        }
        return { sent, attempted: rows.length };
    }

    /* ---------------- public API ---------------- */

    // Direct member-targeted events (deposit approved, withdrawal paid, plan
    // activated/upgraded) are money-critical → always immediate.
    async function notifyUser(username, event, body, overrides = {}) {
        const policy = EVENT_POLICY[event];
        if (!policy) throw new Error(`Unknown push event '${event}'`);
        const payload = {
            title: overrides.title || defaultTitle(event),
            body: String(body || ''),
            url: overrides.url || policy.url,
            event,
            _critical: policy.critical
        };
        if (!policy.critical && isQuietHours(clock(), timeZone)) {
            // Member events are currently all critical; kept for future kinds.
            const deliverAt = nextQuietExit(clock(), timeZone);
            await dbRunAsync(
                `INSERT INTO push_queue (target_username, title, body, url, deliver_at) VALUES (?, ?, ?, ?, ?)`,
                [username, payload.title, payload.body, payload.url, deliverAt.toISOString()]
            );
            return { queued: true, deliverAt: deliverAt.toISOString() };
        }
        return sendToUsernames([username], payload);
    }

    async function notifyAll(body, overrides = {}) {
        const payload = {
            title: overrides.title || 'Access Wealth HQ',
            body: String(body || ''),
            url: overrides.url || EVENT_POLICY.broadcast.url,
            event: 'broadcast',
            _critical: false
        };
        if (isQuietHours(clock(), timeZone)) {
            const deliverAt = nextQuietExit(clock(), timeZone);
            await queueBroadcast(payload, deliverAt);
            return { queued: true, deliverAt: deliverAt.toISOString() };
        }
        return broadcastNow(payload);
    }

    function defaultTitle(event) {
        switch (event) {
            case 'deposit_approved': return 'Deposit approved';
            case 'withdrawal_paid': return 'Withdrawal paid';
            case 'plan_activated': return 'Plan activated';
            case 'plan_upgraded': return 'Plan upgraded';
            default: return 'Access Wealth HQ';
        }
    }

    return {
        enabled: true,
        publicKey,
        saveSubscription,
        removeSubscription,
        notifyUser,
        notifyAll,
        flushDueQueue,
        _policy: EVENT_POLICY
    };
}

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        endpoint TEXT UNIQUE,
        p256dh TEXT,
        auth TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        last_used_at DATETIME
    )`,
    `CREATE TABLE IF NOT EXISTS push_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_username TEXT,
        title TEXT,
        body TEXT,
        url TEXT,
        deliver_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
];

module.exports = {
    createPushService,
    isQuietHours,
    nextQuietExit,
    EVENT_POLICY,
    SCHEMA_STATEMENTS,
    DISABLED_INFO: NOTIFICATIONS_OFF
};
