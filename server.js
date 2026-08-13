require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const sqlite3 = require('./sqlite-compat');
const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Receipt uploads are an optional enhancement. Keep the API available when a
// deployment omits the optional multer package: a missing upload dependency
// must not prevent the process from starting (which would make every endpoint,
// including /api/login, look like a network error to the frontend).
let multer = null;
try {
    multer = require('multer');
} catch (error) {
    console.warn('WARN: multer is unavailable. Multipart receipt uploads are disabled; JSON receipt uploads remain available.', error.message);
}

const app = express();

// SQLite transactions span multiple awaited statements. Keep all direct
// database calls behind a small process-local gate so another request cannot
// interleave a write between BEGIN and COMMIT on the same connection.
const transactionStorage = new AsyncLocalStorage();
let transactionTail = Promise.resolve();

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const configuredJwtSecret = (process.env.JWT_SECRET || '').trim();

// A missing JWT secret used to throw while this module was loading. That stops
// Express from listening at all, so the browser can only report a vague
// "Network error" when it tries to log in. Keep production deployments
// explicit and safe: they return a clear 503 until JWT_SECRET is configured.
// For local development, an ephemeral secret keeps the API usable without
// making a developer copy a secret into the repository. Development tokens are
// intentionally invalidated whenever the process restarts.
const jwtSecret = configuredJwtSecret || (!isProduction
    ? crypto.randomBytes(32).toString('hex')
    : null);

// How long an access token lives. Raised from 7 days to 30 days so users who
// don't open the app every week (e.g. returning to claim daily earnings) are not
// locked out by an "Invalid or expired token" error. The frontend can also use
// POST /api/refresh-token to silently get a fresh token before/after expiry.
const ACCESS_TOKEN_TTL = '30d';
const JWT_ISSUER = 'AccessWealthHQ';
const JWT_AUDIENCE = 'AccessWealthUsers';

function signAccessToken(user) {
    if (!jwtSecret) {
        throw new Error('JWT_SECRET is not configured');
    }
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role || 'user' },
        jwtSecret,
        { expiresIn: ACCESS_TOKEN_TTL, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
    );
}

function requireJwtSecret(res) {
    if (jwtSecret) return true;
    res.status(503).json({
        error: 'Authentication is temporarily unavailable. Please try again later.',
        code: 'AUTH_NOT_CONFIGURED'
    });
    return false;
}

// Builds the full, normalized user object returned by login/register/refresh and
// sync endpoints. Earlier versions returned a partial object on login (missing
// full_name, phone, bank details and the earnings wallets), which made the
// frontend treat fully-activated users as having an "incomplete account".
function serializeUser(user) {
    if (!user) return null;
    const walletBalance = toFiniteNumber(user.wallet_balance ?? user.balance) ?? 0;
    const profileComplete = Boolean(
        String(user.full_name || '').trim() && String(user.phone || '').trim()
    );
    // Bank details are considered complete when all three fields are present.
    const bankComplete = Boolean(
        String(user.bank_name || '').trim() &&
        String(user.bank_account_number || '').trim() &&
        String(user.bank_account_holder || '').trim()
    );
    const status = String(user.status || 'active').toLowerCase();
    const planActivated = isTrueFlag(user.planActivated) ? 'true' : 'false';
    return {
        id: user.id,
        username: user.username,
        role: user.role || 'user',
        status,
        planActivated,
        activePackage: user.activePackage || 'None',
        activePackageId: user.activePackageId || null,
        my_referral_id: user.my_referral_id || null,
        referred_by: user.referred_by || null,
        full_name: user.full_name || '',
        phone: user.phone || '',
        bank_name: user.bank_name || '',
        bank_account_number: user.bank_account_number || '',
        bank_account_holder: user.bank_account_holder || '',
        balance: toFiniteNumber(user.balance) ?? 0,
        wallet_balance: walletBalance,
        taskEarnings: toFiniteNumber(user.taskEarnings) ?? 0,
        daily_earnings: toFiniteNumber(user.daily_earnings) ?? 0,
        affiliate_balance: toFiniteNumber(user.affiliate_balance) ?? 0,
        // Convenience flags the dashboard uses to decide what to prompt for.
        profile_complete: profileComplete,
        bank_complete: bankComplete,
        account_complete: profileComplete && bankComplete
    };
}

if (!jwtSecret) {
    console.error('ERROR: JWT_SECRET is not configured. Authentication endpoints will return 503 until it is set.');
}

app.set('trust proxy', 1);
// The API is intentionally consumed by a separate frontend origin. Allow
// CORS-approved responses to be read as cross-origin resources; the default
// Helmet CORP `same-origin` policy can otherwise make browser fetches look like
// network failures even when the CORS headers are correct.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const DEFAULT_FRONTEND_ORIGINS = [
    'https://accesswealthhq.com',
    'https://www.accesswealthhq.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
];

// FRONTEND_URL is commonly entered as a comma-separated list, sometimes with
// spaces, a trailing slash, or a path. Comparing that raw value with the
// browser's Origin header makes an otherwise healthy login request fail CORS
// and appear to the user as a network failure. Store normalized origins only.
function normalizeOrigin(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return null;
    // A wildcard cannot be used with credentials: true and would otherwise
    // silently block every browser origin, so ignore it and use the safe
    // defaults/configured origins instead.
    if (rawValue === '*') return null;

    try {
        const parsed = new URL(rawValue);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function getOriginAliases(origin) {
    const aliases = [origin];
    try {
        const parsed = new URL(origin);
        if (parsed.hostname === 'accesswealthhq.com') {
            aliases.push(`${parsed.protocol}//www.accesswealthhq.com${parsed.port ? `:${parsed.port}` : ''}`);
        } else if (parsed.hostname === 'www.accesswealthhq.com') {
            aliases.push(`${parsed.protocol}//accesswealthhq.com${parsed.port ? `:${parsed.port}` : ''}`);
        }
    } catch (_) {
        // normalizeOrigin already filtered invalid values.
    }
    return aliases;
}

const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
const allowedOrigins = new Set(
    (configuredFrontendOrigins.length ? configuredFrontendOrigins : DEFAULT_FRONTEND_ORIGINS)
        .flatMap(getOriginAliases)
);
const allowAnyDevelopmentOrigin = !isProduction &&
    String(process.env.NODE_ENV || '').toLowerCase() === 'development';

app.use(cors({
    origin: function (origin, callback) {
        // Requests without an Origin header include same-origin requests, curl,
        // health checks, and server-to-server calls. They do not need CORS.
        if (!origin) return callback(null, true);

        const normalizedOrigin = normalizeOrigin(origin);
        if (allowAnyDevelopmentOrigin || allowedOrigins.has(normalizedOrigin)) {
            return callback(null, true);
        }

        // Do not throw here. Throwing makes the global error handler return a
        // response without CORS headers, which hides the useful status behind a
        // browser-level "Network error". The request is still denied, but the
        // server logs the exact origin that needs to be added to FRONTEND_URL.
        console.warn(`Blocked CORS request from ${origin}. Add this origin to FRONTEND_URL if it is the deployed frontend.`);
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json({
    limit: '12mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
// Accept traditional form posts as well as JSON. This keeps the auth endpoint
// compatible with simple HTML/mobile clients without changing the JSON API.
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ==========================================
// MANUAL PAYMENT CONFIGURATION
// Deposits are handled manually: users transfer to this account and upload a
// payment receipt for admin approval.
// ==========================================
const MANUAL_PAYMENT_INFO = {
    bank_name: process.env.MANUAL_BANK_NAME || 'Moniepoint',
    account_name: process.env.MANUAL_ACCOUNT_NAME || 'Luna Entry Services - Access Wealth HQ',
    account_number: process.env.MANUAL_ACCOUNT_NUMBER || '6977298247',
    bank_code: process.env.MANUAL_BANK_CODE || '',
    currency: process.env.MANUAL_CURRENCY || 'NGN',
    instructions: process.env.MANUAL_PAYMENT_INSTRUCTIONS ||
        'Transfer the deposit amount to the account below, then upload your payment receipt to complete the request. Your deposit will be credited to your wallet once an admin approves it.',
    enabled: !['false', '0', 'no'].includes(String(process.env.MANUAL_PAYMENT_ENABLED || 'true').trim().toLowerCase())
};

function getManualPaymentInfo() {
    return MANUAL_PAYMENT_INFO;
}

function parseDataUrl(dataUrl) {
    const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(String(dataUrl || '').trim());
    if (!match) return null;

    const encoded = match[2].replace(/[\r\n]/g, '');
    // Buffer.from is permissive and silently ignores invalid base64 characters.
    // Validate the canonical representation before accepting/storing a receipt.
    if (!encoded || encoded.length % 4 === 1) return null;
    const normalized = encoded.replace(/=+$/, '');
    const decoded = Buffer.from(encoded, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== normalized) return null;

    return {
        mime: match[1].toLowerCase(),
        buffer: decoded
    };
}

const MAX_RECEIPT_SIZE = 5 * 1024 * 1024; // 5MB

// Allowed receipt MIME types. Images (PNG/JPG/GIF/WEBP) and PDF.
const ALLOWED_RECEIPT_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'application/pdf'
]);

// Multipart upload handler. Files are kept in memory (Buffer) so the deposit
// handler can base64-encode them for storage exactly like the legacy JSON path,
// but they are streamed off the socket instead of being inflated into a giant
// base64 JSON string. This is what makes mobile uploads reliable: on mobile,
// high-resolution camera photos are commonly 4-10MB, and base64 + JSON parsing
// of that string pushes the browser tab over its memory limit, causing it to
// hang or be killed (which appears to the user as a refresh).
const receiptUpload = multer ? multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_RECEIPT_SIZE,
        // Guard against abusive multi-field payloads.
        files: 1,
        fields: 20,
        fieldSize: 1 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_RECEIPT_MIMES.has(file.mimetype)) {
            return cb(null, true);
        }
        const err = new Error('Receipt must be a PNG, JPG, GIF, WEBP or PDF file.');
        err.code = 'UNSUPPORTED_RECEIPT_TYPE';
        cb(err);
    }
}) : null;

// Middleware that runs a single-file multer upload and translates multer errors
// into clean 400 JSON responses (instead of the default HTML error page or a
// 500). In particular LIMIT_FILE_SIZE returns a message the mobile client can
// show directly so the user knows to compress/choose a smaller photo.
function uploadReceipt(req, res, next) {
    if (!receiptUpload) {
        return res.status(503).json({
            error: 'Multipart receipt uploads are temporarily unavailable. Please use the JSON receipt upload or try again later.'
        });
    }

    receiptUpload.single('receipt')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    error: 'Receipt file is too large. Maximum size is 5MB. Please choose a smaller or compressed photo.'
                });
            }
            if (err.code === 'UNSUPPORTED_RECEIPT_TYPE') {
                return res.status(400).json({ error: err.message });
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ error: 'Unexpected file field. Upload the receipt using the "receipt" field.' });
            }
            return res.status(400).json({ error: 'Failed to upload receipt. Please try again.' });
        }
        next();
    });
}

// This repository is an API-only deployment. Do not expose the repository root
// through express.static: it contains the SQLite database, package metadata and
// server source. A frontend, if one is added later, should be served from an
// explicit public directory instead.

function toFiniteNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string' || value.trim() === '') return null;
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : null;
}

function isValidAmount(value) {
    const number = toFiniteNumber(value);
    return number !== null && number > 0;
}

function isTrueFlag(value) {
    return value === true || value === 1 || ['true', '1'].includes(String(value ?? '').toLowerCase());
}

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Africa/Lagos';
function getClaimDate(date = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: APP_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(date);
    } catch (error) {
        console.warn(`Invalid APP_TIME_ZONE "${APP_TIME_ZONE}"; falling back to UTC.`);
        return date.toISOString().split('T')[0];
    }
}

// Investment package earning structure (updated for a more attractive,
// tiered ROI). Higher tiers earn a higher daily rate. Each entry's
// daily_earning and total_payout MUST stay consistent with its daily_rate:
//   daily_earning = capital * daily_rate
//   total_payout  = capital + daily_earning * cycle_days
// Existing ACTIVE investments keep the rate/earnings they were activated with
// (snapshot on the user_investments row); these new values apply to fresh
// activations and upgrades only.
const FIXED_PACKAGES = [
    { id: 'starter_basic', name: 'Starter Basic', tier: 'Starter', capital: 500, daily_rate: 0.03, cycle_days: 10, daily_earning: 15, total_payout: 650 },
    { id: 'starter_bronze', name: 'Starter Bronze', tier: 'Starter', capital: 1500, daily_rate: 0.03, cycle_days: 10, daily_earning: 45, total_payout: 1950 },
    { id: 'starter_silver', name: 'Starter Silver', tier: 'Starter', capital: 3000, daily_rate: 0.03, cycle_days: 10, daily_earning: 90, total_payout: 3900 },
    { id: 'starter_gold', name: 'Starter Gold', tier: 'Starter', capital: 4500, daily_rate: 0.03, cycle_days: 10, daily_earning: 135, total_payout: 5850 },
    { id: 'growth_plus', name: 'Growth Plus', tier: 'Growth', capital: 10000, daily_rate: 0.04, cycle_days: 15, daily_earning: 400, total_payout: 16000 },
    { id: 'growth_pro', name: 'Growth Pro', tier: 'Growth', capital: 25000, daily_rate: 0.04, cycle_days: 15, daily_earning: 1000, total_payout: 40000 },
    { id: 'growth_max', name: 'Growth Max', tier: 'Growth', capital: 50000, daily_rate: 0.04, cycle_days: 15, daily_earning: 2000, total_payout: 80000 },
    { id: 'wealth_standard', name: 'Wealth Standard', tier: 'Wealth', capital: 100000, daily_rate: 0.05, cycle_days: 21, daily_earning: 5000, total_payout: 205000 },
    { id: 'wealth_premium', name: 'Wealth Premium', tier: 'Wealth', capital: 250000, daily_rate: 0.05, cycle_days: 21, daily_earning: 12500, total_payout: 512500 },
    { id: 'elite_vanguard', name: 'Elite Vanguard', tier: 'Elite', capital: 500000, daily_rate: 0.06, cycle_days: 30, daily_earning: 30000, total_payout: 1400000 },
    { id: 'elite_apex', name: 'Elite Apex', tier: 'Elite', capital: 1000000, daily_rate: 0.06, cycle_days: 30, daily_earning: 60000, total_payout: 2800000 }
];

const PACKAGE_BY_ID = FIXED_PACKAGES.reduce((acc, pkg) => {
    acc[pkg.id] = pkg;
    return acc;
}, {});

const PACKAGE_BY_NAME = FIXED_PACKAGES.reduce((acc, pkg) => {
    acc[pkg.name.toLowerCase()] = pkg;
    return acc;
}, {});

function getReferralBonus(pkg) {
    // Fixed package model: referrer earns 50% of package capital at activation.
    return Math.round(pkg.capital * 0.5);
}

function serializePackageForApi(pkg) {
    return {
        ...pkg,
        referral_bonus: getReferralBonus(pkg)
    };
}

function addColumnIfMissing(tableName, columnName, columnType) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.warn(`Warning adding column ${tableName}.${columnName}:`, err.message);
        }
    });
}

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

const {
    CLAIM_COOLDOWN_MS,
    resolveActiveEntitlement,
    serializeUserWithEntitlement,
    extractAccessToken,
    buildTokenPayload,
    nextClaimAtFrom,
    parseSqliteDate,
    serializeActiveInvestment
} = require('./entitlement').createEntitlementHelpers({
    dbGetAsync,
    dbAllAsync,
    FIXED_PACKAGES,
    PACKAGE_BY_ID,
    PACKAGE_BY_NAME,
    toFiniteNumber,
    isTrueFlag,
    serializeUser,
    signAccessToken,
    getReferralBonus
});

// Read a feature/site setting with a safe fallback. Settings are stored as
// strings in SQLite, and callers use the callback form so they can return a
// clean API error if the database is unavailable. Keeping this helper central
// also avoids each feature implementing a subtly different defaulting rule.
function readSiteSetting(key, fallbackValue, callback) {
    db.get(
        `SELECT value FROM site_settings WHERE key = ?`,
        [key],
        (err, row) => {
            if (err) return callback(err, fallbackValue);
            callback(null, row && row.value !== undefined ? String(row.value) : fallbackValue);
        }
    );
}

function getSiteSetting(key, fallbackValue) {
    return new Promise((resolve, reject) => {
        readSiteSetting(key, fallbackValue, (err, value) => {
            if (err) return reject(err);
            resolve(value);
        });
    });
}

// Returns true when a table column already exists. Used to make schema
// migrations idempotent and to gate write endpoints on required columns.
function tableHasColumn(tableName, columnName) {
    return new Promise((resolve) => {
        db.all(`PRAGMA table_info(${tableName})`, [], (err, columns) => {
            if (err) return resolve(false);
            resolve(Array.isArray(columns) && columns.some((c) => c.name === columnName));
        });
    });
}

// Promise-wrapped ADD COLUMN. Resolves once the ALTER finishes (or when the
// column already exists), so callers can await schema changes at startup or on
// demand. Unlike the fire-and-forget addColumnIfMissing() used during init, this
// is safe to depend on before issuing a write that needs the column.
function addColumnIfMissingAsync(tableName, columnName, columnType) {
    return new Promise((resolve, reject) => {
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
            if (err && err.message && err.message.includes('duplicate column name')) {
                return resolve();
            }
            if (err) return reject(err);
            resolve();
        });
    });
}

// Runtime guarantee that the deposits table has every column referenced by the
// deposit INSERT / SELECT statements. The startup migration list already adds
// these, but on a long-lived production database the columns can be missing if
// they were only ever declared in CREATE TABLE IF NOT EXISTS (a no-op once the
// table exists). We re-check here so a request can never fail with
// "no such column" because the schema drifted or the startup ALTER was skipped.
let depositSchemaPromise = null;
function ensureDepositSchema() {
    if (!depositSchemaPromise) {
        depositSchemaPromise = (async () => {
            const required = [
                { name: 'sender_name', type: 'TEXT' },
                { name: 'payment_method', type: 'TEXT' },
                { name: 'transaction_ref', type: 'TEXT' },
                { name: 'receipt', type: 'TEXT' },
                { name: 'receipt_mime', type: 'TEXT' },
                { name: 'user_id', type: 'INTEGER' },
                { name: 'admin_note', type: 'TEXT' },
                { name: 'reviewed_by', type: 'TEXT' },
                { name: 'reviewed_at', type: 'DATETIME' }
            ];
            for (const col of required) {
                const exists = await tableHasColumn('deposits', col.name);
                if (!exists) {
                    await addColumnIfMissingAsync('deposits', col.name, col.type);
                    console.warn(`[DB] deposits.${col.name} was missing and has been added.`);
                }
            }
        })().catch((err) => {
            // Allow a retry on the next request if this attempt failed.
            depositSchemaPromise = null;
            console.error('[DB] Failed to ensure deposits schema:', err.message);
            throw err;
        });
    }
    return depositSchemaPromise;
}

// Minimal SQLite busy-retry: re-run a DB operation when SQLite reports the
// database is locked (SQLITE_BUSY), which can happen under concurrent writes.
// This complements the connection-level busyTimeout configured at startup.
//
// The busyTimeout below is deliberately small (2s) and the retry is capped at 3
// attempts with short back-off so that a write (e.g. a deposit insert) that hits
// a locked database either completes quickly or fails fast — it never blocks for
// 10s+ per attempt. Before this fix a deposit request could hang for ~18-50s while
// SQLite waited on a busy lock; the client would time out and show "server error",
// yet the backend would eventually commit the deposit, so it silently appeared on
// the admin approval page (and the user often re-submitted, creating duplicates).
const SQLITE_BUSY_RETRY_MAX_ATTEMPTS = 3;
const SQLITE_BUSY_RETRY_BASE_DELAY_MS = 100;

function isSqliteBusyError(err) {
    return Boolean(err) && (err.code === 'SQLITE_BUSY' || err.errno === 5);
}

async function withSqliteBusyRetry(operation, label = 'sqlite') {
    let attempt = 0;
    for (;;) {
        try {
            return await operation();
        } catch (err) {
            attempt += 1;
            if (!isSqliteBusyError(err) || attempt >= SQLITE_BUSY_RETRY_MAX_ATTEMPTS) {
                throw err;
            }
            const delay = SQLITE_BUSY_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`[DB] ${label} busy (attempt ${attempt}/${SQLITE_BUSY_RETRY_MAX_ATTEMPTS}), retrying in ${delay}ms`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

class ApiError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

function apiError(status, message, code) {
    return new ApiError(status, message, code);
}

async function withSqliteTransaction(operation, label = 'transaction') {
    let release;
    const previousTransaction = transactionTail;
    transactionTail = new Promise((resolve) => {
        release = resolve;
    });
    await previousTransaction;

    return transactionStorage.run(true, async () => {
        try {
            await withSqliteBusyRetry(() => dbRunAsync('BEGIN IMMEDIATE TRANSACTION'), `${label}_begin`);
            const result = await operation();
            await dbRunAsync('COMMIT');
            return result;
        } catch (error) {
            try {
                await dbRunAsync('ROLLBACK');
            } catch (rollbackError) {
                console.error(`[DB] ${label} rollback failed:`, rollbackError.message);
            }
            throw error;
        } finally {
            release();
        }
    });
}

function sendApiError(res, error, fallbackMessage = 'Server error. Please try again.') {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const payload = { error: status === 500 ? fallbackMessage : error.message };
    if (error?.code) payload.code = error.code;
    return res.status(status).json(payload);
}

// Auth requests are the most likely to be retried (forgotten passwords, typo'd
// usernames), and production traffic reaches this API through shared reverse
// proxies (Netlify → Railway). A plain per-IP limiter with a low cap would let
// a handful of failed attempts from one shared proxy IP lock out every visitor
// behind it. Key by "username + IP" instead so each account gets its own
// allowance regardless of the proxy, and do not count successful logins or
// registrations against the limit.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => {
        const username = (req.body && typeof req.body.username === 'string' ? req.body.username : '').trim().toLowerCase();
        const ipKey = rateLimit.ipKeyGenerator(req.ip || '0.0.0.0');
        return username ? `auth:${username}:${ipKey}` : `auth:ip:${ipKey}`;
    },
    skipSuccessfulRequests: true,
    message: { error: "Too many attempts, please try again after 15 minutes." }
});

const actionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please slow down." }
});

// ==========================================
// DATABASE INITIALIZATION WITH MIGRATION
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : path.join(__dirname, 'database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        // If the database cannot be opened, every endpoint (including login)
        // would fail. Exit immediately so the platform restart policy kicks in
        // and the deploy logs show exactly why instead of a vague "Network
        // error" on every sign-in attempt.
        console.error('FATAL: Could not open the SQLite database at', dbPath);
        console.error('FATAL:', err.message);
        console.error('FATAL: Check that RAILWAY_VOLUME_MOUNT_PATH points to a mounted, writable volume. Exiting so the platform can restart the container.');
        process.exit(1);
    } else {
        db.configure('busyTimeout', 2000);
        db.run("PRAGMA journal_mode=WAL;", (pragmaErr) => {
            if (pragmaErr) console.error("Failed to enable WAL mode:", pragmaErr.message);
        });
    }
});

// Guard the callback-style sqlite3 methods as well as the Promise helpers. A
// number of legacy endpoints still use db.get/db.run directly, so guarding only
// dbRunAsync would leave money-changing transactions vulnerable to interleaving.
const rawDbRun = db.run.bind(db);
const rawDbGet = db.get.bind(db);
const rawDbAll = db.all.bind(db);
const rawDbClose = db.close.bind(db);
db.run = function guardedRun(...args) {
    const execute = () => rawDbRun(...args);
    return transactionStorage.getStore() ? execute() : transactionTail.then(execute);
};
db.get = function guardedGet(...args) {
    const execute = () => rawDbGet(...args);
    return transactionStorage.getStore() ? execute() : transactionTail.then(execute);
};
db.all = function guardedAll(...args) {
    const execute = () => rawDbAll(...args);
    return transactionStorage.getStore() ? execute() : transactionTail.then(execute);
};
db.close = function guardedClose(...args) {
    const execute = () => rawDbClose(...args);
    return transactionTail.then(execute);
};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance REAL DEFAULT 0,
        wallet_balance REAL DEFAULT 0,
        taskEarnings REAL DEFAULT 0,
        daily_earnings REAL DEFAULT 0,
        affiliate_balance REAL DEFAULT 0,
        my_referral_id TEXT UNIQUE,
        referred_by TEXT,
        planActivated TEXT DEFAULT 'false',
        activePackage TEXT DEFAULT 'None',
        role TEXT DEFAULT 'user',
        full_name TEXT,
        phone TEXT,
        bank_name TEXT,
        bank_account_number TEXT,
        bank_account_holder TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // SQLite cannot add a column with UNIQUE or a non-constant default via
    // ALTER TABLE. Existing production databases therefore need plain column
    // types here; defaults are applied by the backfill below and by the INSERTs.
    const columnsToAdd = [
        { name: 'balance', type: 'REAL' },
        { name: 'wallet_balance', type: 'REAL' },
        { name: 'taskEarnings', type: 'REAL' },
        { name: 'daily_earnings', type: 'REAL' },
        { name: 'affiliate_balance', type: 'REAL' },
        { name: 'my_referral_id', type: 'TEXT' },
        { name: 'referred_by', type: 'TEXT' },
        { name: 'planActivated', type: 'TEXT' },
        { name: 'activePackage', type: 'TEXT' },
        { name: 'activePackageId', type: 'TEXT' },
        { name: 'role', type: 'TEXT' },
        { name: 'full_name', type: 'TEXT' },
        { name: 'phone', type: 'TEXT' },
        { name: 'bank_name', type: 'TEXT' },
        { name: 'bank_account_number', type: 'TEXT' },
        { name: 'bank_account_holder', type: 'TEXT' },
        { name: 'bank_code', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME' },
        { name: 'status', type: 'TEXT' }
    ];

    // Backfill values for columns added to an older database. These statements
    // run after the ALTER statements because db.serialize queues them in order.
    const userDefaults = [
        ["UPDATE users SET balance = 0 WHERE balance IS NULL", []],
        ["UPDATE users SET wallet_balance = COALESCE(balance, 0) WHERE wallet_balance IS NULL", []],
        ["UPDATE users SET taskEarnings = 0 WHERE taskEarnings IS NULL", []],
        ["UPDATE users SET daily_earnings = 0 WHERE daily_earnings IS NULL", []],
        ["UPDATE users SET affiliate_balance = 0 WHERE affiliate_balance IS NULL", []],
        ["UPDATE users SET planActivated = 'false' WHERE planActivated IS NULL OR TRIM(planActivated) = ''", []],
        ["UPDATE users SET activePackage = 'None' WHERE activePackage IS NULL OR TRIM(activePackage) = ''", []],
        ["UPDATE users SET role = 'user' WHERE role IS NULL OR TRIM(role) = ''", []],
        ["UPDATE users SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''", []],
        ["UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL", []]
    ];

    columnsToAdd.forEach((col) => addColumnIfMissing('users', col.name, col.type));
    userDefaults.forEach(([sql, params]) => db.run(sql, params));

    // Ensure main balances are synchronized for existing users. This preserves
    // legacy data where only one of the two balance columns was populated.
    db.run(`UPDATE users SET wallet_balance = balance WHERE (wallet_balance IS NULL OR wallet_balance = 0) AND balance > 0`);
    db.run(`UPDATE users SET balance = wallet_balance WHERE (balance IS NULL OR balance = 0) AND wallet_balance > 0`);


    // Existing tables
    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        sender_name TEXT, 
        payment_method TEXT,
        transaction_ref TEXT,
        receipt TEXT,
        receipt_mime TEXT,
        status TEXT DEFAULT 'pending', 
        admin_note TEXT,
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // NOTE: `CREATE TABLE IF NOT EXISTS deposits` above is a NO-OP on the existing
    // production database (the table already exists), so columns that were only
    // added to that CREATE statement (sender_name, payment_method, transaction_ref)
    // are NOT present on prod. They must be added here via ALTER TABLE, otherwise
    // the deposit INSERT fails with "no such column: payment_method". Every column
    // referenced by an INSERT/SELECT against `deposits` must be in this list.
    const depositColumnsToAdd = [
        { name: 'sender_name', type: 'TEXT' },
        { name: 'payment_method', type: 'TEXT' },
        { name: 'transaction_ref', type: 'TEXT' },
        { name: 'receipt', type: 'TEXT' },
        { name: 'receipt_mime', type: 'TEXT' },
        { name: 'user_id', type: 'INTEGER' },
        { name: 'admin_note', type: 'TEXT' },
        { name: 'reviewed_by', type: 'TEXT' },
        { name: 'reviewed_at', type: 'DATETIME' }
    ];
    depositColumnsToAdd.forEach((col) => addColumnIfMissing('deposits', col.name, col.type));

    // ✅ UPDATED withdrawals table with all required columns
    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        fee REAL,
        total_deducted REAL,
        wallet_type TEXT,
        bank_details TEXT,
        status TEXT DEFAULT 'pending', 
        admin_note TEXT,
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Keep migrations compatible with SQLite's ALTER TABLE restrictions. All
    // columns are plain types here; CREATE TABLE above supplies defaults for a
    // new database and the request code supplies values for older databases.
    const withdrawalColumnsToAdd = [
        { name: 'username', type: 'TEXT' },
        { name: 'amount', type: 'REAL' },
        { name: 'fee', type: 'REAL' },
        { name: 'total_deducted', type: 'REAL' },
        { name: 'wallet_type', type: 'TEXT' },
        { name: 'bank_details', type: 'TEXT' },
        { name: 'status', type: 'TEXT' },
        { name: 'admin_note', type: 'TEXT' },
        { name: 'reviewed_by', type: 'TEXT' },
        { name: 'reviewed_at', type: 'DATETIME' },
        { name: 'created_at', type: 'DATETIME' }
    ];
    withdrawalColumnsToAdd.forEach((col) => addColumnIfMissing('withdrawals', col.name, col.type));
    db.run("UPDATE withdrawals SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''");

    db.run(`CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);
    const defaultSettings = [
        ['maintenance_mode', 'false'],
        ['registrations_open', 'true'],
        ['deposits_open', 'true'],
        ['withdrawals_open', 'true'],
        ['sponsored_posts_open', 'true']
    ];
    defaultSettings.forEach(([key, value]) => {
        db.run(`INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)`, [key, value]);
    });

    db.run(`CREATE TABLE IF NOT EXISTS ads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        title TEXT, 
        url TEXT, 
        image TEXT, 
        price REAL, 
        status TEXT DEFAULT 'active', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        bill_type TEXT, 
        network TEXT, 
        phone TEXT, 
        amount REAL, 
        status TEXT DEFAULT 'successful', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bulk_sms (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        sender_id TEXT, 
        recipients_count INTEGER, 
        total_cost REAL, 
        status TEXT DEFAULT 'sent', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_id TEXT, 
        sender TEXT, 
        message TEXT, 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS system_migrations (
        migration_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_by TEXT,
        notes TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_username TEXT NOT NULL,
        target_username TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ✅ NEW TABLES
    db.run(`CREATE TABLE IF NOT EXISTS daily_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        claim_date TEXT,
        amount REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        message TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sponsored_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        reward_amount REAL,
        required_plan TEXT,
        image_url TEXT,
        link TEXT,
        status TEXT DEFAULT 'active',
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sponsored_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        username TEXT,
        status TEXT DEFAULT 'pending',
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const dailyClaimColumns = [
        { name: 'username', type: 'TEXT' },
        { name: 'claim_date', type: 'TEXT' },
        { name: 'amount', type: 'REAL' },
        { name: 'created_at', type: 'DATETIME' }
    ];
    dailyClaimColumns.forEach((col) => addColumnIfMissing('daily_claims', col.name, col.type));

    const sponsoredSubmissionColumns = [
        { name: 'post_id', type: 'INTEGER' },
        { name: 'username', type: 'TEXT' },
        { name: 'status', type: 'TEXT' },
        { name: 'submitted_at', type: 'DATETIME' }
    ];
    sponsoredSubmissionColumns.forEach((col) => addColumnIfMissing('sponsored_submissions', col.name, col.type));
    db.run("UPDATE daily_claims SET created_at = datetime('now') WHERE created_at IS NULL");
    db.run("UPDATE sponsored_submissions SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''");
    // Remove duplicate legacy rows before adding uniqueness guarantees. The
    // remaining earliest row is the authoritative historical record.
    db.run(`DELETE FROM daily_claims
            WHERE username IS NOT NULL AND claim_date IS NOT NULL
              AND id NOT IN (
                  SELECT MIN(id) FROM daily_claims
                  WHERE username IS NOT NULL AND claim_date IS NOT NULL
                  GROUP BY LOWER(username), claim_date
              )`);
    db.run(`DELETE FROM sponsored_submissions
            WHERE post_id IS NOT NULL AND username IS NOT NULL
              AND id NOT IN (
                  SELECT MIN(id) FROM sponsored_submissions
                  WHERE post_id IS NOT NULL AND username IS NOT NULL
                  GROUP BY post_id, LOWER(username)
              )`);
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_claims_user_date ON daily_claims(LOWER(username), claim_date)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsored_submissions_post_user ON sponsored_submissions(post_id, LOWER(username))');
    db.run('CREATE INDEX IF NOT EXISTS idx_deposits_transaction_ref ON deposits(transaction_ref)');

    db.run(`CREATE TABLE IF NOT EXISTS investment_packages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tier TEXT NOT NULL,
        capital REAL NOT NULL,
        daily_rate REAL NOT NULL,
        cycle_days INTEGER NOT NULL,
        daily_earning REAL NOT NULL,
        total_payout REAL NOT NULL,
        referral_bonus REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_investments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        package_id TEXT NOT NULL,
        package_name TEXT NOT NULL,
        capital REAL NOT NULL,
        daily_rate REAL NOT NULL,
        cycle_days INTEGER NOT NULL,
        daily_earning REAL NOT NULL,
        total_payout REAL NOT NULL,
        referral_bonus REAL NOT NULL,
        days_credited INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (package_id) REFERENCES investment_packages(id)
    )`);

    // Migration safety for existing databases created before fixed-package rollout.
    const investmentPackageColumns = [
        { name: 'tier', type: 'TEXT' },
        { name: 'capital', type: 'REAL' },
        { name: 'daily_rate', type: 'REAL' },
        { name: 'cycle_days', type: 'INTEGER' },
        { name: 'daily_earning', type: 'REAL' },
        { name: 'total_payout', type: 'REAL' },
        { name: 'referral_bonus', type: 'REAL' },
        { name: 'updated_at', type: 'DATETIME' }
    ];

    investmentPackageColumns.forEach((col) => addColumnIfMissing('investment_packages', col.name, col.type));

    const userInvestmentColumns = [
        { name: 'user_id', type: 'INTEGER' },
        { name: 'username', type: 'TEXT' },
        { name: 'package_id', type: 'TEXT' },
        { name: 'package_name', type: 'TEXT' },
        { name: 'capital', type: 'REAL' },
        { name: 'daily_rate', type: 'REAL' },
        { name: 'cycle_days', type: 'INTEGER' },
        { name: 'daily_earning', type: 'REAL' },
        { name: 'total_payout', type: 'REAL' },
        { name: 'referral_bonus', type: 'REAL' },
        { name: 'days_credited', type: 'INTEGER' },
        { name: 'status', type: 'TEXT' },
        { name: 'activated_at', type: 'DATETIME' },
        { name: 'completed_at', type: 'DATETIME' }
    ];

    userInvestmentColumns.forEach((col) => addColumnIfMissing('user_investments', col.name, col.type));

    // Complete the same idempotent migration for the smaller legacy tables.
    // Older database files predate several of these columns, and CREATE TABLE
    // IF NOT EXISTS does not alter an existing table.
    const legacyTableColumns = {
        ads: [
            ['username', 'TEXT'], ['title', 'TEXT'], ['url', 'TEXT'], ['image', 'TEXT'],
            ['price', 'REAL'], ['status', 'TEXT'], ['created_at', 'DATETIME']
        ],
        bills: [
            ['username', 'TEXT'], ['bill_type', 'TEXT'], ['network', 'TEXT'], ['phone', 'TEXT'],
            ['amount', 'REAL'], ['status', 'TEXT'], ['created_at', 'DATETIME']
        ],
        bulk_sms: [
            ['username', 'TEXT'], ['sender_id', 'TEXT'], ['recipients_count', 'INTEGER'],
            ['total_cost', 'REAL'], ['status', 'TEXT'], ['created_at', 'DATETIME']
        ],
        messages: [
            ['user_id', 'TEXT'], ['sender', 'TEXT'], ['message', 'TEXT'], ['created_at', 'DATETIME']
        ],
        broadcasts: [
            ['title', 'TEXT'], ['message', 'TEXT'], ['created_by', 'TEXT'], ['created_at', 'DATETIME']
        ],
        sponsored_posts: [
            ['title', 'TEXT'], ['description', 'TEXT'], ['reward_amount', 'REAL'],
            ['required_plan', 'TEXT'], ['image_url', 'TEXT'], ['link', 'TEXT'],
            ['status', 'TEXT'], ['created_by', 'TEXT'], ['created_at', 'DATETIME']
        ],
        sponsored_submissions: [
            ['post_id', 'INTEGER'], ['username', 'TEXT'], ['status', 'TEXT'], ['submitted_at', 'DATETIME']
        ],
        admin_activity_log: [
            ['admin_username', 'TEXT'], ['target_username', 'TEXT'], ['action', 'TEXT'],
            ['details', 'TEXT'], ['created_at', 'DATETIME']
        ],
        system_migrations: [
            ['migration_key', 'TEXT'], ['status', 'TEXT'], ['started_by', 'TEXT'], ['notes', 'TEXT'],
            ['started_at', 'DATETIME'], ['completed_at', 'DATETIME'], ['updated_at', 'DATETIME']
        ]
    };
    Object.entries(legacyTableColumns).forEach(([tableName, columns]) => {
        columns.forEach(([name, type]) => addColumnIfMissing(tableName, name, type));
    });

    db.run("UPDATE investment_packages SET referral_bonus = COALESCE(referral_bonus, 0) WHERE referral_bonus IS NULL");
    db.run("UPDATE user_investments SET days_credited = 0 WHERE days_credited IS NULL");
    db.run("UPDATE user_investments SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
    db.run("UPDATE user_investments SET activated_at = datetime('now') WHERE activated_at IS NULL");
    db.run("UPDATE ads SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
    db.run("UPDATE sponsored_posts SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''");
    db.run("UPDATE sponsored_submissions SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''");
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_system_migrations_key ON system_migrations(migration_key)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_id ON users(my_referral_id) WHERE my_referral_id IS NOT NULL');

    const upsertPackageQuery = `
        INSERT INTO investment_packages (id, name, tier, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            tier = excluded.tier,
            capital = excluded.capital,
            daily_rate = excluded.daily_rate,
            cycle_days = excluded.cycle_days,
            daily_earning = excluded.daily_earning,
            total_payout = excluded.total_payout,
            referral_bonus = excluded.referral_bonus,
            updated_at = datetime('now')
    `;

    FIXED_PACKAGES.forEach((pkg) => {
        db.run(
            upsertPackageQuery,
            [
                pkg.id,
                pkg.name,
                pkg.tier,
                pkg.capital,
                pkg.daily_rate,
                pkg.cycle_days,
                pkg.daily_earning,
                pkg.total_payout,
                getReferralBonus(pkg)
            ],
            (err) => {
                if (err) {
                    console.error(`Failed to seed package ${pkg.id}:`, err.message);
                }
            }
        );
    });

    // Admin and support accounts.
    //
    // These lookups are keyed by USERNAME (not by role) and promote an existing
    // row when its role is wrong. The previous implementation used
    // `INSERT OR IGNORE` keyed on the username UNIQUE constraint, which silently
    // did nothing when admin@accesswealth.com (or support@accesswealth.com)
    // already existed as a regular user — e.g. an account registered before the
    // bootstrap ran, or a legacy row whose `role` column was backfilled to
    // 'user' during a migration. That left the app with no usable admin/support
    // account and made every admin-only endpoint return 403 "Admin access
    // required" (which the frontend surfaces as an "Unable to load ..." error).
    setTimeout(() => {
        bootstrapStaffAccount({
            username: 'admin@accesswealth.com',
            role: 'admin',
            referralId: 'ADMIN123',
            passwordEnv: 'ADMIN_BOOTSTRAP_PASSWORD'
        });
        bootstrapStaffAccount({
            username: 'support@accesswealth.com',
            role: 'support',
            referralId: 'SUPPORT123',
            passwordEnv: 'SUPPORT_BOOTSTRAP_PASSWORD'
        });
    }, 500);
});

// Creates or repairs the bootstrap staff account. Ensures the account exists
// with the given role, promoting it (and, when promoting, resetting its
// password to the configured bootstrap password) if it already exists with a
// different role. Already-correct accounts are left untouched so a password an
// admin changed later survives restarts.
function bootstrapStaffAccount({ username, role, referralId, passwordEnv }) {
    db.get(`SELECT id, role FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, row) => {
        if (err) {
            console.error(`${role} bootstrap check error:`, err.message);
            return;
        }

        if (!row) {
            const bootstrapPassword = process.env[passwordEnv];
            if (!bootstrapPassword) {
                console.warn(`${passwordEnv} is not set. Skipping ${role} auto-bootstrap user creation.`);
                return;
            }
            const hash = bcryptjs.hashSync(bootstrapPassword, 10);
            db.run(
                `INSERT INTO users (username, password, role, my_referral_id, planActivated, activePackage, activePackageId)
                 VALUES (?, ?, ?, ?, 'true', 'Elite Apex', 'elite_apex')`,
                [username, hash, role, referralId],
                (insertErr) => {
                    if (insertErr) console.error(`Failed to create ${role} account:`, insertErr.message);
                    else console.warn(`[BOOTSTRAP] Created ${role} account ${username}.`);
                }
            );
            return;
        }

        if (String(row.role || '').toLowerCase() === role) return;

        const bootstrapPassword = process.env[passwordEnv];
        if (bootstrapPassword) {
            const hash = bcryptjs.hashSync(bootstrapPassword, 10);
            db.run(`UPDATE users SET role = ?, password = ? WHERE id = ?`, [role, hash, row.id], (updateErr) => {
                if (updateErr) console.error(`Failed to promote ${role} account:`, updateErr.message);
                else console.warn(`[BOOTSTRAP] Promoted ${username} to ${role} role.`);
            });
        } else {
            db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, row.id], (updateErr) => {
                if (updateErr) console.error(`Failed to promote ${role} account:`, updateErr.message);
                else console.warn(`[BOOTSTRAP] Promoted ${username} to ${role} role.`);
            });
        }
    });
}

// Lightweight deployment probe. A frontend can distinguish "the API is down"
// from a bad username/password, and Railway/other hosts can use this endpoint
// as a health check without needing an auth token.
app.get(['/health', '/api/health'], (req, res) => {
    db.get('SELECT 1 AS ok', [], (err) => {
        if (err) {
            console.error('Health check database error:', err.message);
            return res.status(503).json({ status: 'error', database: 'unavailable' });
        }
        if (!jwtSecret) {
            return res.status(503).json({ status: 'error', database: 'ok', authentication: 'not_configured' });
        }
        return res.json({ status: 'ok', database: 'ok', authentication: 'ok' });
    });
});

// Identify which service a domain actually points at. If someone opens the API
// domain in a browser they get JSON here; the marketing/SPA frontend would
// return HTML instead. This makes a misconfigured custom domain (frontend and
// API swapped, or /api not routed to this service) obvious instead of looking
// like a network error on every login attempt.
app.get(['/', '/api'], (req, res) => {
    res.json({
        service: 'Access Wealth API',
        status: 'running',
        health: '/health',
        hint: 'The frontend should call /api/* endpoints on this service.'
    });
});

function sendInvalidToken(res, err) {
    const expired = Boolean(err && (err.name === 'TokenExpiredError' || /expired/i.test(String(err.message || ''))));
    return res.status(401).json({
        error: "Invalid or expired token. Please log in again.",
        code: "TOKEN_INVALID",
        expired
    });
}

const authenticateToken = (req, res, next) => {
    if (!requireJwtSecret(res)) return;

    const token = extractAccessToken(req);
    if (!token) return res.status(401).json({ error: "Access token required", code: "TOKEN_MISSING" });

    // First try the strict verification (issuer + audience) used by current
    // tokens. If that fails, fall back to verifying signature + expiry WITHOUT
    // the issuer/audience claim checks so tokens issued before those claims
    // were enforced (or by older clients) still work. This prevents returning
    // users from being locked out with "Invalid or expired token" when they
    // come back to claim earnings.
    const verifyOptions = { issuer: JWT_ISSUER, audience: JWT_AUDIENCE };
    jwt.verify(token, jwtSecret, verifyOptions, (err, user) => {
        if (err) {
            jwt.verify(token, jwtSecret, {}, (legacyErr, legacyUser) => {
                if (legacyErr) return sendInvalidToken(res, legacyErr);
                req.user = legacyUser;
                return validateUserStatus(req, res, next);
            });
            return;
        }
        req.user = user;
        validateUserStatus(req, res, next);
    });
};

function validateUserStatus(req, res, next) {
    db.get(`SELECT status FROM users WHERE id = ?`, [req.user.id], (statusErr, statusRow) => {
        if (statusErr) return res.status(500).json({ error: "Server error while validating account status" });
        if (!statusRow) {
            return res.status(401).json({ error: "Invalid or expired token. Please log in again.", code: "TOKEN_INVALID" });
        }
        if (String(statusRow.status || '').toLowerCase() === 'banned') {
            return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
        }
        next();
    });
}

const adminOnly = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    next();
};

// ==========================================
// 1. LIVE SYNC & AUTHENTICATION
// ==========================================
app.post('/api/user/sync', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [req.user.username]);
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.json({ success: true, user: await serializeUserWithEntitlement(user) });
    } catch (error) {
        return sendApiError(res, error, 'Unable to synchronize user profile.');
    }
});

app.post('/api/register', authLimiter, async (req, res) => {
    if (!requireJwtSecret(res)) return;

    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const referredByRaw = typeof body.referred_by === 'string' ? body.referred_by.trim() : '';

        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        if (!/^[a-zA-Z0-9_.@-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Invalid username/email format' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const registrationsOpen = await getSiteSetting('registrations_open', 'true');
        if (!isTrueFlag(registrationsOpen)) {
            return res.status(403).json({ error: 'New registrations are currently disabled.' });
        }

        const existing = await dbGetAsync(
            `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );
        if (existing) return res.status(400).json({ error: "Username already taken. Please choose another." });

        let normalizedReferredBy = null;
        if (referredByRaw) {
            const refUser = await dbGetAsync(
                `SELECT my_referral_id, username
                 FROM users
                 WHERE LOWER(my_referral_id) = LOWER(?) OR LOWER(username) = LOWER(?)
                 LIMIT 1`,
                [referredByRaw, referredByRaw]
            );
            if (!refUser) return res.status(400).json({ error: "Invalid referral code." });
            normalizedReferredBy = refUser.my_referral_id || refUser.username;
        }

        const myReferralId = `AW${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const hashedPassword = await bcryptjs.hash(password, 10);
        const insertResult = await dbRunAsync(
            `INSERT INTO users (username, password, my_referral_id, referred_by, role, status)
             VALUES (?, ?, ?, ?, 'user', 'active')`,
            [username, hashedPassword, myReferralId, normalizedReferredBy]
        );
        const userId = insertResult.lastID;
        const newUser = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [userId]);
        const serialized = await serializeUserWithEntitlement(newUser || {
            id: userId,
            username,
            role: 'user',
            status: 'active',
            my_referral_id: myReferralId
        });

        return res.json({
            ...buildTokenPayload(newUser || { id: userId, username, role: 'user' }),
            message: "Registration successful!",
            user: serialized
        });
    } catch (error) {
        console.error('Registration error:', error.message);
        if (String(error.message || '').includes('UNIQUE constraint failed: users.username')) {
            return res.status(400).json({ error: "Username already taken. Please choose another." });
        }
        if (String(error.message || '').includes('UNIQUE constraint failed: users.my_referral_id')) {
            return res.status(409).json({ error: "Could not create a unique referral ID. Please try again." });
        }
        return res.status(500).json({ error: 'Registration failed due to server error.' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    if (!requireJwtSecret(res)) return;

    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        // Accept the field names used by the older web and mobile clients too.
        // The account is still stored under `username`; accepting `email` or
        // `identifier` here prevents an otherwise valid sign-in from being
        // rejected simply because the client was not upgraded at the same time
        // as the API.
        const usernameValue = [body.username, body.email, body.identifier, body.userName]
            .find((value) => typeof value === 'string' && value.trim());
        const username = typeof usernameValue === 'string' ? usernameValue.trim() : '';
        // Passwords are deliberately not trimmed: spaces can be valid password
        // characters and changing them here would make a valid login fail.
        const password = typeof body.password === 'string' ? body.password :
            (typeof body.passcode === 'string' ? body.passcode : '');

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password required" });
        }

        const user = await dbGetAsync(
            `SELECT * FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );

        if (!user || typeof user.password !== 'string') {
            return res.status(400).json({ error: "Invalid username or password" });
        }
        if (String(user.status || '').toLowerCase() === 'banned') {
            return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
        }

        let passwordMatch = await bcryptjs.compare(password, user.password);

        // A few accounts created by the original deployment contain a legacy
        // plaintext password. Keep those users from being permanently locked
        // out after the bcrypt migration, but immediately replace the legacy
        // value with a bcrypt hash after a successful match. New passwords are
        // always written as bcrypt hashes by /api/register.
        const looksLikeBcrypt = /^\$2[aby]?\$\d{2}\$/.test(user.password);
        if (!passwordMatch && !looksLikeBcrypt && user.password === password) {
            passwordMatch = true;
            const upgradedPassword = await bcryptjs.hash(password, 10);
            await dbRunAsync('UPDATE users SET password = ? WHERE id = ?', [upgradedPassword, user.id]);
            user.password = upgradedPassword;
            console.warn(`Upgraded legacy password hash for user id ${user.id}.`);
        }

        if (!passwordMatch) {
            return res.status(400).json({ error: "Invalid username or password" });
        }

        return res.json({
            ...buildTokenPayload(user),
            user: await serializeUserWithEntitlement(user)
        });
    } catch (error) {
        // Keep database/bcrypt/JWT failures inside the request lifecycle. The
        // old callback-based implementation could reject after the outer
        // try/catch had already returned, leaving the socket open; fetch then
        // surfaced that as "Network error" instead of a useful API response.
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// POST /api/refresh-token — exchange a still-valid (or recently expired) token
// for a fresh 30-day token and the full normalized user. The frontend should
// call this when it receives a 401/403 with code TOKEN_INVALID, OR proactively
// on app load, so returning users can claim daily earnings without being forced
// to log in again. We intentionally accept tokens up to 7 days past expiry to
// smooth over long gaps; anything older requires a fresh login.
app.post('/api/refresh-token', actionLimiter, (req, res) => {
    if (!requireJwtSecret(res)) return;

    const incomingToken = extractAccessToken(req);
    if (!incomingToken) {
        return res.status(401).json({ error: "Access token required", code: "TOKEN_MISSING" });
    }

    const finishWithUser = async (payload) => {
        try {
            const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [payload.id]);
            if (!user) {
                return res.status(401).json({ error: "Account no longer exists.", code: "TOKEN_INVALID" });
            }
            if (String(user.status || '').toLowerCase() === 'banned') {
                return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
            }
            return res.json({
                ...buildTokenPayload(user),
                user: await serializeUserWithEntitlement(user)
            });
        } catch (error) {
            console.error('Token refresh error:', error.message);
            return sendApiError(res, error, 'Unable to refresh your session. Please log in again.');
        }
    };

    jwt.verify(incomingToken, jwtSecret, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE }, (err, payload) => {
        if (!err) return finishWithUser(payload);

        jwt.verify(incomingToken, jwtSecret, { ignoreExpiration: true }, (legacyErr, legacyPayload) => {
            if (legacyErr) {
                return res.status(401).json({ error: "Session expired. Please log in again.", code: "TOKEN_INVALID" });
            }
            if (legacyPayload.exp && (Date.now() / 1000 - legacyPayload.exp) > 30 * 24 * 60 * 60) {
                return res.status(401).json({ error: "Session expired. Please log in again.", code: "TOKEN_INVALID" });
            }
            finishWithUser(legacyPayload);
        });
    });
});

// ==========================================
// 2. FIXED INVESTMENT PACKAGES
// ==========================================
app.get('/api/packages', (req, res) => {
    db.all(
        `SELECT id, name, tier, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus
         FROM investment_packages
         ORDER BY capital ASC`,
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to load packages.' });
            }

            if (rows && rows.length) {
                return res.json({ success: true, packages: rows });
            }

            res.json({ success: true, packages: FIXED_PACKAGES.map(serializePackageForApi) });
        }
    );
});

app.post('/api/admin/packages/reseed', authenticateToken, adminOnly, async (req, res) => {
    const upsertPackageQuery = `
        INSERT INTO investment_packages (id, name, tier, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            tier = excluded.tier,
            capital = excluded.capital,
            daily_rate = excluded.daily_rate,
            cycle_days = excluded.cycle_days,
            daily_earning = excluded.daily_earning,
            total_payout = excluded.total_payout,
            referral_bonus = excluded.referral_bonus,
            updated_at = datetime('now')
    `;

    try {
        await withSqliteTransaction(async () => {
            for (const pkg of FIXED_PACKAGES) {
                await dbRunAsync(
                    upsertPackageQuery,
                    [
                        pkg.id,
                        pkg.name,
                        pkg.tier,
                        pkg.capital,
                        pkg.daily_rate,
                        pkg.cycle_days,
                        pkg.daily_earning,
                        pkg.total_payout,
                        getReferralBonus(pkg)
                    ]
                );
            }
        }, 'reseed_packages');
        return res.json({
            success: true,
            message: 'Investment packages reseeded successfully.',
            total: FIXED_PACKAGES.length
        });
    } catch (error) {
        console.error('Package reseed error:', error.message);
        return sendApiError(res, error, 'Failed to reseed investment packages.');
    }
});

app.post('/api/activate', authenticateToken, actionLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const packageId = (body.package_id || body.packageId || '').toString().trim().toLowerCase();
    const fallbackName = (body.name || '').toString().trim().toLowerCase();
    const selectedPackage = PACKAGE_BY_ID[packageId] || PACKAGE_BY_NAME[fallbackName];

    if (!selectedPackage) {
        return res.status(400).json({ error: 'Invalid package selection.' });
    }

    try {
        const result = await withSqliteTransaction(async () => {
            const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
            if (!user) throw apiError(404, 'User not found.');
            if (isTrueFlag(user.planActivated)) {
                throw apiError(409, 'You already have an active package.');
            }

            const currentBalance = toFiniteNumber(user.balance) || 0;
            if (currentBalance < selectedPackage.capital) {
                throw apiError(400, 'Insufficient deposit balance.');
            }

            const activeInvestment = await dbGetAsync(
                `SELECT id FROM user_investments WHERE user_id = ? AND status = 'active' LIMIT 1`,
                [req.user.id]
            );
            if (activeInvestment) {
                throw apiError(409, 'You already have an active package cycle.');
            }

            const newBalance = currentBalance - selectedPackage.capital;
            const referralBonus = getReferralBonus(selectedPackage);
            const updateResult = await dbRunAsync(
                `UPDATE users
                 SET balance = ?, wallet_balance = ?, planActivated = 'true', activePackage = ?, activePackageId = ?
                 WHERE id = ?
                   AND LOWER(CAST(COALESCE(planActivated, 'false') AS TEXT)) NOT IN ('true', '1')
                   AND COALESCE(balance, 0) >= ?`,
                [newBalance, newBalance, selectedPackage.name, selectedPackage.id, req.user.id, selectedPackage.capital]
            );
            if (!updateResult.changes) {
                throw apiError(409, 'Plan activation could not be completed. Please refresh and try again.');
            }

            await dbRunAsync(
                `INSERT INTO user_investments
                 (user_id, username, package_id, package_name, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', datetime('now'))`,
                [
                    req.user.id,
                    user.username,
                    selectedPackage.id,
                    selectedPackage.name,
                    selectedPackage.capital,
                    selectedPackage.daily_rate,
                    selectedPackage.cycle_days,
                    selectedPackage.daily_earning,
                    selectedPackage.total_payout,
                    referralBonus
                ]
            );

            if (user.referred_by) {
                await dbRunAsync(
                    `UPDATE users
                     SET affiliate_balance = COALESCE(affiliate_balance, 0) + ?
                     WHERE id != ? AND (
                        LOWER(my_referral_id) = LOWER(?) OR LOWER(username) = LOWER(?)
                     )`,
                    [referralBonus, req.user.id, user.referred_by, user.referred_by]
                );
            }

            return { newBalance };
        }, 'activate_package');

        return res.json({
            success: true,
            message: `Package ${selectedPackage.name} activated successfully.`,
            newBalance: result.newBalance,
            package: serializePackageForApi(selectedPackage)
        });
    } catch (error) {
        console.error('Package activation error:', error.message);
        return sendApiError(res, error, 'Failed to activate package. Please try again.');
    }
});

// GET the authenticated user's currently active investment cycle (or null).
// Used by the dashboard/upgrade screen to show the active package and to let
// the frontend calculate the cost of upgrading to a higher package.
app.get('/api/active-investment', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
        const entitlement = await resolveActiveEntitlement(user || { id: req.user.id, username: req.user.username });
        const investment = serializeActiveInvestment(entitlement);

        res.json({
            success: true,
            hasActive: Boolean(investment),
            investment,
            balance: user ? (user.wallet_balance ?? user.balance ?? 0) : 0
        });
    } catch (error) {
        console.error('Active investment lookup error:', error.message);
        res.status(500).json({ error: 'Failed to load active investment.' });
    }
});

// POST upgrade the authenticated user's ACTIVE package to a HIGHER package.
// The user has already locked the current package's capital, so they only pay
// the difference (newCapital - currentCapital) from their wallet balance. The
// current cycle is ended with status 'upgraded' and a fresh cycle for the new
// package begins immediately. Daily earnings already credited are kept.
app.post('/api/upgrade-package', authenticateToken, actionLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const packageId = (body.package_id || body.packageId || '').toString().trim().toLowerCase();
    const fallbackName = (body.name || '').toString().trim().toLowerCase();
    const targetPackage = PACKAGE_BY_ID[packageId] || PACKAGE_BY_NAME[fallbackName];

    if (!targetPackage) {
        return res.status(400).json({ error: 'Invalid package selection.' });
    }

    try {
        const result = await withSqliteTransaction(async () => {
            const user = await dbGetAsync(
                `SELECT id, username, balance, wallet_balance, referred_by FROM users WHERE id = ?`,
                [req.user.id]
            );
            if (!user) throw apiError(404, 'User not found.');

            const current = await dbGetAsync(
                `SELECT id, package_id, package_name, capital FROM user_investments
                 WHERE user_id = ? AND status = 'active'
                 ORDER BY activated_at DESC LIMIT 1`,
                [req.user.id]
            );
            if (!current) {
                throw apiError(400, 'You do not have an active package to upgrade. Please activate a package first.');
            }

            const currentCapital = toFiniteNumber(current.capital);
            if (currentCapital === null) throw new Error('Active package has an invalid capital value.');
            if (targetPackage.capital <= currentCapital) {
                throw apiError(400, 'You can only upgrade to a higher package. Please select a package with a larger capital.');
            }

            const upgradeCost = targetPackage.capital - currentCapital;
            const currentBalance = toFiniteNumber(user.wallet_balance ?? user.balance) || 0;
            if (currentBalance < upgradeCost) {
                throw apiError(400, `Insufficient balance to upgrade. You need ₦${upgradeCost.toLocaleString()} more.`);
            }

            const oldCycleResult = await dbRunAsync(
                `UPDATE user_investments
                 SET status = 'upgraded', completed_at = datetime('now')
                 WHERE id = ? AND status = 'active'`,
                [current.id]
            );
            if (!oldCycleResult.changes) {
                throw apiError(409, 'This package was already upgraded. Please refresh and try again.');
            }

            const newBalance = currentBalance - upgradeCost;
            const userUpdate = await dbRunAsync(
                `UPDATE users
                 SET balance = COALESCE(balance, 0) - ?,
                     wallet_balance = COALESCE(wallet_balance, 0) - ?,
                     activePackage = ?, activePackageId = ?, planActivated = 'true'
                 WHERE id = ? AND COALESCE(balance, 0) >= ?`,
                [upgradeCost, upgradeCost, targetPackage.name, targetPackage.id, req.user.id, upgradeCost]
            );
            if (!userUpdate.changes) {
                throw apiError(409, 'Your balance changed before the upgrade completed. Please refresh and try again.');
            }

            // The upgrade commits only the difference, so the referral bonus
            // recorded for this cycle is also based on the difference.
            const referralBonus = Math.round(upgradeCost * 0.5);
            await dbRunAsync(
                `INSERT INTO user_investments
                 (user_id, username, package_id, package_name, capital, daily_rate, cycle_days,
                  daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', datetime('now'))`,
                [
                    req.user.id,
                    user.username,
                    targetPackage.id,
                    targetPackage.name,
                    targetPackage.capital,
                    targetPackage.daily_rate,
                    targetPackage.cycle_days,
                    targetPackage.daily_earning,
                    targetPackage.total_payout,
                    referralBonus
                ]
            );

            if (user.referred_by) {
                await dbRunAsync(
                    `UPDATE users
                     SET affiliate_balance = COALESCE(affiliate_balance, 0) + ?
                     WHERE id != ? AND (
                        LOWER(my_referral_id) = LOWER(?) OR LOWER(username) = LOWER(?)
                     )`,
                    [referralBonus, req.user.id, user.referred_by, user.referred_by]
                );
            }

            return {
                upgradeCost,
                newBalance,
                previousPackage: { id: current.package_id, name: current.package_name, capital: currentCapital }
            };
        }, 'upgrade_package');

        console.warn(`[UPGRADE] ${req.user.username} upgraded to ${targetPackage.name} (cost ₦${result.upgradeCost})`);
        return res.json({
            success: true,
            message: `Successfully upgraded to ${targetPackage.name}. ₦${result.upgradeCost.toLocaleString()} was deducted from your wallet.`,
            upgrade_cost: result.upgradeCost,
            newBalance: result.newBalance,
            previous_package: result.previousPackage,
            package: serializePackageForApi(targetPackage)
        });
    } catch (error) {
        console.error('Upgrade package error:', error.message);
        return sendApiError(res, error, 'Failed to upgrade package. Please try again.');
    }
});

// ==========================================
// 4. WITHDRAWAL REQUESTS (User initiated)
// ==========================================
app.post('/api/request-withdrawal', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const amount = toFiniteNumber(body.amount);
        const username = req.user.username;
        const walletType = body.wallet_type || 'balance';
        const walletColumns = {
            balance: 'balance',
            affiliate: 'affiliate_balance',
            task: 'taskEarnings'
        };
        const walletField = walletColumns[walletType];

        if (amount === null || amount < 3000) {
            return res.status(400).json({ error: 'Minimum withdrawal amount is ₦3,000' });
        }
        if (!walletField) {
            return res.status(400).json({ error: 'Invalid wallet type. Use balance, task or affiliate.' });
        }

        const withdrawalsOpen = await getSiteSetting('withdrawals_open', 'true');
        if (!isTrueFlag(withdrawalsOpen)) {
            return res.status(403).json({ error: 'Withdrawals are currently disabled.' });
        }

        const bankDetails = body.bank_details && typeof body.bank_details === 'object'
            ? body.bank_details
            : {};
        const bankDetailsStr = JSON.stringify(bankDetails);

        await withSqliteTransaction(async () => {
            const existing = await dbGetAsync(
                `SELECT id FROM withdrawals
                 WHERE LOWER(username) = LOWER(?) AND status IN ('pending', 'processing')
                 LIMIT 1`,
                [username]
            );
            if (existing) throw apiError(409, 'You already have a withdrawal awaiting processing.');

            const user = await dbGetAsync(
                `SELECT ${walletField} AS available_balance FROM users WHERE LOWER(username) = LOWER(?)`,
                [username]
            );
            if (!user) throw apiError(404, 'User not found.');
            const availableBalance = toFiniteNumber(user.available_balance) || 0;
            if (availableBalance < amount) throw apiError(400, 'Insufficient balance.');

            const updateSql = walletField === 'balance'
                ? `UPDATE users
                   SET balance = COALESCE(balance, 0) - ?,
                       wallet_balance = COALESCE(wallet_balance, 0) - ?
                   WHERE LOWER(username) = LOWER(?) AND COALESCE(balance, 0) >= ?`
                : `UPDATE users
                   SET ${walletField} = COALESCE(${walletField}, 0) - ?
                   WHERE LOWER(username) = LOWER(?) AND COALESCE(${walletField}, 0) >= ?`;
            const updateParams = walletField === 'balance'
                ? [amount, amount, username, amount]
                : [amount, username, amount];
            const updateResult = await dbRunAsync(updateSql, updateParams);
            if (!updateResult.changes) throw apiError(409, 'Your balance changed before the withdrawal was submitted. Please try again.');

            await dbRunAsync(
                `INSERT INTO withdrawals (username, amount, wallet_type, status, bank_details, created_at)
                 VALUES (?, ?, ?, 'pending', ?, datetime('now'))`,
                [username, amount, walletType, bankDetailsStr]
            );
        }, 'withdrawal_request');

        return res.json({ success: true, message: 'Withdrawal request submitted. Awaiting admin approval.' });
    } catch (error) {
        console.error('Withdrawal request error:', error.message);
        return sendApiError(res, error, 'Failed to process withdrawal. Please try again.');
    }
});

app.get('/api/admin/withdrawals', authenticateToken, adminOnly, (req, res) => {
    const requestedStatus = String(req.query.status || 'pending').toLowerCase();
    const allowedStatuses = ['pending', 'processing', 'declined', 'completed', 'all'];
    const status = allowedStatuses.includes(requestedStatus) ? requestedStatus : 'pending';
    const where = status === 'all' ? '' : 'WHERE status = ?';
    const params = status === 'all' ? [] : [status];
    db.all(`SELECT id, username, amount, wallet_type, bank_details, status, admin_note, reviewed_by, created_at, reviewed_at
            FROM withdrawals ${where} ORDER BY created_at DESC`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, withdrawals: rows || [] });
    });
});

app.get('/api/admin/all-withdrawals', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT id, username, amount, wallet_type, bank_details, status, admin_note, reviewed_by, created_at, reviewed_at 
            FROM withdrawals ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, withdrawals: rows || [] });
    });
});

app.post('/api/admin/approve-withdrawal', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { id, note } = body;
    if (!id) return res.status(400).json({ error: 'Withdrawal ID required' });

    try {
        const result = await dbRunAsync(
            `UPDATE withdrawals
             SET status = 'processing', admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
            [note || 'Withdrawal approved for processing.', req.user.username, id]
        );
        if (!result.changes) return res.status(404).json({ error: 'Withdrawal not found or already processed' });
        return res.json({ success: true, message: 'Withdrawal approved for processing.' });
    } catch (error) {
        console.error('Withdrawal approval error:', error.message);
        return res.status(500).json({ error: 'Unable to approve withdrawal.' });
    }
});

app.post('/api/admin/decline-withdrawal', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const id = body.id;
    const note = body.note;
    if (!id) return res.status(400).json({ error: "Withdrawal ID required" });

    try {
        await withSqliteTransaction(async () => {
            const withdrawal = await dbGetAsync(
                `SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'`,
                [id]
            );
            if (!withdrawal) throw apiError(404, "Withdrawal not found or already processed");

            const walletField = withdrawal.wallet_type === 'affiliate'
                ? 'affiliate_balance'
                : withdrawal.wallet_type === 'task' ? 'taskEarnings' : 'balance';
            const amount = toFiniteNumber(withdrawal.amount);
            if (amount === null || amount <= 0) throw new Error('Withdrawal contains an invalid amount.');

            const updateSql = walletField === 'balance'
                ? `UPDATE users
                   SET balance = COALESCE(balance, 0) + ?,
                       wallet_balance = COALESCE(wallet_balance, 0) + ?
                   WHERE LOWER(username) = LOWER(?)`
                : `UPDATE users
                   SET ${walletField} = COALESCE(${walletField}, 0) + ?
                   WHERE LOWER(username) = LOWER(?)`;
            const params = walletField === 'balance'
                ? [amount, amount, withdrawal.username]
                : [amount, withdrawal.username];
            const refundResult = await dbRunAsync(updateSql, params);
            if (!refundResult.changes) throw apiError(404, 'Withdrawal user no longer exists.');

            const updateResult = await dbRunAsync(
                `UPDATE withdrawals
                 SET status = 'declined', admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
                 WHERE id = ? AND status = 'pending'`,
                [note || 'Your withdrawal was declined. Please contact support for assistance.', req.user.username, id]
            );
            if (!updateResult.changes) throw apiError(409, 'Withdrawal was already processed.');
        }, 'decline_withdrawal');

        console.warn(`[ADMIN] Withdrawal ${id} declined by ${req.user.username}`);
        return res.json({ success: true, message: "Withdrawal declined and refunded!" });
    } catch (error) {
        console.error('Decline withdrawal error:', error.message);
        return sendApiError(res, error, 'Unable to decline withdrawal.');
    }
});

app.get('/api/user/withdrawals', authenticateToken, (req, res) => {
    const username = req.user.username;
    db.all(`SELECT id, amount, wallet_type, status, admin_note, created_at, reviewed_at
            FROM withdrawals WHERE username = ? ORDER BY created_at DESC`, [username], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, withdrawals: rows || [] });
    });
});

app.get('/api/user/pending-withdrawal', authenticateToken, (req, res) => {
    const username = req.user.username;
    db.get(`SELECT id, status FROM withdrawals
            WHERE LOWER(username) = LOWER(?) AND status IN ('pending', 'processing')
            LIMIT 1`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, hasPending: !!row, status: row ? row.status : null });
    });
});

// Keep this single-segment fallback route after the more specific /api/user/*
// routes above; otherwise Express would treat /withdrawals and
// /pending-withdrawal as usernames.
app.get('/api/user/:username', authenticateToken, async (req, res) => {
    const requestedUsername = String(req.params.username || '').trim();
    if (req.user.role !== 'admin' && String(req.user.username).toLowerCase() !== requestedUsername.toLowerCase()) {
        return res.status(403).json({ error: "Unauthorized access to another user's profile" });
    }
    try {
        const user = await dbGetAsync(
            `SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance,
                    my_referral_id, referred_by, planActivated, activePackage, activePackageId, role,
                    full_name, phone, bank_name, bank_account_number, bank_account_holder, created_at
             FROM users WHERE LOWER(username) = LOWER(?)`,
            [requestedUsername]
        );
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.json({ success: true, user: await serializeUserWithEntitlement(user) });
    } catch (error) {
        return sendApiError(res, error, 'Unable to load user profile.');
    }
});


// ==========================================
// 5. DEPOSIT REQUESTS (User initiated) — MANUAL PAYMENTS
// ==========================================

// Public: manual transfer account details shown to users.
app.get('/api/payment/manual-info', (req, res) => {
    res.json({ success: true, payment: getManualPaymentInfo() });
});

// Helper to strip heavy receipt data out of JSON list responses.
function stripReceipt(deposit) {
    if (!deposit) return deposit;
    const clone = { ...deposit };
    if (clone.receipt) {
        clone.has_receipt = true;
        delete clone.receipt;
        delete clone.receipt_mime;
    } else {
        clone.has_receipt = false;
    }
    return clone;
}

// Validates the receipt whether it arrived as a base64 data URL (legacy JSON
// body) or as a streamed multipart file (the mobile-friendly path added to fix
// upload hangs/refreshes on phones). Returns { mime, data } where data is the
// base64 string stored in SQLite, or sends a 400 and returns null.
function resolveReceipt(req, res) {
    // Preferred path: multipart/form-data file upload. req.file is populated by
    // the multer middleware. This streams the bytes off the socket with no
    // base64 inflation in the browser, which is what makes mobile reliable.
    if (req.file && req.file.buffer) {
        if (req.file.buffer.length === 0) {
            res.status(400).json({ error: "Receipt file appears to be empty." });
            return null;
        }
        if (req.file.buffer.length > MAX_RECEIPT_SIZE) {
            res.status(400).json({ error: "Receipt file is too large. Maximum size is 5MB. Please choose a smaller or compressed photo." });
            return null;
        }
        return {
            mime: req.file.mimetype,
            data: req.file.buffer.toString('base64')
        };
    }

    // Legacy path: base64 data URL inside JSON. Kept for backward compatibility
    // with existing clients (especially desktop), but new/mobile clients should
    // use multipart uploads instead.
    const receipt = req.body && req.body.receipt;
    if (receipt) {
        const parsed = parseDataUrl(receipt);
        if (!parsed) {
            res.status(400).json({ error: "Invalid receipt format. Please upload a valid image (PNG/JPG/PDF)." });
            return null;
        }
        if (!/^image\/(png|jpe?g|gif|webp)$/.test(parsed.mime) && parsed.mime !== 'application/pdf') {
            res.status(400).json({ error: "Receipt must be a PNG, JPG, GIF, WEBP or PDF file." });
            return null;
        }
        if (parsed.buffer.length === 0) {
            res.status(400).json({ error: "Receipt file appears to be empty." });
            return null;
        }
        if (parsed.buffer.length > MAX_RECEIPT_SIZE) {
            res.status(400).json({ error: "Receipt file is too large. Maximum size is 5MB. Please choose a smaller or compressed photo." });
            return null;
        }
        return {
            mime: parsed.mime,
            data: parsed.buffer.toString('base64')
        };
    }

    res.status(400).json({ error: "Please upload your payment receipt to complete the deposit request." });
    return null;
}

// Shared deposit-submission logic used by both the JSON and multipart routes.
async function handleDepositRequest(req, res) {
    try {
        // Guarantee the deposits table has all columns referenced by the INSERT
        // below before we attempt it. On existing production DBs these columns
        // may be missing because they were only declared in CREATE TABLE IF NOT
        // EXISTS, which is a no-op once the table exists.
        await ensureDepositSchema();

        // For multipart requests, text fields land in req.body (already parsed
        // by multer). Coerce defensively for both content types.
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const amount = toFiniteNumber(body.amount);
        const paymentMethod = typeof body.payment_method === 'string'
            ? body.payment_method.trim().slice(0, 100)
            : 'bank_transfer';
        const transactionReference = typeof body.transaction_ref === 'string'
            ? body.transaction_ref.trim().slice(0, 150)
            : '';
        const senderName = typeof body.sender_name === 'string'
            ? body.sender_name.trim().slice(0, 150)
            : '';
        const username = req.user.username;

        if (amount === null || amount < 1000) {
            return res.status(400).json({ error: "Minimum deposit amount is ₦1,000" });
        }

        if (!getManualPaymentInfo().enabled) {
            return res.status(403).json({ error: "Manual deposits are currently disabled." });
        }

        const resolved = resolveReceipt(req, res);
        if (!resolved) return; // 400 already sent
        const receiptData = resolved.data;
        const receiptMime = resolved.mime;

        await withSqliteTransaction(async () => {
            const userRow = await dbGetAsync(
                `SELECT id FROM users WHERE LOWER(username) = LOWER(?)`,
                [username]
            );
            if (!userRow) throw apiError(404, 'User no longer exists.');

            // Idempotency guard: the transaction and insert are in the same
            // transaction so two retries cannot both pass the check.
            if (transactionReference) {
                const existing = await dbGetAsync(
                    `SELECT id, status FROM deposits
                     WHERE LOWER(username) = LOWER(?) AND transaction_ref = ?
                     LIMIT 1`,
                    [username, transactionReference]
                );
                if (existing) {
                    if (existing.status === 'pending') {
                        throw apiError(
                            409,
                            "This deposit request was already submitted and is awaiting admin approval.",
                            'DEPOSIT_ALREADY_PENDING'
                        );
                    }
                    throw apiError(409, "This transaction reference has already been processed.", 'DEPOSIT_ALREADY_PROCESSED');
                }
            }

            await dbRunAsync(
                `INSERT INTO deposits (username, user_id, amount, sender_name, status, payment_method, transaction_ref, receipt, receipt_mime)
                 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
                [
                    username,
                    userRow.id,
                    amount,
                    senderName || username,
                    paymentMethod || 'bank_transfer',
                    transactionReference || null,
                    receiptData,
                    receiptMime
                ]
            );
        }, 'deposit_insert');

        res.json({
            success: true,
            message: "Deposit request submitted. Your receipt has been uploaded and is awaiting admin approval."
        });
    } catch (error) {
        if (error?.code === 'DEPOSIT_ALREADY_PENDING') {
            return res.json({
                success: true,
                already_submitted: true,
                message: error.message
            });
        }
        console.error('Deposit request error:', error.message);
        return sendApiError(res, error, "Server error. Please try again.");
    }
}

// Multipart (streaming) endpoint — recommended for mobile clients. The file is
// sent as a normal binary form field ("receipt"), avoiding the base64 memory
// blow-up that caused mobile browsers to hang or refresh.
app.post('/api/request-deposit/upload', authenticateToken, actionLimiter, uploadReceipt, handleDepositRequest);

// Legacy JSON endpoint. Kept for backward compatibility with existing desktop
// clients that POST a base64 data URL in the JSON body.
app.post('/api/request-deposit', authenticateToken, actionLimiter, handleDepositRequest);

// User: their own deposit history.
// Uses /api/my-deposits so the path remains explicit and cannot be confused
// with a single-segment user profile route.
app.get('/api/my-deposits', authenticateToken, async (req, res) => {
    const username = req.user.username;
    try {
        const rows = await dbAllAsync(
            `SELECT id, amount, sender_name, payment_method, transaction_ref, status, admin_note, receipt, receipt_mime, created_at, reviewed_at
             FROM deposits WHERE username = ? ORDER BY created_at DESC`,
            [username]
        );
        const cleaned = rows.map((row) => ({
            id: row.id,
            amount: row.amount,
            sender_name: row.sender_name,
            payment_method: row.payment_method,
            transaction_ref: row.transaction_ref,
            status: row.status,
            admin_note: row.admin_note,
            created_at: row.created_at,
            reviewed_at: row.reviewed_at
        }));
        res.json({ success: true, deposits: cleaned });
    } catch (error) {
        res.status(500).json({ error: "Failed to load deposits." });
    }
});

// User: view their own receipt image.
app.get('/api/user/deposit/:id/receipt', authenticateToken, async (req, res) => {
    try {
        const deposit = await dbGetAsync(`SELECT * FROM deposits WHERE id = ?`, [req.params.id]);
        if (!deposit) return res.status(404).json({ error: "Deposit not found." });
        if (String(deposit.username || '').toLowerCase() !== String(req.user.username || '').toLowerCase() && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized." });
        }
        if (!deposit.receipt) return res.status(404).json({ error: "No receipt uploaded for this deposit." });
        const buffer = Buffer.from(deposit.receipt, 'base64');
        res.setHeader('Content-Type', deposit.receipt_mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="deposit-${deposit.id}-receipt"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: "Failed to load receipt." });
    }
});

// Admin: list deposits (filtered by status via query ?status=). Defaults to pending.
app.get('/api/admin/deposits', authenticateToken, adminOnly, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const allowed = ['pending', 'approved', 'declined', 'all'];
        const where = allowed.includes(status) && status !== 'all' ? `WHERE status = ?` : '';
        const params = allowed.includes(status) && status !== 'all' ? [status] : [];
        const rows = await dbAllAsync(
            `SELECT * FROM deposits ${where} ORDER BY created_at DESC`,
            params
        );
        res.json({ success: true, deposits: rows.map(stripReceipt) });
    } catch (error) {
        res.status(500).json({ error: "Failed to load deposits." });
    }
});

// Admin: all deposit history.
app.get('/api/admin/all-deposits', authenticateToken, adminOnly, async (req, res) => {
    try {
        const rows = await dbAllAsync(`SELECT * FROM deposits ORDER BY created_at DESC`, []);
        res.json({ success: true, deposits: rows.map(stripReceipt) });
    } catch (error) {
        res.status(500).json({ error: "Failed to load deposits." });
    }
});

// Admin: view a deposit receipt image.
app.get('/api/admin/deposit/:id/receipt', authenticateToken, adminOnly, async (req, res) => {
    try {
        const deposit = await dbGetAsync(`SELECT * FROM deposits WHERE id = ?`, [req.params.id]);
        if (!deposit) return res.status(404).json({ error: "Deposit not found." });
        if (!deposit.receipt) return res.status(404).json({ error: "No receipt uploaded for this deposit." });
        const buffer = Buffer.from(deposit.receipt, 'base64');
        res.setHeader('Content-Type', deposit.receipt_mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="deposit-${deposit.id}-receipt"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: "Failed to load receipt." });
    }
});

// Admin: approve a pending manual deposit (credits the user's balance).
app.post('/api/admin/approve-deposit', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const depositId = body.depositId;
    if (!depositId) return res.status(400).json({ error: "Deposit ID required" });

    try {
        const deposit = await withSqliteTransaction(async () => {
            const pendingDeposit = await dbGetAsync(
                `SELECT * FROM deposits WHERE id = ? AND status = 'pending'`,
                [depositId]
            );
            if (!pendingDeposit) throw apiError(409, "Deposit already processed or not pending.");
            const amount = toFiniteNumber(pendingDeposit.amount);
            if (amount === null || amount <= 0) throw new Error('Deposit contains an invalid amount.');

            const creditResult = await dbRunAsync(
                `UPDATE users SET
                    balance = COALESCE(balance, 0) + ?,
                    wallet_balance = COALESCE(wallet_balance, 0) + ?
                 WHERE LOWER(username) = LOWER(?)`,
                [amount, amount, pendingDeposit.username]
            );
            if (!creditResult.changes) throw apiError(404, "Deposit user no longer exists.");

            const updateResult = await dbRunAsync(
                `UPDATE deposits
                 SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
                 WHERE id = ? AND status = 'pending'`,
                [req.user.username, pendingDeposit.id]
            );
            if (!updateResult.changes) throw apiError(409, "Deposit was already processed.");
            return { ...pendingDeposit, amount };
        }, 'approve_deposit');

        try {
            await recordAdminAction(req.user.username, deposit.username, 'deposit_approve', {
                depositId: deposit.id,
                amount: deposit.amount
            });
        } catch (error) {
            console.warn('Deposit audit log failed:', error.message);
        }

        console.warn(`[ADMIN] Deposit ${deposit.id} approved by ${req.user.username}`);
        return res.json({ success: true, message: `Deposit of ₦${deposit.amount} approved and credited to ${deposit.username}` });
    } catch (error) {
        console.error('Approve deposit error:', error.message);
        return sendApiError(res, error, "Failed to approve deposit.");
    }
});

// Admin: decline a pending manual deposit.
app.post('/api/admin/decline-deposit', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { depositId, note } = body;
    if (!depositId) return res.status(400).json({ error: "Deposit ID required" });
    try {
        const result = await dbRunAsync(
            `UPDATE deposits SET status = 'declined', admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
            [note || 'Your deposit was declined. Please contact support.', req.user.username, depositId]
        );
        if (result.changes === 0) return res.status(400).json({ error: "Deposit not found or already processed." });
        console.warn(`[ADMIN] Deposit ${depositId} declined by ${req.user.username}`);
        res.json({ success: true, message: "Deposit declined." });
    } catch (error) {
        console.error('Decline deposit error:', error.message);
        res.status(500).json({ error: "Failed to decline deposit." });
    }
});

// ==========================================
// 6. DAILY TASK CLAIM
// ==========================================
app.post('/api/claim-daily-task', authenticateToken, actionLimiter, async (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const claimDate = getClaimDate();

    try {
        const userRecord = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [userId]);
        if (!userRecord) return res.status(404).json({ error: 'User not found.' });

        const entitlement = await resolveActiveEntitlement(userRecord);
        const amount = entitlement ? toFiniteNumber(entitlement.daily_earning) : null;
        if (!entitlement || amount === null || amount <= 0) {
            return res.status(403).json({
                error: 'Activate your account',
                code: 'PLAN_REQUIRED'
            });
        }

        const result = await withSqliteTransaction(async () => {
            const user = await dbGetAsync(
                `SELECT id, username, taskEarnings FROM users WHERE id = ?`,
                [userId]
            );
            if (!user) throw apiError(404, 'User not found.');

            const lastClaim = await dbGetAsync(
                `SELECT id, amount, claim_date, created_at FROM daily_claims
                 WHERE LOWER(username) = LOWER(?)
                 ORDER BY datetime(created_at) DESC, id DESC
                 LIMIT 1`,
                [username]
            );
            if (lastClaim) {
                const lastClaimAt = parseSqliteDate(lastClaim.created_at);
                if (lastClaimAt && (Date.now() - lastClaimAt.getTime()) < CLAIM_COOLDOWN_MS) {
                    const duplicate = apiError(
                        400,
                        "You have already claimed your daily earnings. Please wait 24 hours.",
                        'ALREADY_CLAIMED'
                    );
                    duplicate.claimedAmount = Number(lastClaim.amount || 0);
                    duplicate.nextClaimAt = nextClaimAtFrom(lastClaimAt);
                    throw duplicate;
                }
            }

            const sameDay = await dbGetAsync(
                `SELECT id, amount, created_at FROM daily_claims
                 WHERE LOWER(username) = LOWER(?) AND claim_date = ?
                 LIMIT 1`,
                [username, claimDate]
            );
            if (sameDay) {
                const sameDayAt = parseSqliteDate(sameDay.created_at) || new Date();
                const duplicate = apiError(
                    400,
                    "You have already claimed your daily earnings today. Come back tomorrow!",
                    'ALREADY_CLAIMED'
                );
                duplicate.claimedAmount = Number(sameDay.amount || 0);
                duplicate.nextClaimAt = nextClaimAtFrom(sameDayAt);
                throw duplicate;
            }

            const currentTaskEarnings = toFiniteNumber(user.taskEarnings) || 0;
            const newTaskEarnings = currentTaskEarnings + amount;
            await dbRunAsync(
                `INSERT INTO daily_claims (username, claim_date, amount) VALUES (?, ?, ?)`,
                [username, claimDate, amount]
            );
            await dbRunAsync(
                `UPDATE users SET taskEarnings = ? WHERE id = ?`,
                [newTaskEarnings, userId]
            );
            return { newTaskEarnings };
        }, 'daily_claim');

        const refreshed = await dbGetAsync(
            `SELECT balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance
             FROM users WHERE id = ?`,
            [userId]
        );
        const nextClaimAt = nextClaimAtFrom();

        return res.json({
            success: true,
            message: `Successfully claimed ₦${amount.toLocaleString()}!`,
            claimed_amount: amount,
            dailyEarning: amount,
            newBalance: result.newTaskEarnings,
            next_claim_at: nextClaimAt,
            balances: refreshed ? {
                balance: Number(refreshed.balance ?? 0),
                wallet_balance: Number(refreshed.wallet_balance ?? 0),
                taskEarnings: Number(refreshed.taskEarnings ?? 0),
                daily_earnings: Number(refreshed.daily_earnings ?? 0),
                affiliate_balance: Number(refreshed.affiliate_balance ?? 0)
            } : null
        });
    } catch (error) {
        if (error?.code === 'ALREADY_CLAIMED') {
            return res.status(400).json({
                error: error.message,
                already_claimed: true,
                claimed_amount: error.claimedAmount || 0,
                next_claim_at: error.nextClaimAt || nextClaimAtFrom()
            });
        }
        if (String(error?.message || '').includes('UNIQUE constraint failed') && String(error?.message || '').includes('daily_claims')) {
            return res.status(400).json({
                error: "You have already claimed your daily earnings today. Come back tomorrow!",
                already_claimed: true,
                next_claim_at: nextClaimAtFrom()
            });
        }
        console.error('Claim daily task error:', error.message);
        return sendApiError(res, error, 'Unable to claim daily earnings. Please try again.');
    }
});

// ==========================================
// 7. LIVE CHAT / CUSTOMER SUPPORT API
// ==========================================
app.get('/api/chat/history/:username', authenticateToken, (req, res) => {
    const requestedUsername = String(req.params.username || '').trim();
    const ownUsername = String(req.user.username || '').trim();
    if (req.user.role !== 'admin' && req.user.role !== 'support' && ownUsername.toLowerCase() !== requestedUsername.toLowerCase()) {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    db.all(`SELECT * FROM messages WHERE LOWER(user_id) = LOWER(?) ORDER BY id ASC`, [requestedUsername], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load messages" });
        res.json({ success: true, messages: rows || [] });
    });
});

app.post('/api/chat/send', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const sender = req.user.username;
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) return res.status(400).json({ error: "Message cannot be empty" });
        if (message.length > 5000) return res.status(400).json({ error: "Message is too long. Maximum length is 5,000 characters." });

        const requestedTarget = body.user_id === undefined || body.user_id === null
            ? sender
            : String(body.user_id).trim();
        const privileged = req.user.role === 'admin' || req.user.role === 'support';
        if (!privileged && requestedTarget.toLowerCase() !== sender.toLowerCase()) {
            return res.status(403).json({ error: "You can only send messages to your own support conversation." });
        }

        await dbRunAsync(
            `INSERT INTO messages (user_id, sender, message) VALUES (?, ?, ?)`,
            [requestedTarget || sender, sender, message]
        );
        return res.json({ success: true, message: "Message sent" });
    } catch (error) {
        console.error('Chat send error:', error.message);
        return sendApiError(res, error, 'Failed to save message.');
    }
});

app.get('/api/support/users', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT DISTINCT user_id FROM messages`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load support users" });
        res.json({ success: true, users: rows || [] });
    });
});

app.get('/api/support/all-users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'support') {
        return res.status(403).json({ error: "Access denied" });
    }
    db.all(`SELECT username, created_at FROM users ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, users: rows || [] });
    });
});

app.post('/api/chat/welcome', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const welcomeMessage = "👋 Hello! I'm an Access Wealth support agent. How may I help you today?";
        const existing = await dbGetAsync(
            `SELECT id FROM messages WHERE LOWER(user_id) = LOWER(?) LIMIT 1`,
            [username]
        );
        if (existing) return res.json({ success: true, message: "Already has messages" });
        await dbRunAsync(
            `INSERT INTO messages (user_id, sender, message) VALUES (?, 'support', ?)`,
            [username, welcomeMessage]
        );
        return res.json({ success: true, message: "Welcome message sent" });
    } catch (error) {
        console.error('Chat welcome error:', error.message);
        return sendApiError(res, error, "Failed to send welcome message.");
    }
});

// ==========================================
// 8. ADMIN COMMAND CENTER & UTILITIES
// ==========================================
const ADMIN_WALLET_COLUMNS = {
    balance: 'balance',
    taskEarnings: 'taskEarnings',
    daily_earnings: 'daily_earnings',
    affiliate_balance: 'affiliate_balance'
};

function getAdminWalletColumn(walletType) {
    return ADMIN_WALLET_COLUMNS[walletType] || null;
}

async function recordAdminAction(adminUsername, targetUsername, action, details = {}) {
    await dbRunAsync(
        `INSERT INTO admin_activity_log (admin_username, target_username, action, details)
         VALUES (?, ?, ?, ?)`,
        [adminUsername, targetUsername, action, JSON.stringify(details)]
    );
}

app.post('/api/admin/adjust-balance', authenticateToken, adminOnly, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const walletType = body.walletType;
        const action = body.action;
        const column = getAdminWalletColumn(walletType);
        const numericAmount = toFiniteNumber(body.amount);
        if (!username || !isValidAmount(numericAmount) || !column) {
            return res.status(400).json({ error: "Username and valid amount required" });
        }
        if (!['add', 'subtract'].includes(action)) return res.status(400).json({ error: 'Action must be add or subtract.' });
        const operator = action === 'subtract' ? '-' : '+';
        const minimumCheck = action === 'subtract' ? `AND COALESCE(${column}, 0) >= ?` : '';
        const params = action === 'subtract' ? [numericAmount, username, numericAmount] : [numericAmount, username];
        let updateSql, finalParams;
        if (column === 'balance') {
            updateSql = `UPDATE users SET balance = COALESCE(balance, 0) ${operator} ?, wallet_balance = COALESCE(wallet_balance, 0) ${operator} ?
                         WHERE LOWER(username) = LOWER(?) ${minimumCheck.replace(column, 'balance')}`;
            finalParams = action === 'subtract' ? [numericAmount, numericAmount, username, numericAmount] : [numericAmount, numericAmount, username];
        } else {
            updateSql = `UPDATE users SET ${column} = COALESCE(${column}, 0) ${operator} ?
                         WHERE LOWER(username) = LOWER(?) ${minimumCheck}`;
            finalParams = params;
        }

        const result = await dbRunAsync(updateSql, finalParams);
        if (!result.changes) return res.status(400).json({ error: action === 'subtract' ? 'User not found or wallet has insufficient balance.' : 'User not found.' });
        try {
            await recordAdminAction(req.user.username, username, `wallet_${action}`, { wallet: column, amount: numericAmount });
        } catch (auditError) {
            console.warn('Wallet adjustment audit log failed:', auditError.message);
        }
        console.warn(`[ADMIN] ${action === 'subtract' ? 'Subtracted' : 'Added'} ₦${numericAmount} to ${username}'s ${column} by ${req.user.username}`);
        return res.json({ success: true, message: `Successfully ${action === 'subtract' ? 'subtracted' : 'added'} ₦${numericAmount} to ${username}'s wallet!` });
    } catch (error) {
        console.error("Adjust balance error:", error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

// Manual credit: admin adds funds to any wallet. Supports walletType: 'balance', 'taskEarnings',
// 'daily_earnings', 'affiliate_balance'. Returns the updated balance.
app.post('/api/admin/manual-credit', authenticateToken, adminOnly, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const walletType = body.walletType;
        const numericAmount = toFiniteNumber(body.amount);

        if (!username || !isValidAmount(numericAmount)) {
            return res.status(400).json({ error: "Username and valid amount required" });
        }

        const walletColumn = getAdminWalletColumn(walletType || 'balance');
        if (!walletColumn) {
            return res.status(400).json({ error: "Invalid wallet type. Use balance, taskEarnings, daily_earnings or affiliate_balance." });
        }

        const user = await dbGetAsync(`SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`, [username]);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        let updateSql, params;
        if (walletColumn === 'balance') {
            updateSql = `UPDATE users SET balance = COALESCE(balance, 0) + ?, wallet_balance = COALESCE(wallet_balance, 0) + ?
                         WHERE LOWER(username) = LOWER(?)`;
            params = [numericAmount, numericAmount, username];
        } else {
            updateSql = `UPDATE users SET ${walletColumn} = COALESCE(${walletColumn}, 0) + ?
                         WHERE LOWER(username) = LOWER(?)`;
            params = [numericAmount, username];
        }

        const result = await dbRunAsync(updateSql, params);
        if (!result.changes) {
            return res.status(400).json({ error: "User not found" });
        }

        try {
            await recordAdminAction(req.user.username, username, 'manual_credit', { wallet: walletColumn, amount: numericAmount });
        } catch (auditError) {
            console.warn('Manual credit audit log failed:', auditError.message);
        }

        const updated = await dbGetAsync(
            `SELECT balance, taskEarnings, daily_earnings, affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );

        console.warn(`[ADMIN] Manual credit of ₦${numericAmount} to ${username}'s ${walletColumn} by ${req.user.username}`);
        res.json({
            success: true,
            message: `Successfully credited ₦${numericAmount} to ${username}'s wallet!`,
            updatedBalance: updated
        });
    } catch (error) {
        console.error('Manual credit error:', error.message);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

app.post('/api/admin/change-user-plan', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const packageId = typeof body.packageId === 'string' ? body.packageId.trim().toLowerCase() : '';
    const selectedPackage = PACKAGE_BY_ID[packageId];
    if (!username || !selectedPackage) return res.status(400).json({ error: 'A valid username and package are required.' });

    let transactionOpen = false;
    try {
        const user = await dbGetAsync(`SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`, [username]);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        transactionOpen = true;
        await dbRunAsync(
            `UPDATE user_investments SET status = 'replaced_by_admin', completed_at = datetime('now')
             WHERE user_id = ? AND status = 'active'`,
            [user.id]
        );
        await dbRunAsync(
            `UPDATE users SET planActivated = 'true', activePackage = ?, activePackageId = ? WHERE id = ?`,
            [selectedPackage.name, selectedPackage.id, user.id]
        );
        await dbRunAsync(
            `INSERT INTO user_investments
             (user_id, username, package_id, package_name, capital, daily_rate, cycle_days, daily_earning, total_payout, referral_bonus, days_credited, status, activated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', datetime('now'))`,
            [user.id, user.username, selectedPackage.id, selectedPackage.name, selectedPackage.capital,
                selectedPackage.daily_rate, selectedPackage.cycle_days, selectedPackage.daily_earning,
                selectedPackage.total_payout, getReferralBonus(selectedPackage)]
        );
        await recordAdminAction(req.user.username, user.username, 'change_plan', { packageId: selectedPackage.id, packageName: selectedPackage.name });
        await dbRunAsync('COMMIT');
        transactionOpen = false;
        res.json({ success: true, message: `${user.username} is now on the ${selectedPackage.name} plan. Wallet balances were not changed.` });
    } catch (error) {
        if (transactionOpen) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
        }
        console.error('Admin plan change failed:', error.message);
        res.status(500).json({ error: 'Unable to update the user plan.' });
    }
});

app.post('/api/admin/clear-total-balance', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation.trim() : '';
    if (!username || confirmation !== `CLEAR ${username}`) {
        return res.status(400).json({ error: 'Confirmation must exactly match CLEAR followed by the username.' });
    }
    try {
        const user = await dbGetAsync(
            `SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance
             FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const totalCleared = ['balance', 'wallet_balance', 'taskEarnings', 'daily_earnings', 'affiliate_balance']
            .reduce((sum, key) => sum + Number(user[key] || 0), 0);
        await dbRunAsync(
            `UPDATE users SET balance = 0, wallet_balance = 0, taskEarnings = 0, daily_earnings = 0, affiliate_balance = 0 WHERE id = ?`,
            [user.id]
        );
        try {
            await recordAdminAction(req.user.username, user.username, 'clear_total_balance', { totalCleared });
        } catch (auditError) {
            console.warn('Clear balance audit log failed:', auditError.message);
        }
        res.json({ success: true, message: `Cleared ₦${totalCleared.toLocaleString()} across all liquid wallet balances for ${user.username}. Active plans were not changed.`, totalCleared });
    } catch (error) {
        console.error('Clear total balance failed:', error.message);
        res.status(500).json({ error: 'Unable to clear the user balance.' });
    }
});

app.get('/api/admin/users', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance, planActivated, activePackage, activePackageId, role, status, created_at FROM users ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, users: rows });
    });
});

app.get('/api/site-settings', authenticateToken, (req, res) => {
    db.all(`SELECT key, value FROM site_settings ORDER BY key`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        const settings = Object.fromEntries((rows || []).map(row => [row.key, row.value]));
        res.json({ success: true, settings });
    });
});

app.post('/api/admin/settings', authenticateToken, adminOnly, async (req, res) => {
    try {
        const updates = req.body && typeof req.body === 'object' ? req.body : {};
        const allowedSettings = new Set([
            'maintenance_mode',
            'registrations_open',
            'deposits_open',
            'withdrawals_open',
            'sponsored_posts_open'
        ]);
        const entries = Object.entries(updates)
            .filter(([key]) => allowedSettings.has(key));
        if (!entries.length) return res.status(400).json({ error: "No valid settings provided" });

        await withSqliteTransaction(async () => {
            for (const [key, value] of entries) {
                const normalizedValue = String(value).toLowerCase();
                if (!['true', 'false'].includes(normalizedValue)) {
                    throw apiError(400, `${key} must be true or false.`);
                }
                await dbRunAsync(
                    `INSERT INTO site_settings (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    [key, normalizedValue]
                );
            }
        }, 'admin_settings');
        return res.json({ success: true, message: "Settings updated successfully" });
    } catch (error) {
        return sendApiError(res, error, "Failed to save settings.");
    }
});

app.post('/api/admin/toggle-user-status', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
    if (!username || !['active', 'banned'].includes(status)) {
        return res.status(400).json({ error: "Username and status must be provided. Status must be active or banned." });
    }
    if (username.toLowerCase() === String(req.user.username).toLowerCase()) {
        return res.status(400).json({ error: "You cannot change your own admin status." });
    }
    try {
        const result = await dbRunAsync(
            `UPDATE users SET status = ? WHERE LOWER(username) = LOWER(?) AND role != 'admin'`,
            [status, username]
        );
        if (!result.changes) return res.status(404).json({ error: "User not found or is an admin" });
        return res.json({ success: true, message: `User ${username} is now ${status}` });
    } catch (error) {
        return sendApiError(res, error, 'Unable to update user status.');
    }
});

app.get('/api/admin/stats', authenticateToken, adminOnly, async (req, res) => {
    try {
        const [users, activePlans, revenue, pendingDeposits, pendingWithdrawals] = await Promise.all([
            dbGetAsync("SELECT COUNT(*) AS count FROM users"),
            dbGetAsync("SELECT COUNT(*) AS count FROM users WHERE LOWER(CAST(planActivated AS TEXT)) IN ('true', '1')"),
            dbGetAsync(`SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE status = 'approved'`),
            dbGetAsync("SELECT COUNT(*) AS count FROM deposits WHERE status = 'pending'"),
            dbGetAsync("SELECT COUNT(*) AS count FROM withdrawals WHERE status IN ('pending', 'processing')")
        ]);
        return res.json({
            success: true,
            stats: {
                totalUsers: Number(users?.count || 0),
                activePlans: Number(activePlans?.count || 0),
                revenue: Number(revenue?.total || 0),
                pendingDeposits: Number(pendingDeposits?.count || 0),
                pendingWithdrawals: Number(pendingWithdrawals?.count || 0)
            }
        });
    } catch (error) {
        console.error('Admin stats error:', error.message);
        return sendApiError(res, error, 'Unable to load admin statistics.');
    }
});

app.get('/api/admin/migrations/legacy-plans/status', authenticateToken, adminOnly, async (req, res) => {
    try {
        const row = await dbGetAsync(
            `SELECT migration_key, status, started_by, notes, started_at, completed_at, updated_at
             FROM system_migrations
             WHERE migration_key = ?`,
            ['legacy_plan_reset_v1']
        );

        if (!row) {
            return res.json({
                success: true,
                status: 'not_started',
                migration: null
            });
        }

        res.json({ success: true, status: row.status, migration: row });
    } catch (error) {
        res.status(500).json({ error: `Failed to fetch migration status: ${error.message}` });
    }
});

app.post('/api/admin/migrations/legacy-plans/run', authenticateToken, adminOnly, async (req, res) => {
    return res.status(403).json({
        success: false,
        error: 'Legacy plan reset is disabled. Existing active and legacy plans are preserved.',
        code: 'LEGACY_RESET_DISABLED'
    });
});

// ==========================================
// 9. REFERRAL SYSTEM ENDPOINTS
// ==========================================
app.get('/api/referral/stats/:username', authenticateToken, async (req, res) => {
    const username = String(req.params.username || '').trim();
    const isPrivileged = req.user.role === 'admin' || req.user.role === 'support';
    if (!isPrivileged && String(req.user.username).toLowerCase() !== username.toLowerCase()) {
        return res.status(403).json({ error: "Unauthorized access" });
    }

    try {
        const user = await dbGetAsync(
            `SELECT my_referral_id, affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );
        if (!user) return res.status(404).json({ error: "User not found" });
        const [stats, referrals] = await Promise.all([
            dbGetAsync(`SELECT COUNT(*) AS count FROM users WHERE referred_by = ?`, [user.my_referral_id]),
            dbAllAsync(`SELECT username, created_at, planActivated
                        FROM users WHERE referred_by = ? ORDER BY created_at DESC`, [user.my_referral_id])
        ]);
        return res.json({
            success: true,
            totalReferrals: Number(stats?.count || 0),
            earnings: Number(user.affiliate_balance || 0),
            referrals
        });
    } catch (error) {
        return sendApiError(res, error, 'Unable to load referral statistics.');
    }
});

app.get('/api/referral/leaderboard', (req, res) => {
    // Show only activated referrals count (users who purchased plans)
    db.all(`SELECT username, affiliate_balance as total_earned, (SELECT COUNT(*) FROM users WHERE referred_by = u.my_referral_id AND LOWER(CAST(planActivated AS TEXT)) IN ('true', '1')) as referral_count FROM users u WHERE role = 'user' ORDER BY affiliate_balance DESC LIMIT 10`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, leaderboard: rows || [] });
    });
});

// ==========================================
// 10. USER PROFILE & BANK DETAILS
// ==========================================
app.get('/api/user/profile/:username', authenticateToken, (req, res) => {
    if (String(req.user.username).toLowerCase() !== String(req.params.username).toLowerCase() && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Unauthorized" });
    }
    db.get(`SELECT full_name, phone, bank_name, bank_account_number, bank_account_holder FROM users WHERE LOWER(username) = LOWER(?)`,
        [req.params.username], (err, profile) => {
            if (err) return res.status(500).json({ error: "Database error" });
            res.json({ success: true, profile: profile || {} });
        });
});

app.post('/api/user/update-profile', authenticateToken, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const fullName = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 120) : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
        if (!fullName || !phone) {
            return res.status(400).json({ error: "Full name and phone number are required" });
        }
        await dbRunAsync(
            `UPDATE users SET full_name = ?, phone = ? WHERE LOWER(username) = LOWER(?)`,
            [fullName, phone, req.user.username]
        );
        return res.json({ success: true, message: "Profile updated successfully" });
    } catch (error) {
        return sendApiError(res, error, 'Unable to update your profile.');
    }
});

app.post('/api/user/update-bank', authenticateToken, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const bankName = typeof body.bank_name === 'string' ? body.bank_name.trim().slice(0, 120) : '';
        const accountNumber = typeof body.account_number === 'string' ? body.account_number.trim() : '';
        const accountHolder = typeof body.account_holder === 'string' ? body.account_holder.trim().slice(0, 120) : '';
        if (!bankName || !accountNumber || !accountHolder) {
            return res.status(400).json({ error: "All bank fields are required" });
        }
        if (!/^\d{6,20}$/.test(accountNumber)) {
            return res.status(400).json({ error: "Account number must contain 6 to 20 digits" });
        }
        await dbRunAsync(
            `UPDATE users SET bank_name = ?, bank_account_number = ?, bank_account_holder = ?
             WHERE LOWER(username) = LOWER(?)`,
            [bankName, accountNumber, accountHolder, req.user.username]
        );
        return res.json({ success: true, message: "Bank details saved successfully" });
    } catch (error) {
        return sendApiError(res, error, 'Unable to save bank details.');
    }
});

app.post('/api/user/change-password', authenticateToken, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
        const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
        if (!currentPassword || newPassword.length < 6) {
            return res.status(400).json({ error: "Current password and new password (min 6 chars) required" });
        }
        const user = await dbGetAsync(
            `SELECT password FROM users WHERE LOWER(username) = LOWER(?)`,
            [req.user.username]
        );
        if (!user) return res.status(404).json({ error: "User not found" });
        const valid = await bcryptjs.compare(currentPassword, user.password);
        if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
        const hashed = await bcryptjs.hash(newPassword, 10);
        await dbRunAsync(
            `UPDATE users SET password = ? WHERE LOWER(username) = LOWER(?)`,
            [hashed, req.user.username]
        );
        return res.json({ success: true, message: "Password changed successfully" });
    } catch (error) {
        return sendApiError(res, error, 'Unable to change password.');
    }
});

// ==========================================
// 11. ADMIN BROADCAST MESSAGE
// ==========================================
app.post('/api/admin/broadcast', authenticateToken, adminOnly, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : '';
        const title = typeof body.title === 'string' && body.title.trim()
            ? body.title.trim().slice(0, 200)
            : 'Admin Announcement';
        if (!message) return res.status(400).json({ error: "Message is required" });
        await dbRunAsync(
            `INSERT INTO broadcasts (title, message, created_by, created_at) VALUES (?, ?, ?, datetime('now'))`,
            [title, message, req.user.username]
        );
        return res.json({ success: true, message: "Broadcast sent to all users" });
    } catch (error) {
        return sendApiError(res, error, 'Failed to save broadcast.');
    }
});

app.get('/api/broadcasts', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, broadcasts: rows || [] });
    });
});

app.get('/api/broadcasts/all', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, broadcasts: rows || [] });
    });
});

// ==========================================
// 12. ADMIN SPONSORED POSTS MANAGEMENT
// ==========================================
app.post('/api/admin/sponsored-post', authenticateToken, adminOnly, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const description = typeof body.description === 'string' ? body.description.trim().slice(0, 5000) : '';
        const reward = toFiniteNumber(body.reward_amount);
        const requiredPlan = typeof body.required_plan === 'string' && body.required_plan.trim()
            ? body.required_plan.trim().slice(0, 120)
            : 'all';
        const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim().slice(0, 2000) : null;
        const link = typeof body.link === 'string' ? body.link.trim().slice(0, 2000) : null;
        if (!title || !description || reward === null || reward <= 0) {
            return res.status(400).json({ error: "Title, description and valid reward amount are required" });
        }
        await dbRunAsync(
            `INSERT INTO sponsored_posts (title, description, reward_amount, required_plan, image_url, link, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [title, description, reward, requiredPlan, imageUrl, link, req.user.username]
        );
        return res.json({ success: true, message: "Sponsored post created successfully" });
    } catch (error) {
        return sendApiError(res, error, 'Failed to create sponsored post.');
    }
});

app.get('/api/sponsored-posts', authenticateToken, (req, res) => {
    db.get(`SELECT activePackage FROM users WHERE id = ?`, [req.user.id], (userErr, user) => {
        if (userErr || !user) return res.status(404).json({ error: 'User not found' });
        const userPlan = user.activePackage || 'None';

        db.all(`SELECT * FROM sponsored_posts WHERE status = 'active' AND (required_plan = 'all' OR required_plan = ?) ORDER BY created_at DESC`,
            [userPlan], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true, posts: rows || [] });
        });
    });
});

app.post('/api/submit-sponsored-task', authenticateToken, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const postId = Number(body.post_id);
        const username = req.user.username;
        if (!Number.isInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Post ID required' });

        const sponsoredOpen = await getSiteSetting('sponsored_posts_open', 'true');
        if (!isTrueFlag(sponsoredOpen)) return res.status(403).json({ error: 'Sponsored posts are currently disabled.' });

        await withSqliteTransaction(async () => {
            const user = await dbGetAsync(`SELECT activePackage FROM users WHERE id = ?`, [req.user.id]);
            if (!user) throw apiError(404, 'User not found.');
            const userPlan = user.activePackage || 'None';
            const post = await dbGetAsync(
                `SELECT id FROM sponsored_posts
                 WHERE id = ? AND status = 'active'
                   AND (required_plan = 'all' OR required_plan = ?)`,
                [postId, userPlan]
            );
            if (!post) throw apiError(404, 'Post not found or your plan is not eligible.');

            const existing = await dbGetAsync(
                `SELECT id FROM sponsored_submissions WHERE post_id = ? AND LOWER(username) = LOWER(?)`,
                [postId, username]
            );
            if (existing) throw apiError(409, 'You have already submitted this task.');

            await dbRunAsync(
                `INSERT INTO sponsored_submissions (post_id, username, status) VALUES (?, ?, 'pending')`,
                [postId, username]
            );
        }, 'sponsored_submission');

        return res.json({ success: true, message: 'Task submitted for admin review!' });
    } catch (error) {
        if (String(error?.message || '').includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'You have already submitted this task.' });
        }
        return sendApiError(res, error, 'Failed to submit task.');
    }
});

app.get('/api/admin/sponsored-submissions', authenticateToken, adminOnly, (req, res) => {
    db.all(`
        SELECT s.*, p.title, p.reward_amount, p.description 
        FROM sponsored_submissions s 
        JOIN sponsored_posts p ON s.post_id = p.id 
        WHERE s.status = 'pending' 
        ORDER BY s.submitted_at ASC
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, submissions: rows || [] });
    });
});

app.post('/api/admin/approve-sponsored-submission', authenticateToken, adminOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const submissionId = body.submission_id;
    if (!submissionId) return res.status(400).json({ error: "Submission ID required" });

    try {
        const submission = await withSqliteTransaction(async () => {
            const pending = await dbGetAsync(
                `SELECT s.*, p.reward_amount
                 FROM sponsored_submissions s
                 JOIN sponsored_posts p ON p.id = s.post_id
                 WHERE s.id = ? AND s.status = 'pending'`,
                [submissionId]
            );
            if (!pending) throw apiError(409, "Submission not found or already processed.");
            const reward = toFiniteNumber(pending.reward_amount);
            if (reward === null || reward <= 0) throw new Error('Sponsored submission has an invalid reward.');

            const updateResult = await dbRunAsync(
                `UPDATE sponsored_submissions SET status = 'approved' WHERE id = ? AND status = 'pending'`,
                [submissionId]
            );
            if (!updateResult.changes) throw apiError(409, "Submission was already processed.");

            const creditResult = await dbRunAsync(
                `UPDATE users SET taskEarnings = COALESCE(taskEarnings, 0) + ?
                 WHERE LOWER(username) = LOWER(?)`,
                [reward, pending.username]
            );
            if (!creditResult.changes) throw apiError(404, 'Submission user no longer exists.');
            return { ...pending, reward_amount: reward };
        }, 'approve_sponsored_submission');

        return res.json({
            success: true,
            message: `Submission approved and ₦${submission.reward_amount.toLocaleString()} credited to ${submission.username}.`
        });
    } catch (error) {
        return sendApiError(res, error, 'Failed to approve sponsored submission.');
    }
});

app.get('/api/sponsored-submission-status/:post_id', authenticateToken, (req, res) => {
    const username = req.user.username;
    const post_id = req.params.post_id;
    db.get(`SELECT status FROM sponsored_submissions WHERE post_id = ? AND username = ?`, [post_id, username], (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, status: row ? row.status : 'not_submitted' });
    });
});

// Premium feature helper (ads, bills, sms). The charge and the feature record
// must be one SQLite transaction; otherwise a failed INSERT can permanently
// deduct a user's balance.
async function runPremiumPurchase(username, cost, insertSql, insertParams, label) {
    const numericCost = toFiniteNumber(cost);
    if (numericCost === null || numericCost <= 0) throw apiError(400, 'Invalid amount.');

    return withSqliteTransaction(async () => {
        const user = await dbGetAsync(
            `SELECT balance, planActivated FROM users WHERE LOWER(username) = LOWER(?)`,
            [username]
        );
        if (!user) throw apiError(404, 'User not found.');
        if (!isTrueFlag(user.planActivated)) {
            throw apiError(403, 'Premium Feature Locked. Please activate a plan.');
        }
        const balance = toFiniteNumber(user.balance) || 0;
        if (balance < numericCost) throw apiError(400, 'Insufficient balance.');

        const updateResult = await dbRunAsync(
            `UPDATE users
             SET balance = COALESCE(balance, 0) - ?,
                 wallet_balance = COALESCE(wallet_balance, 0) - ?
             WHERE LOWER(username) = LOWER(?) AND COALESCE(balance, 0) >= ?`,
            [numericCost, numericCost, username, numericCost]
        );
        if (!updateResult.changes) throw apiError(409, 'Your balance changed before the purchase completed. Please try again.');

        await dbRunAsync(insertSql, insertParams);
        return { newBalance: balance - numericCost, cost: numericCost };
    }, label);
}

app.post('/api/ads/create', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        const url = typeof body.url === 'string' ? body.url.trim().slice(0, 2000) : '';
        const image = typeof body.image === 'string' ? body.image : null;
        if (!title || !url) return res.status(400).json({ error: 'Ad title and URL are required.' });
        const result = await runPremiumPurchase(
            req.user.username,
            body.price,
            `INSERT INTO ads (username, title, url, image, price) VALUES (?, ?, ?, ?, ?)`,
            [req.user.username, title, url, image, toFiniteNumber(body.price)],
            'create_ad'
        );
        return res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
        return sendApiError(res, error, 'Unable to create ad.');
    }
});

app.post('/api/bills/airtime', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const network = typeof body.network === 'string' ? body.network.trim().slice(0, 50) : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : '';
        const amount = toFiniteNumber(body.amount);
        if (!network || !phone || amount === null) return res.status(400).json({ error: 'Network, phone and valid amount are required.' });
        const result = await runPremiumPurchase(
            req.user.username,
            amount,
            `INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'airtime', ?, ?, ?)`,
            [req.user.username, network, phone, amount],
            'buy_airtime'
        );
        return res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
        return sendApiError(res, error, 'Unable to purchase airtime.');
    }
});

app.post('/api/bills/data', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const network = typeof body.network === 'string' ? body.network.trim().slice(0, 50) : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 30) : '';
        const amount = toFiniteNumber(body.amount);
        if (!network || !phone || amount === null) return res.status(400).json({ error: 'Network, phone and valid amount are required.' });
        const result = await runPremiumPurchase(
            req.user.username,
            amount,
            `INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'data', ?, ?, ?)`,
            [req.user.username, network, phone, amount],
            'buy_data'
        );
        return res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
        return sendApiError(res, error, 'Unable to purchase data.');
    }
});

app.post('/api/sms/send', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const senderId = typeof body.senderId === 'string' ? body.senderId.trim().slice(0, 20) : '';
        const count = Number(body.count);
        const cost = toFiniteNumber(body.cost);
        if (!senderId || !Number.isInteger(count) || count <= 0 || cost === null) {
            return res.status(400).json({ error: 'Sender ID, recipient count and valid cost are required.' });
        }
        const result = await runPremiumPurchase(
            req.user.username,
            cost,
            `INSERT INTO bulk_sms (username, sender_id, recipients_count, total_cost) VALUES (?, ?, ?, ?)`,
            [req.user.username, senderId, count, cost],
            'send_sms'
        );
        return res.json({ success: true, newBalance: result.newBalance });
    } catch (error) {
        return sendApiError(res, error, 'Unable to send SMS.');
    }
});

let investmentCycleProcessing = false;

async function processActiveInvestmentCycles() {
    if (investmentCycleProcessing) return;
    investmentCycleProcessing = true;
    try {
        const investments = await dbAllAsync(`
            SELECT i.*, u.id AS linked_user_id
            FROM user_investments i
            JOIN users u ON u.id = i.user_id
            WHERE i.status = 'active'
        `);
        const now = Date.now();

        for (const investment of investments) {
            const activatedAtMs = new Date(investment.activated_at).getTime();
            const cycleDays = Number(investment.cycle_days);
            const dailyEarning = toFiniteNumber(investment.daily_earning);
            if (!Number.isFinite(activatedAtMs) || !Number.isInteger(cycleDays) || cycleDays <= 0 || dailyEarning === null || dailyEarning < 0) {
                console.error(`Skipping invalid investment cycle #${investment.id}.`);
                continue;
            }

            const elapsedDays = Math.floor((now - activatedAtMs) / (24 * 60 * 60 * 1000));
            const targetCreditedDays = Math.min(cycleDays, Math.max(0, elapsedDays));
            if (targetCreditedDays <= Number(investment.days_credited || 0)) continue;

            try {
                await withSqliteTransaction(async () => {
                    const current = await dbGetAsync(
                        `SELECT * FROM user_investments WHERE id = ? AND status = 'active'`,
                        [investment.id]
                    );
                    if (!current) return;

                    const creditedDays = Number(current.days_credited || 0);
                    const targetDays = Math.min(cycleDays, Math.max(creditedDays, targetCreditedDays));
                    const dueDays = targetDays - creditedDays;
                    if (dueDays <= 0) return;

                    const payoutAmount = dueDays * dailyEarning;
                    const payoutResult = await dbRunAsync(
                        `UPDATE users
                         SET daily_earnings = COALESCE(daily_earnings, 0) + ?
                         WHERE id = ?`,
                        [payoutAmount, current.user_id]
                    );
                    if (!payoutResult.changes) throw new Error(`User ${current.user_id} no longer exists.`);

                    if (targetDays >= cycleDays) {
                        const capital = toFiniteNumber(current.capital);
                        if (capital === null || capital < 0) throw new Error(`Investment #${current.id} has invalid capital.`);
                        const completionResult = await dbRunAsync(
                            `UPDATE users
                             SET balance = COALESCE(balance, 0) + ?,
                                 wallet_balance = COALESCE(wallet_balance, 0) + ?,
                                 planActivated = 'false',
                                 activePackage = 'None',
                                 activePackageId = NULL
                             WHERE id = ?`,
                            [capital, capital, current.user_id]
                        );
                        if (!completionResult.changes) {
                            throw new Error(`Could not complete investment #${current.id} for user ${current.user_id}.`);
                        }
                        const completeResult = await dbRunAsync(
                            `UPDATE user_investments
                             SET days_credited = ?, status = 'completed', completed_at = datetime('now')
                             WHERE id = ? AND status = 'active'`,
                            [targetDays, current.id]
                        );
                        if (!completeResult.changes) throw new Error(`Could not close investment #${current.id}.`);
                    } else {
                        await dbRunAsync(
                            `UPDATE user_investments SET days_credited = ? WHERE id = ? AND status = 'active'`,
                            [targetDays, current.id]
                        );
                    }
                }, `investment_cycle_${investment.id}`);
            } catch (error) {
                console.error(`Investment cycle #${investment.id} failed:`, error.message);
            }
        }
    } catch (error) {
        console.error('Investment cron read error:', error.message);
    } finally {
        investmentCycleProcessing = false;
    }
}

// ==========================================
// GLOBAL ERROR HANDLER & SHUTDOWN
// ==========================================
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (res.headersSent) return next(err);

    console.error(`UNHANDLED ERROR:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Internal server error" });
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED PROMISE REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error && error.stack ? error.stack : error);
});

// Graceful shutdown. Railway sends SIGTERM before stopping a container; close
// the database first so SQLite (WAL) files stay consistent. A hard-exit timer
// guarantees the process never hangs past the platform's grace period — a
// hung shutdown is what makes deploy logs end in a bare SIGTERM with no
// explanation.
function shutdown(signal) {
    console.log(`${signal} received. Closing the database and shutting down...`);
    const forceExitTimer = setTimeout(() => {
        console.error('Graceful shutdown timed out after 8s. Exiting forcefully.');
        process.exit(1);
    }, 8000);
    forceExitTimer.unref();
    try {
        db.close((err) => {
            clearTimeout(forceExitTimer);
            if (err) console.error('Error closing DB:', err.message);
            process.exit(0);
        });
    } catch (err) {
        console.error('Error during shutdown:', err.message);
        process.exit(1);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT || 3000;


let resolveDbReady;
let rejectDbReady;
const dbReady = new Promise((resolve, reject) => {
    resolveDbReady = resolve;
    rejectDbReady = reject;
});

db.get('SELECT 1 AS ready', [], (err) => {
    if (err) {
        console.error('Database readiness check failed:', err.message);
        rejectDbReady(err);
        return;
    }
    resolveDbReady();
});

function attachServerTimeouts(httpServer) {
    httpServer.keepAliveTimeout = 65000;
    httpServer.headersTimeout = 70000;
    httpServer.requestTimeout = 120000;
    return httpServer;
}

function startServer(port = PORT, host = '0.0.0.0') {
    const httpServer = app.listen(port, host, () => {
        const address = httpServer.address();
        const listeningPort = address && typeof address === 'object' ? address.port : port;
        console.log(`Access Wealth API listening on port ${listeningPort}`);
        console.log(`Startup summary -> NODE_ENV: ${process.env.NODE_ENV || 'development'} | Database: ${dbPath}`);
        console.log(`Startup summary -> JWT_SECRET: ${jwtSecret ? 'configured' : 'NOT CONFIGURED (login/register return 503 until it is set)'}`);
        if (configuredFrontendOrigins.length) {
            console.log(`CORS configured for ${configuredFrontendOrigins.join(', ')}`);
        } else {
            console.log('CORS using the default Access Wealth frontend origins. Set FRONTEND_URL for a deployed frontend origin.');
        }
        if (process.env.NODE_ENV !== 'test') {
            processActiveInvestmentCycles();
            setInterval(processActiveInvestmentCycles, 60 * 60 * 1000);
        }
    });
    return attachServerTimeouts(httpServer);
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    db,
    dbReady,
    startServer,
    signAccessToken,
    JWT_ISSUER,
    JWT_AUDIENCE,
    jwtSecret,
    dbRunAsync,
    dbGetAsync,
    resolveActiveEntitlement,
    serializeUserWithEntitlement
};
