require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Receipt uploads are an optional enhancement. Keep the API available when a
// deployment omits the optional multer package: a missing upload dependency
// must not prevent the process from starting (which would make every endpoint,
// including /api/login, look like a network error to the frontend).
let multer = null;
try {
    // eslint-disable-next-line global-require
    multer = require('multer');
} catch (error) {
    console.warn('WARN: multer is unavailable. Multipart receipt uploads are disabled; JSON receipt uploads remain available.', error.message);
}

const app = express();
const jwtSecret = process.env.JWT_SECRET;

// How long an access token lives. Raised from 7 days to 30 days so users who
// don't open the app every week (e.g. returning to claim daily earnings) are not
// locked out by an "Invalid or expired token" error. The frontend can also use
// POST /api/refresh-token to silently get a fresh token before/after expiry.
const ACCESS_TOKEN_TTL = '30d';
const JWT_ISSUER = 'AccessWealthHQ';
const JWT_AUDIENCE = 'AccessWealthUsers';

function signAccessToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role || 'user' },
        jwtSecret,
        { expiresIn: ACCESS_TOKEN_TTL, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
    );
}

// Builds the full, normalized user object returned by login/register/refresh and
// sync endpoints. Earlier versions returned a partial object on login (missing
// full_name, phone, bank details and the earnings wallets), which made the
// frontend treat fully-activated users as having an "incomplete account".
function serializeUser(user) {
    if (!user) return null;
    const walletBalance = Number(user.wallet_balance ?? user.balance ?? 0);
    const profileComplete = Boolean(
        (user.full_name && String(user.full_name).trim()) &&
        (user.phone && String(user.phone).trim())
    );
    // Bank details are considered complete when all three fields are present.
    const bankComplete = Boolean(
        user.bank_name && user.bank_account_number && user.bank_account_holder
    );
    return {
        id: user.id,
        username: user.username,
        role: user.role || 'user',
        status: user.status || 'active',
        planActivated: user.planActivated ?? 'false',
        activePackage: user.activePackage || 'None',
        activePackageId: user.activePackageId || null,
        my_referral_id: user.my_referral_id || null,
        referred_by: user.referred_by || null,
        full_name: user.full_name || '',
        phone: user.phone || '',
        bank_name: user.bank_name || '',
        bank_account_number: user.bank_account_number || '',
        bank_account_holder: user.bank_account_holder || '',
        balance: Number(user.balance ?? 0),
        wallet_balance: walletBalance,
        taskEarnings: Number(user.taskEarnings ?? 0),
        daily_earnings: Number(user.daily_earnings ?? 0),
        affiliate_balance: Number(user.affiliate_balance ?? 0),
        // Convenience flags the dashboard uses to decide what to prompt for.
        profile_complete: profileComplete,
        bank_complete: bankComplete,
        account_complete: profileComplete && bankComplete
    };
}

if (!jwtSecret) {
    throw new Error('JWT_SECRET must be configured before the server can start.');
}

if (!process.env.SQUAD_SECRET_KEY) {
    console.warn('WARN: SQUAD_SECRET_KEY is missing. Squad deposit and webhook endpoints will be unavailable.');
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = (process.env.FRONTEND_URL || 'https://accesswealthhq.com,http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5173,http://localhost:5173').split(',');
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
            callback(null, true);
        } else {
            console.warn(`Blocked CORS request from ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-squad-encrypted-body', 'x-squad-signature'],
    credentials: true
}));

app.use(express.json({
    limit: '12mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// ==========================================
// MANUAL PAYMENT CONFIGURATION
// Squad live API is not available yet, so deposits are handled manually.
// Users transfer to this account and upload a payment receipt for admin approval.
// ==========================================
const MANUAL_PAYMENT_INFO = {
    bank_name: process.env.MANUAL_BANK_NAME || 'Moniepoint',
    account_name: process.env.MANUAL_ACCOUNT_NAME || 'Luna Entry Services - Access Wealth HQ',
    account_number: process.env.MANUAL_ACCOUNT_NUMBER || '6977298247',
    bank_code: process.env.MANUAL_BANK_CODE || '',
    currency: process.env.MANUAL_CURRENCY || 'NGN',
    instructions: process.env.MANUAL_PAYMENT_INSTRUCTIONS ||
        'Transfer the deposit amount to the account below, then upload your payment receipt to complete the request. Your deposit will be credited to your wallet once an admin approves it.',
    enabled: (process.env.MANUAL_PAYMENT_ENABLED || 'true') !== 'false'
};

function getManualPaymentInfo() {
    return MANUAL_PAYMENT_INFO;
}

function parseDataUrl(dataUrl) {
    const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || '').trim());
    if (!match) return null;
    return {
        mime: match[1],
        buffer: Buffer.from(match[2], 'base64')
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

app.use(express.static(__dirname));

function isValidAmount(val) {
    const num = parseFloat(val);
    return typeof num === 'number' && !isNaN(num) && isFinite(num) && num > 0;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getSquadApiUrl() {
    return process.env.SQUAD_API_URL || process.env.SQUAD_BASE_URL || 'https://sandbox-api-d.squadco.com';
}

function ensureSquadConfigured(res) {
    const secret = (process.env.SQUAD_SECRET_KEY || '').trim();
    const isSandbox = getSquadApiUrl().includes('sandbox-api');
    if (!secret) {
        res.status(503).json({ error: 'Squad gateway is not configured on the server.' });
        return false;
    }
    if (isSandbox && !secret.startsWith('sandbox_sk_')) {
        res.status(503).json({ error: 'Squad sandbox configuration is invalid. Set Railway SQUAD_SECRET_KEY to the sandbox key from the Squad dashboard (it starts with sandbox_sk_).' });
        return false;
    }
    if (!isSandbox && secret.startsWith('sandbox_sk_')) {
        res.status(503).json({ error: 'Squad live configuration is invalid. Use the live secret key with the production Squad API URL.' });
        return false;
    }
    if (isSandbox || secret.startsWith('sk_')) return true;
    res.status(503).json({ error: 'Squad secret key format is invalid.' });
    return false;
}

function isSquadWebhookSignatureValid(req) {
    const signature = (req.headers['x-squad-encrypted-body'] || req.headers['x-squad-signature'] || '').toString();
    const secret = process.env.SQUAD_SECRET_KEY;

    if (!signature || !secret) return false;

    const digest = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
    if (signature.length !== digest.length) return false;

    try {
        return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(digest, 'utf8'));
    } catch (_) {
        return false;
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
                // eslint-disable-next-line no-await-in-loop
                const exists = await tableHasColumn('deposits', col.name);
                if (!exists) {
                    // eslint-disable-next-line no-await-in-loop
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

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: "Too many attempts from this IP, please try again after 15 minutes." }
});

const actionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please slow down." }
});

const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 300,
    message: "Too many requests"
});

// ==========================================
// DATABASE INITIALIZATION WITH MIGRATION
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : './database.sqlite';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        db.configure('busyTimeout', 2000);
        db.run("PRAGMA journal_mode=WAL;", (pragmaErr) => {
            if (pragmaErr) console.error("Failed to enable WAL mode:", pragmaErr.message);
        });
    }
});

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

    const columnsToAdd = [
        { name: 'balance', type: 'REAL DEFAULT 0' },
        { name: 'wallet_balance', type: 'REAL DEFAULT 0' },
        { name: 'taskEarnings', type: 'REAL DEFAULT 0' },
        { name: 'daily_earnings', type: 'REAL DEFAULT 0' },
        { name: 'affiliate_balance', type: 'REAL DEFAULT 0' },
        { name: 'my_referral_id', type: 'TEXT UNIQUE' },
        { name: 'referred_by', type: 'TEXT' },
        { name: 'planActivated', type: 'TEXT DEFAULT \'false\'' },
        { name: 'activePackage', type: 'TEXT DEFAULT \'None\'' },
        { name: 'activePackageId', type: 'TEXT' },
        { name: 'role', type: 'TEXT DEFAULT \'user\'' },
        { name: 'full_name', type: 'TEXT' },
        { name: 'phone', type: 'TEXT' },
        { name: 'bank_name', type: 'TEXT' },
        { name: 'bank_account_number', type: 'TEXT' },
        { name: 'bank_account_holder', type: 'TEXT' },
        { name: 'bank_code', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
        { name: 'status', type: 'TEXT DEFAULT \'active\'' }
    ];

    columnsToAdd.forEach((col) => addColumnIfMissing('users', col.name, col.type));

    // Ensure main balances are synchronized for existing users
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
    db.run(`CREATE TABLE IF NOT EXISTS squad_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        user_id INTEGER,
        email TEXT,
        amount REAL,
        reference TEXT UNIQUE,
        payment_link TEXT,
        status TEXT DEFAULT 'pending',
        provider_reference TEXT,
        payload TEXT,
        processed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const squadTransactionColumns = [
        { name: 'user_id', type: 'INTEGER' },
        { name: 'payment_link', type: 'TEXT' },
        { name: 'provider_reference', type: 'TEXT' },
        { name: 'payload', type: 'TEXT' },
        { name: 'processed_at', type: 'DATETIME' }
    ];
    squadTransactionColumns.forEach((col) => addColumnIfMissing('squad_transactions', col.name, col.type));

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
    db.run(`ALTER TABLE withdrawals ADD COLUMN bank_details TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });
    db.run(`ALTER TABLE withdrawals ADD COLUMN admin_note TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });
    db.run(`ALTER TABLE withdrawals ADD COLUMN reviewed_by TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });
    db.run(`ALTER TABLE withdrawals ADD COLUMN reviewed_at DATETIME`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });

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
        { name: 'referral_bonus', type: 'REAL DEFAULT 0' },
        { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ];

    investmentPackageColumns.forEach((col) => addColumnIfMissing('investment_packages', col.name, col.type));

    const userInvestmentColumns = [
        { name: 'package_id', type: 'TEXT' },
        { name: 'package_name', type: 'TEXT' },
        { name: 'capital', type: 'REAL' },
        { name: 'daily_rate', type: 'REAL' },
        { name: 'cycle_days', type: 'INTEGER' },
        { name: 'daily_earning', type: 'REAL' },
        { name: 'total_payout', type: 'REAL' },
        { name: 'referral_bonus', type: 'REAL DEFAULT 0' },
        { name: 'days_credited', type: 'INTEGER DEFAULT 0' },
        { name: 'status', type: "TEXT DEFAULT 'active'" },
        { name: 'activated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
        { name: 'completed_at', type: 'DATETIME' }
    ];

    userInvestmentColumns.forEach((col) => addColumnIfMissing('user_investments', col.name, col.type));

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

    // Admin and support accounts
    setTimeout(() => {
        db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`, (err, row) => {
            if (err) console.error("Admin check error:", err.message);
            if (!row) {
                const adminBootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
                if (!adminBootstrapPassword) {
                    console.warn('ADMIN_BOOTSTRAP_PASSWORD is not set. Skipping admin auto-bootstrap user creation.');
                    return;
                }
                const adminHash = bcryptjs.hashSync(adminBootstrapPassword, 10);
                db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage, activePackageId)
                    VALUES (?, ?, 'admin', 'ADMIN123', 'true', 'Elite Apex', 'elite_apex')`,
                        ['admin@accesswealth.com', adminHash], function(insertErr) {
                    if (insertErr) console.error("Failed to create admin:", insertErr.message);
                });
            }
        });

        db.get(`SELECT id FROM users WHERE role = 'support' LIMIT 1`, (err, row) => {
            if (err) console.error("Support check error:", err.message);
            if (!row) {
                const supportBootstrapPassword = process.env.SUPPORT_BOOTSTRAP_PASSWORD;
                if (!supportBootstrapPassword) {
                    console.warn('SUPPORT_BOOTSTRAP_PASSWORD is not set. Skipping support auto-bootstrap user creation.');
                    return;
                }
                const supportHash = bcryptjs.hashSync(supportBootstrapPassword, 10);
                db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage, activePackageId)
                    VALUES (?, ?, 'support', 'SUPPORT123', 'true', 'Elite Apex', 'elite_apex')`,
                        ['support@accesswealth.com', supportHash], function(insertErr) {
                    if (insertErr) console.error("Failed to create support:", insertErr.message);
                });
            }
        });
    }, 500);
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
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
                if (legacyErr) {
                    return res.status(403).json({
                        error: "Invalid or expired token. Please log in again.",
                        code: "TOKEN_INVALID"
                    });
                }
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
        if (statusRow && statusRow.status === 'banned') {
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
app.get('/api/user/:username', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.username.toLowerCase() !== req.params.username.toLowerCase()) {
        return res.status(403).json({ error: "Unauthorized access to another user's profile" });
    }
    const query = `SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, activePackageId, role, full_name, phone, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [req.params.username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user: serializeUser(user) });
    });
});

app.post('/api/user/sync', authenticateToken, (req, res) => {
    const username = req.user.username;
    const query = `SELECT * FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user: serializeUser(user) });
    });
});

app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password, referred_by } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        if (!/^[a-zA-Z0-9_.@-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Invalid username/email format' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        db.get(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, existing) => {
            if (err) {
                console.error("DB error on username check:", err.message);
                return res.status(500).json({ error: "Database error, please try again" });
            }
            if (existing) return res.status(400).json({ error: "Username already taken. Please choose another." });

            const my_referral_id = "AW" + crypto.randomBytes(4).toString('hex').toUpperCase();
            const hashedPassword = await bcryptjs.hash(password, 10);
            const referredByRaw = (referred_by || '').toString().trim();

            const insertUser = (normalizedReferredBy) => {
                db.run(`INSERT INTO users (username, password, my_referral_id, referred_by, role) VALUES (?, ?, ?, ?, 'user')`,
                    [username, hashedPassword, my_referral_id, normalizedReferredBy || null], function (err) {
                        if (err) {
                            console.error("Registration insert error:", err.message);
                            if (err.message.includes("UNIQUE constraint failed: users.username")) {
                                return res.status(400).json({ error: "Username already taken (duplicate)." });
                            }
                            if (err.message.includes("UNIQUE constraint failed: users.my_referral_id")) {
                                return res.status(500).json({ error: "System error: please try again." });
                            }
                            return res.status(500).json({ error: "Database error: " + err.message });
                        }
                        const token = signAccessToken({ id: this.lastID, username, role: 'user' });
                        // Return the full normalized user so the frontend never
                        // treats a brand-new account as "incomplete" because of
                        // missing fields.
                        db.get(`SELECT * FROM users WHERE id = ?`, [this.lastID], (fetchErr, newUser) => {
                            res.json({
                                success: true,
                                message: "Registration successful!",
                                token,
                                user: serializeUser(newUser || {
                                    id: this.lastID,
                                    username,
                                    role: 'user',
                                    my_referral_id
                                })
                            });
                        });
                    });
            };

            if (!referredByRaw) {
                return insertUser(null);
            }

            db.get(
                `SELECT my_referral_id, username
                 FROM users
                 WHERE LOWER(my_referral_id) = LOWER(?) OR LOWER(username) = LOWER(?)
                 LIMIT 1`,
                [referredByRaw, referredByRaw],
                (refErr, refUser) => {
                    if (refErr) {
                        return res.status(500).json({ error: "Database error, please try again" });
                    }

                    if (!refUser) {
                        return res.status(400).json({ error: "Invalid referral code." });
                    }

                    insertUser(refUser.my_referral_id || referredByRaw);
                }
            );
        });
    } catch (error) {
        console.error('Registration catch error:', error);
        res.status(500).json({ error: 'Registration failed due to server error.' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "Invalid username or password" });
            const passwordMatch = await bcryptjs.compare(password, user.password);
            if (!passwordMatch) return res.status(400).json({ error: "Invalid username or password" });
            const token = signAccessToken(user);
            res.json({
                success: true,
                token,
                user: serializeUser(user)
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

async function createSquadDepositLink(req, res) {
    try {
        if (!ensureSquadConfigured(res)) return;

        const { amount, email, user_id } = req.body;
        if (!isValidAmount(amount) || !isValidEmail(email) || !user_id) return res.status(400).json({ error: "Amount, email, and user_id are required" });
        if (Number(user_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'Invalid user_id for authenticated account.' });
        }

        const normalizedAmount = parseFloat(amount);
        const amountInKobo = Math.round(normalizedAmount * 100);
        const reference = `AW-DEPOSIT-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const squadPaymentLinkUrl = `${getSquadApiUrl().replace(/\/$/, '')}/transaction/initiate`;
        const callbackUrl = process.env.SQUAD_CALLBACK_URL || 'https://accesswealthhq.com/dashboard';

        const payload = {
            email,
            amount: amountInKobo,
            currency: 'NGN',
            initiate_type: 'inline',
            transaction_ref: reference,
            callback_url: callbackUrl,
            metadata: {
                username: req.user.username,
                user_id: req.user.id,
                source: 'accesswealth_deposit'
            }
        };

        let squadResponse;
        try {
            squadResponse = await axios.post(squadPaymentLinkUrl, payload, {
                headers: {
                    Authorization: `Bearer ${process.env.SQUAD_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
        } catch (apiError) {
            const reason = apiError.response?.data?.message || apiError.message;
            return res.status(502).json({ error: `Failed to initialize Squad payment link: ${reason}` });
        }

        const responseData = squadResponse.data || {};
        const dataNode = responseData.data || responseData;
        const checkoutUrl = dataNode.checkout_url || dataNode.payment_link || dataNode.url || null;
        const providerReference = dataNode.transaction_ref || dataNode.reference || reference;

        if (!checkoutUrl) {
            return res.status(500).json({ error: 'Squad did not return a payment link.' });
        }

        db.run(
            `INSERT INTO squad_transactions (username, user_id, email, amount, reference, payment_link, provider_reference, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [req.user.username, req.user.id, email, normalizedAmount, reference, checkoutUrl, providerReference],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to create Squad transaction record.' });
                res.json({ success: true, checkout_url: checkoutUrl, payment_link: checkoutUrl, reference });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error during Squad payment link initialization.' });
    }
}

// POST /api/refresh-token — exchange a still-valid (or recently expired) token
// for a fresh 30-day token and the full normalized user. The frontend should
// call this when it receives a 401/403 with code TOKEN_INVALID, OR proactively
// on app load, so returning users can claim daily earnings without being forced
// to log in again. We intentionally accept tokens up to 7 days past expiry to
// smooth over long gaps; anything older requires a fresh login.
app.post('/api/refresh-token', actionLimiter, (req, res) => {
    const authHeader = req.headers['authorization'];
    const incomingToken = authHeader && authHeader.split(' ')[1];
    if (!incomingToken) {
        return res.status(401).json({ error: "Access token required", code: "TOKEN_MISSING" });
    }

    const finishWithUser = (payload) => {
        db.get(`SELECT * FROM users WHERE id = ?`, [payload.id], (err, user) => {
            if (err || !user) {
                return res.status(401).json({ error: "Account no longer exists.", code: "TOKEN_INVALID" });
            }
            if (user.status === 'banned') {
                return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
            }
            const freshToken = signAccessToken(user);
            res.json({ success: true, token: freshToken, user: serializeUser(user) });
        });
    };

    // Try strict verification first.
    jwt.verify(incomingToken, jwtSecret, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE }, (err, payload) => {
        if (!err) return finishWithUser(payload);

        // Allow grace period for an expired-but-otherwise-valid token.
        jwt.verify(incomingToken, jwtSecret, { ignoreExpiration: true }, (legacyErr, legacyPayload) => {
            if (legacyErr) {
                return res.status(403).json({ error: "Session expired. Please log in again.", code: "TOKEN_INVALID" });
            }
            if (legacyPayload.exp && (Date.now() / 1000 - legacyPayload.exp) > 7 * 24 * 60 * 60) {
                return res.status(403).json({ error: "Session expired. Please log in again.", code: "TOKEN_INVALID" });
            }
            finishWithUser(legacyPayload);
        });
    });
});

// ==========================================
// 2. SQUAD AUTOMATED DEPOSITS
// ==========================================
app.post('/api/deposit', authenticateToken, actionLimiter, createSquadDepositLink);
app.post('/api/squad/payment-link', authenticateToken, actionLimiter, createSquadDepositLink);

app.get('/api/squad/transaction/:reference', authenticateToken, async (req, res) => {
    const reference = (req.params.reference || '').trim();
    if (!reference) return res.status(400).json({ error: 'Transaction reference is required.' });

    try {
        const transaction = await dbGetAsync(
            `SELECT reference, amount, status, provider_reference, processed_at, created_at
             FROM squad_transactions
             WHERE reference = ? AND (LOWER(username) = LOWER(?) OR ? = 'admin')`,
            [reference, req.user.username, req.user.role]
        );

        if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });

        const status = (transaction.status || 'pending').toLowerCase();
        return res.json({
            success: status === 'success',
            status,
            message: status === 'success'
                ? 'Deposit credited successfully.'
                : 'Your payment is still awaiting confirmation.',
            transaction
        });
    } catch (error) {
        console.error('Squad transaction lookup error:', error.message);
        return res.status(500).json({ error: 'Unable to retrieve transaction status.' });
    }
});

app.post('/api/squad/webhook', webhookLimiter, async (req, res) => {
    try {
        if (!process.env.SQUAD_SECRET_KEY) {
            return res.status(503).send('Squad gateway is not configured.');
        }

        if (!isSquadWebhookSignatureValid(req)) {
            console.warn(`Invalid Squad webhook signature from ${req.ip}`);
            return res.status(401).send('Unauthorized');
        }

        const event = req.body || {};
        const eventName = (event.event || event.Event || event.type || '').toString().toLowerCase();
        const data = event.data || event;

        if (!['charge_successful', 'transaction.successful', 'charge.successful'].includes(eventName)) {
            return res.sendStatus(200);
        }

        const reference = (data.transaction_ref || data.reference || '').toString().trim();
        if (!reference) {
            return res.status(400).json({ error: 'Missing transaction reference in webhook payload.' });
        }

        const transaction = await dbGetAsync(`SELECT * FROM squad_transactions WHERE reference = ?`, [reference]);
        if (!transaction) {
            return res.status(404).json({ error: 'Transaction not found.' });
        }

        if ((transaction.status || '').toLowerCase() === 'success') {
            return res.sendStatus(200);
        }

        const paidAmount = Number(data.amount || event.amount || 0) / 100;
        if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
            return res.status(400).json({ error: 'Invalid amount in webhook payload.' });
        }
        if (Math.round(paidAmount * 100) !== Math.round(Number(transaction.amount) * 100)) {
            console.warn(`Squad webhook amount mismatch for ${reference}`);
            return res.status(400).json({ error: 'Webhook amount does not match the initiated transaction.' });
        }

        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        try {
            const updateTx = await dbRunAsync(
                `UPDATE squad_transactions
                 SET status = 'success', provider_reference = COALESCE(?, provider_reference), payload = ?, processed_at = datetime('now')
                 WHERE reference = ? AND status = 'pending'`,
                [(data.transaction_ref || data.reference || null), JSON.stringify(event), reference]
            );

            if (!updateTx.changes) {
                await dbRunAsync('ROLLBACK');
                return res.sendStatus(200);
            }

            const creditResult = await dbRunAsync(
                `UPDATE users SET 
                    balance = COALESCE(balance, 0) + ?,
                    wallet_balance = COALESCE(wallet_balance, 0) + ?
                 WHERE id = ?`,
                [paidAmount, paidAmount, transaction.user_id]
            );
            if (!creditResult.changes) throw new Error('User not found for credited transaction.');

            await dbRunAsync('COMMIT');
        } catch (creditError) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw creditError;
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('Squad webhook processing error:', error.message);
        return res.status(500).json({ error: 'Webhook processing failed.' });
    }
});

// ==========================================
// 3. FIXED INVESTMENT PACKAGES
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

app.post('/api/admin/packages/reseed', authenticateToken, adminOnly, (req, res) => {
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

    let completed = 0;
    let hasFailed = false;

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
                if (hasFailed) return;

                if (err) {
                    hasFailed = true;
                    return res.status(500).json({ error: `Failed to reseed package ${pkg.id}: ${err.message}` });
                }

                completed += 1;
                if (completed === FIXED_PACKAGES.length) {
                    res.json({
                        success: true,
                        message: 'Investment packages reseeded successfully.',
                        total: FIXED_PACKAGES.length
                    });
                }
            }
        );
    });
});

app.post('/api/activate', authenticateToken, actionLimiter, (req, res) => {
    const packageId = (req.body.package_id || req.body.packageId || '').toString().trim().toLowerCase();
    const fallbackName = (req.body.name || '').toString().trim().toLowerCase();
    const selectedPackage = PACKAGE_BY_ID[packageId] || PACKAGE_BY_NAME[fallbackName];

    if (!selectedPackage) {
        return res.status(400).json({ error: 'Invalid package selection.' });
    }

    db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        if (user.planActivated === 'true') {
            return res.status(400).json({ error: 'You already have an active package' });
        }
        if (user.balance < selectedPackage.capital) {
            return res.status(400).json({ error: 'Insufficient deposit balance.' });
        }

        db.get(`SELECT id FROM user_investments WHERE user_id = ? AND status = 'active' LIMIT 1`, [req.user.id], (invErr, activeInvestment) => {
            if (invErr) return res.status(500).json({ error: 'Database error.' });
            if (activeInvestment) {
                return res.status(400).json({ error: 'You already have an active package cycle.' });
            }

            const newBalance = user.balance - selectedPackage.capital;
            const referralBonus = getReferralBonus(selectedPackage);

            db.run(
                `UPDATE users
                 SET balance = ?, wallet_balance = ?, planActivated = 'true', activePackage = ?, activePackageId = ?
                 WHERE id = ? AND planActivated = 'false'`,
                [newBalance, newBalance, selectedPackage.name, selectedPackage.id, req.user.id],
                function (updateErr) {
                    if (updateErr) return res.status(500).json({ error: 'Database error.' });
                    if (this.changes === 0) {
                        return res.status(400).json({ error: 'Plan already activated or balance insufficient.' });
                    }

                    db.run(
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
                        ],
                        function (insertErr) {
                            if (insertErr) {
                                // Roll back user activation if investment row fails.
                                db.run(
                                    `UPDATE users SET balance = ?, wallet_balance = ?, planActivated = 'false', activePackage = 'None', activePackageId = NULL WHERE id = ?`,
                                    [user.balance, user.balance, req.user.id]
                                );
                                return res.status(500).json({ error: 'Failed to create package cycle.' });
                            }

                            if (user.referred_by) {
                                db.run(
                                    `UPDATE users
                                     SET affiliate_balance = COALESCE(affiliate_balance, 0) + ?
                                     WHERE id != ? AND (
                                        LOWER(my_referral_id) = LOWER(?) OR LOWER(username) = LOWER(?)
                                     )`,
                                    [referralBonus, req.user.id, user.referred_by, user.referred_by]
                                );
                            }

                            res.json({
                                success: true,
                                message: `Package ${selectedPackage.name} activated successfully.`,
                                newBalance,
                                package: serializePackageForApi(selectedPackage)
                            });
                        }
                    );
                }
            );
        });
    });
});

// GET the authenticated user's currently active investment cycle (or null).
// Used by the dashboard/upgrade screen to show the active package and to let
// the frontend calculate the cost of upgrading to a higher package.
app.get('/api/active-investment', authenticateToken, async (req, res) => {
    try {
        const investment = await dbGetAsync(
            `SELECT id, package_id, package_name, capital, daily_rate, cycle_days,
                    daily_earning, total_payout, referral_bonus, days_credited,
                    status, activated_at, completed_at
             FROM user_investments
             WHERE user_id = ? AND status = 'active'
             ORDER BY activated_at DESC
             LIMIT 1`,
            [req.user.id]
        );

        const user = await dbGetAsync(
            `SELECT balance, wallet_balance, planActivated, activePackage, activePackageId
             FROM users WHERE id = ?`,
            [req.user.id]
        );

        res.json({
            success: true,
            hasActive: !!investment,
            investment: investment || null,
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
    const packageId = (req.body.package_id || req.body.packageId || '').toString().trim().toLowerCase();
    const fallbackName = (req.body.name || '').toString().trim().toLowerCase();
    const targetPackage = PACKAGE_BY_ID[packageId] || PACKAGE_BY_NAME[fallbackName];

    if (!targetPackage) {
        return res.status(400).json({ error: 'Invalid package selection.' });
    }

    let transactionOpen = false;
    try {
        const user = await dbGetAsync(
            `SELECT id, username, balance, wallet_balance, referred_by FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const current = await dbGetAsync(
            `SELECT id, package_id, package_name, capital FROM user_investments
             WHERE user_id = ? AND status = 'active'
             ORDER BY activated_at DESC LIMIT 1`,
            [req.user.id]
        );

        if (!current) {
            return res.status(400).json({
                error: 'You do not have an active package to upgrade. Please activate a package first.'
            });
        }

        if (targetPackage.capital <= current.capital) {
            return res.status(400).json({
                error: 'You can only upgrade to a higher package. Please select a package with a larger capital.'
            });
        }

        const upgradeCost = targetPackage.capital - current.capital;
        const currentBalance = Number(user.wallet_balance ?? user.balance ?? 0);
        if (currentBalance < upgradeCost) {
            return res.status(400).json({
                error: `Insufficient balance to upgrade. You need ₦${upgradeCost.toLocaleString()} more.`
            });
        }

        const referralBonus = Math.round(upgradeCost * 0.5);
        const newBalance = currentBalance - upgradeCost;

        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        transactionOpen = true;

        // End the current cycle.
        await dbRunAsync(
            `UPDATE user_investments
             SET status = 'upgraded', completed_at = datetime('now')
             WHERE id = ? AND status = 'active'`,
            [current.id]
        );

        // Deduct only the difference.
        await dbRunAsync(
            `UPDATE users
             SET balance = COALESCE(balance, 0) - ?,
                 wallet_balance = COALESCE(wallet_balance, 0) - ?,
                 activePackage = ?, activePackageId = ?, planActivated = 'true'
             WHERE id = ?`,
            [upgradeCost, upgradeCost, targetPackage.name, targetPackage.id, req.user.id]
        );

        // Start the new (upgraded) cycle fresh.
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
                getReferralBonus(targetPackage)
            ]
        );

        // Award the referrer a bonus on the new money committed (the upgrade
        // difference), consistent with the referral bonus paid on activation.
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

        await dbRunAsync('COMMIT');
        transactionOpen = false;

        console.warn(`[UPGRADE] ${user.username} upgraded from ${current.package_name} to ${targetPackage.name} (cost ₦${upgradeCost})`);

        res.json({
            success: true,
            message: `Successfully upgraded to ${targetPackage.name}. ₦${upgradeCost.toLocaleString()} was deducted from your wallet.`,
            upgrade_cost: upgradeCost,
            newBalance,
            previous_package: { id: current.package_id, name: current.package_name, capital: current.capital },
            package: serializePackageForApi(targetPackage)
        });
    } catch (error) {
        if (transactionOpen) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
        }
        console.error('Upgrade package error:', error.message);
        res.status(500).json({ error: 'Failed to upgrade package. Please try again.' });
    }
});

// ==========================================
// 4. WITHDRAWAL REQUESTS (User initiated)
// ==========================================
app.post('/api/request-withdrawal', authenticateToken, async (req, res) => {
    try {
        const { amount, wallet_type, bank_details } = req.body;
        const username = req.user.username;

        readSiteSetting('withdrawals_open', 'true', (settingErr, withdrawalsOpen) => {
            if (settingErr) return res.status(500).json({ error: 'Failed to load site settings' });
            if (withdrawalsOpen !== 'true') return res.status(403).json({ error: 'Withdrawals are currently disabled.' });
            if (!amount || amount < 3000) {
                return res.status(400).json({ error: 'Minimum withdrawal amount is ₦3,000' });
            }

            let walletField = '';
            if (wallet_type === 'affiliate') walletField = 'affiliate_balance';
            else if (wallet_type === 'task') walletField = 'taskEarnings';
            else walletField = 'balance';

            db.get(`SELECT ${walletField} as balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
                if (err || !user) return res.status(404).json({ error: 'User not found' });
                if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

                let updateSql, params;
                if (walletField === 'balance') {
                    updateSql = `UPDATE users SET balance = balance - ?, wallet_balance = wallet_balance - ? WHERE LOWER(username) = LOWER(?) AND balance >= ?`;
                    params = [amount, amount, username, amount];
                } else {
                    updateSql = `UPDATE users SET ${walletField} = ${walletField} - ? WHERE LOWER(username) = LOWER(?) AND ${walletField} >= ?`;
                    params = [amount, username, amount];
                }

                db.run(updateSql, params, function(updateErr) {
                        if (updateErr || this.changes === 0) return res.status(500).json({ error: 'Failed to process withdrawal' });

                        const bankDetailsStr = JSON.stringify(bank_details || {});
                        db.run(`INSERT INTO withdrawals (username, amount, wallet_type, status, bank_details, created_at)
                                VALUES (?, ?, ?, 'pending', ?, datetime('now'))`,
                            [username, amount, wallet_type, bankDetailsStr], function(err2) {
                                if (err2) return res.status(500).json({ error: 'Failed to create withdrawal request' });
                                res.json({ success: true, message: 'Withdrawal request submitted. Awaiting admin approval.' });
                            });
                    });
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/withdrawals', authenticateToken, adminOnly, (req, res) => {
    const status = req.query.status || 'pending';
    db.all(`SELECT id, username, amount, wallet_type, bank_details, status, admin_note, reviewed_by, created_at, reviewed_at 
            FROM withdrawals WHERE status = ? ORDER BY created_at DESC`, [status], (err, rows) => {
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
    const { id, note } = req.body;
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

app.post('/api/admin/decline-withdrawal', authenticateToken, adminOnly, (req, res) => {
    const { id, note } = req.body;
    if (!id) return res.status(400).json({ error: "Withdrawal ID required" });
    db.get(`SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'`, [id], (err, withdrawal) => {
        if (err || !withdrawal) return res.status(404).json({ error: "Withdrawal not found or already processed" });
        let walletField = '';
        if (withdrawal.wallet_type === 'affiliate') walletField = 'affiliate_balance';
        else if (withdrawal.wallet_type === 'task') walletField = 'taskEarnings';
        else walletField = 'balance';
        const updateSql = walletField === 'balance'
            ? `UPDATE users SET balance = balance + ?, wallet_balance = wallet_balance + ? WHERE LOWER(username) = LOWER(?)`
            : `UPDATE users SET ${walletField} = ${walletField} + ? WHERE LOWER(username) = LOWER(?)`;
        const params = walletField === 'balance'
            ? [withdrawal.amount, withdrawal.amount, withdrawal.username]
            : [withdrawal.amount, withdrawal.username];

        db.run(updateSql, params, function(refundErr) {
            if (refundErr) return res.status(500).json({ error: "Failed to refund user" });
            db.run(`UPDATE withdrawals SET status = 'declined', admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now') 
                    WHERE id = ? AND status = 'pending'`,
                    [note || 'Your withdrawal was declined. Please contact support for assistance.', req.user.username, id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: "Database error" });
                if (this.changes === 0) return res.status(400).json({ error: "Withdrawal already processed" });
                console.warn(`[ADMIN] Withdrawal ${id} declined by ${req.user.username}`);
                res.json({ success: true, message: "Withdrawal declined and refunded!" });
            });
        });
    });
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
    db.get(`SELECT id FROM withdrawals WHERE username = ? AND status = 'pending' LIMIT 1`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, hasPending: !!row });
    });
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
        const amount = req.body ? req.body.amount : undefined;
        const payment_method = req.body ? req.body.payment_method : undefined;
        const transaction_ref = req.body ? req.body.transaction_ref : undefined;
        const sender_name = req.body ? req.body.sender_name : undefined;
        const username = req.user.username;

        if (!amount || !isValidAmount(amount) || amount < 1000) {
            return res.status(400).json({ error: "Minimum deposit amount is ₦1,000" });
        }

        if (!getManualPaymentInfo().enabled) {
            return res.status(403).json({ error: "Manual deposits are currently disabled." });
        }

        const resolved = resolveReceipt(req, res);
        if (!resolved) return; // 400 already sent
        const receiptData = resolved.data;
        const receiptMime = resolved.mime;

        const userRow = await dbGetAsync(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`, [username]);

        // Idempotency guard: if the client retries with the same transaction
        // reference (common after a timeout), don't create a duplicate deposit.
        if (transaction_ref) {
            const existing = await dbGetAsync(
                `SELECT id FROM deposits WHERE username = ? AND transaction_ref = ? AND status = 'pending' LIMIT 1`,
                [username, transaction_ref]
            );
            if (existing) {
                return res.json({
                    success: true,
                    message: "This deposit request was already submitted and is awaiting admin approval."
                });
            }
        }

        await withSqliteBusyRetry(
            () => dbRunAsync(
                `INSERT INTO deposits (username, user_id, amount, sender_name, status, payment_method, transaction_ref, receipt, receipt_mime)
                 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
                [
                    username,
                    userRow ? userRow.id : null,
                    parseFloat(amount),
                    sender_name || username,
                    payment_method || 'bank_transfer',
                    transaction_ref || null,
                    receiptData,
                    receiptMime
                ]
            ),
            'deposit_insert'
        );

        res.json({
            success: true,
            message: "Deposit request submitted. Your receipt has been uploaded and is awaiting admin approval."
        });
    } catch (error) {
        console.error('Deposit request error:', error.message);
        res.status(500).json({ error: "Server error. Please try again." });
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
// NOTE: uses /api/my-deposits (not /api/user/deposits) to avoid being captured
// by the GET /api/user/:username route which is registered earlier.
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
        if (deposit.username.toLowerCase() !== req.user.username.toLowerCase() && req.user.role !== 'admin') {
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
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ error: "Deposit ID required" });
    try {
        const deposit = await dbGetAsync(`SELECT * FROM deposits WHERE id = ?`, [depositId]);
        if (!deposit) return res.status(404).json({ error: "Deposit not found." });

        const updateResult = await dbRunAsync(
            `UPDATE deposits SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
            [req.user.username, deposit.id]
        );
        if (updateResult.changes === 0) {
            return res.status(400).json({ error: "Deposit already processed or not pending." });
        }

        const creditResult = await dbRunAsync(
            `UPDATE users SET 
                balance = COALESCE(balance, 0) + ?,
                wallet_balance = COALESCE(wallet_balance, 0) + ?
             WHERE LOWER(username) = LOWER(?)`,
            [deposit.amount, deposit.amount, deposit.username]
        );
        if (!creditResult.changes) {
            // User not found — revert the status so the deposit stays pending.
            await dbRunAsync(`UPDATE deposits SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`, [deposit.id]);
            return res.status(400).json({ error: "Deposit user no longer exists." });
        }

        try {
            await recordAdminAction(req.user.username, deposit.username, 'deposit_approve', { depositId: deposit.id, amount: deposit.amount });
        } catch (e) { /* non-blocking */ }

        console.warn(`[ADMIN] Deposit ${deposit.id} approved by ${req.user.username}`);
        res.json({ success: true, message: `Deposit of ₦${deposit.amount} approved and credited to ${deposit.username}` });
    } catch (error) {
        console.error('Approve deposit error:', error.message);
        res.status(500).json({ error: "Failed to approve deposit." });
    }
});

// Admin: decline a pending manual deposit.
app.post('/api/admin/decline-deposit', authenticateToken, adminOnly, async (req, res) => {
    const { depositId, note } = req.body;
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
app.post('/api/claim-daily-task', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const username = req.user.username;

        const user = await dbGetAsync(
            `SELECT id, username, taskEarnings, planActivated, activePackage, activePackageId
             FROM users WHERE id = ?`,
            [userId]
        );
        if (!user) return res.status(404).json({ error: "User not found" });
        if (user.planActivated !== 'true') {
            return res.status(403).json({ error: "You must activate a plan first" });
        }

        // Determine the claim amount. Prefer the active investment's snapshotted
        // daily_earning (authoritative), then the amount the client sends. This
        // avoids zero/incorrect claims when old clients send a stale amount.
        let amount = Number(req.body && req.body.amount);
        const activeInvestment = await dbGetAsync(
            `SELECT daily_earning FROM user_investments WHERE user_id = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1`,
            [userId]
        );
        if (activeInvestment && activeInvestment.daily_earning > 0) {
            amount = Number(activeInvestment.daily_earning);
        }
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid claim amount. Please activate a valid package." });
        }

        // Idempotent daily claim keyed by both user id and username.
        const today = new Date().toISOString().split('T')[0];
        const existing = await dbGetAsync(
            `SELECT id, amount FROM daily_claims WHERE (username = ? OR username = ?) AND claim_date = ? LIMIT 1`,
            [username, user.username, today]
        );
        if (existing) {
            return res.status(400).json({
                error: "You have already claimed your daily earnings today. Come back tomorrow!",
                already_claimed: true,
                claimed_amount: Number(existing.amount || 0)
            });
        }

        const newTaskEarnings = (Number(user.taskEarnings) || 0) + amount;
        await dbRunAsync(
            `UPDATE users SET taskEarnings = ? WHERE id = ?`,
            [newTaskEarnings, userId]
        );
        await dbRunAsync(
            `INSERT INTO daily_claims (username, claim_date, amount) VALUES (?, ?, ?)`,
            [username, today, amount]
        );

        const refreshed = await dbGetAsync(
            `SELECT balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance
             FROM users WHERE id = ?`,
            [userId]
        );

        res.json({
            success: true,
            message: `Successfully claimed ₦${amount.toLocaleString()}!`,
            claimed_amount: amount,
            newBalance: newTaskEarnings,
            balances: refreshed ? {
                balance: Number(refreshed.balance ?? 0),
                wallet_balance: Number(refreshed.wallet_balance ?? 0),
                taskEarnings: Number(refreshed.taskEarnings ?? 0),
                daily_earnings: Number(refreshed.daily_earnings ?? 0),
                affiliate_balance: Number(refreshed.affiliate_balance ?? 0)
            } : null
        });
    } catch (error) {
        console.error('Claim daily task error:', error.message);
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================================
// 7. LIVE CHAT / CUSTOMER SUPPORT API
// ==========================================
app.get('/api/chat/history/:username', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'support' && req.user.username.toLowerCase() !== req.params.username.toLowerCase()) {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    db.all(`SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC`, [req.params.username], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to load messages" });
        res.json({ success: true, messages: rows || [] });
    });
});

app.post('/api/chat/send', authenticateToken, actionLimiter, (req, res) => {
    const { user_id, message } = req.body;
    const sender = req.user.username;
    if (!message || message.trim() === '') return res.status(400).json({ error: "Message cannot be empty" });
    const targetUserId = user_id || sender;
    db.run(`INSERT INTO messages (user_id, sender, message) VALUES (?, ?, ?)`, [targetUserId, sender, message.trim()], function (err) {
        if (err) return res.status(500).json({ error: "Failed to save message" });
        res.json({ success: true, message: "Message sent" });
    });
});

app.get('/api/support/users', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT DISTINCT user_id FROM messages`, [], (err, rows) => {
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
        db.get(`SELECT id FROM messages WHERE user_id = ? LIMIT 1`, [username], (err, existing) => {
            if (err) return res.status(500).json({ error: "Database error" });
            if (!existing) {
                db.run(`INSERT INTO messages (user_id, sender, message) VALUES (?, 'support', ?)`,
                    [username, welcomeMessage], function(insertErr) {
                    if (insertErr) return res.status(500).json({ error: "Failed to send welcome" });
                    res.json({ success: true, message: "Welcome message sent" });
                });
            } else {
                res.json({ success: true, message: "Already has messages" });
            }
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
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
        const { username, amount, walletType, action } = req.body;
        const column = getAdminWalletColumn(walletType);
        const numericAmount = Number(amount);
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
        await recordAdminAction(req.user.username, username, `wallet_${action}`, { wallet: column, amount: numericAmount });
        return res.json({ success: true, message: `Wallet updated successfully.` });
        db.run(query, [parseFloat(amount), username], function(err) {
            if (err) return res.status(500).json({ error: "Database error." });
            if (this.changes === 0) return res.status(400).json({ error: "User not found" });
            console.warn(`[ADMIN] ${action === 'subtract' ? 'Subtracted' : 'Added'} ₦${amount} to ${username}'s ${walletType || 'balance'} by ${req.user.username}`);
            res.json({ success: true, message: `Successfully ${action === 'subtract' ? 'subtracted' : 'added'} ₦${amount} to ${username}'s wallet!` });
        });
    } catch (error) {
        console.error("Adjust balance error:", error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

// Manual credit: admin adds funds to any wallet. Supports walletType: 'balance', 'taskEarnings',
// 'daily_earnings', 'affiliate_balance'. Returns the updated balance.
app.post('/api/admin/manual-credit', authenticateToken, adminOnly, async (req, res) => {
    try {
        const { username, amount, walletType } = req.body;
        const numericAmount = Number(amount);

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

        await recordAdminAction(req.user.username, username, 'manual_credit', { wallet: walletColumn, amount: numericAmount });

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
    const username = (req.body.username || '').trim();
    const packageId = (req.body.packageId || '').trim().toLowerCase();
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
    const username = (req.body.username || '').trim();
    const confirmation = (req.body.confirmation || '').trim();
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
        await recordAdminAction(req.user.username, user.username, 'clear_total_balance', { totalCleared });
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
        const updates = req.body || {};
        const entries = Object.entries(updates);
        if (!entries.length) return res.status(400).json({ error: "No settings provided" });
        const done = [];
        entries.forEach(([key, value]) => {
            done.push(new Promise((resolve) => {
                db.run(`INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)], (err) => resolve(err));
            }));
        });
        Promise.all(done).then((results) => {
            const error = results.find(Boolean);
            if (error) return res.status(500).json({ error: "Failed to save settings" });
            res.json({ success: true, message: "Settings updated successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/admin/toggle-user-status', authenticateToken, adminOnly, (req, res) => {
    const { username, status } = req.body;
    if (!username || !status) return res.status(400).json({ error: "Username and status are required" });
    db.run(`UPDATE users SET status = ? WHERE LOWER(username) = LOWER(?)`, [status, username], function(err) {
        if (err) return res.status(500).json({ error: "Database error" });
        if (this.changes === 0) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, message: `User ${username} is now ${status}` });
    });
});

app.get('/api/admin/stats', authenticateToken, adminOnly, (req, res) => {
    const stats = { totalUsers: 0, activePlans: 0, revenue: 0, pendingDeposits: 0, pendingWithdrawals: 0 };
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => { if (row) stats.totalUsers = row.count;
        db.get("SELECT COUNT(*) as count FROM users WHERE planActivated = 'true'", [], (err, row) => { if (row) stats.activePlans = row.count;
            const revenueQuery = `SELECT (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE status = 'approved') + (SELECT COALESCE(SUM(amount), 0) FROM squad_transactions WHERE status = 'success') AS total`;
            db.get(revenueQuery, [], (err, row) => { if (row && row.total) stats.revenue = row.total;
                db.get("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'", [], (err, row) => { if (row) stats.pendingDeposits = row.count;
                    db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'", [], (err, row) => { if (row) stats.pendingWithdrawals = row.count;
                        res.json({ success: true, stats });
                    });
                });
            });
        });
    });
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
    const migrationKey = 'legacy_plan_reset_v1';
    const fixedPackageIds = FIXED_PACKAGES.map((pkg) => pkg.id.toLowerCase());
    const placeholders = fixedPackageIds.map(() => '?').join(', ');
    const operator = req.user.username || 'admin';
    let transactionOpen = false;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        transactionOpen = true;

        const existing = await dbGetAsync(
            `SELECT migration_key, status FROM system_migrations WHERE migration_key = ?`,
            [migrationKey]
        );

        if (existing && existing.status === 'completed') {
            await dbRunAsync('ROLLBACK');
            return res.status(409).json({ error: 'Legacy reset migration has already been completed.' });
        }

        if (existing && existing.status === 'running') {
            await dbRunAsync('ROLLBACK');
            return res.status(409).json({ error: 'Legacy reset migration is already running.' });
        }

        await dbRunAsync(
            `INSERT INTO system_migrations (migration_key, status, started_by, notes, started_at, completed_at, updated_at)
             VALUES (?, 'running', ?, ?, datetime('now'), NULL, datetime('now'))
             ON CONFLICT(migration_key) DO UPDATE SET
                status = 'running',
                started_by = excluded.started_by,
                notes = excluded.notes,
                started_at = datetime('now'),
                completed_at = NULL,
                updated_at = datetime('now')`,
            [migrationKey, operator, 'Started from admin dashboard']
        );

        const legacyPlans = await dbAllAsync(
            `SELECT id, user_id, username, capital, daily_earning, total_payout, status, package_id
             FROM user_investments
             WHERE LOWER(COALESCE(status, '')) IN ('active', 'ongoing')
               AND (
                    package_id IS NULL OR TRIM(package_id) = ''
                    OR LOWER(package_id) NOT IN (${placeholders})
               )`,
            fixedPackageIds
        );

        const impactedUserIds = new Set();
        const impactedUsernames = new Set();
        let refundedPlans = 0;
        let refundedTotal = 0;

        for (const plan of legacyPlans) {
            const capital = Number(plan.capital || 0);
            const refundableCapital = Number.isFinite(capital) && capital > 0 ? capital : 0;

            if (refundableCapital > 0) {
                if (plan.user_id) {
                    await dbRunAsync(
                        `UPDATE users SET 
                            balance = COALESCE(balance, 0) + ?,
                            wallet_balance = COALESCE(wallet_balance, 0) + ?
                         WHERE id = ?`,
                        [refundableCapital, refundableCapital, plan.user_id]
                    );
                    impactedUserIds.add(Number(plan.user_id));
                } else if (plan.username) {
                    await dbRunAsync(
                        `UPDATE users SET 
                            balance = COALESCE(balance, 0) + ?,
                            wallet_balance = COALESCE(wallet_balance, 0) + ?
                         WHERE LOWER(username) = LOWER(?)`,
                        [refundableCapital, refundableCapital, plan.username]
                    );
                    impactedUsernames.add(String(plan.username));
                }

                refundedPlans += 1;
                refundedTotal += refundableCapital;
            }

            await dbRunAsync(
                `UPDATE user_investments
                 SET status = 'cancelled_system_upgrade',
                     days_credited = 0,
                     daily_earning = 0,
                     total_payout = capital,
                     completed_at = datetime('now')
                 WHERE id = ?`,
                [plan.id]
            );
        }

        for (const userId of impactedUserIds) {
            await dbRunAsync(
                `UPDATE users
                 SET planActivated = 'false',
                     activePackage = 'None',
                     activePackageId = NULL,
                     daily_earnings = 0
                 WHERE id = ?`,
                [userId]
            );
        }

        for (const username of impactedUsernames) {
            await dbRunAsync(
                `UPDATE users
                 SET planActivated = 'false',
                     activePackage = 'None',
                     activePackageId = NULL,
                     daily_earnings = 0
                 WHERE LOWER(username) = LOWER(?)`,
                [username]
            );
        }

        const notes = JSON.stringify({
            refunded_plans: refundedPlans,
            refunded_total: refundedTotal,
            impacted_users_by_id: impactedUserIds.size,
            impacted_users_by_username: impactedUsernames.size
        });

        await dbRunAsync(
            `UPDATE system_migrations
             SET status = 'completed', notes = ?, completed_at = datetime('now'), updated_at = datetime('now')
             WHERE migration_key = ?`,
            [notes, migrationKey]
        );

        await dbRunAsync('COMMIT');
        transactionOpen = false;

        res.json({
            success: true,
            message: 'Legacy reset migration completed successfully.',
            summary: {
                plans_cancelled: legacyPlans.length,
                plans_refunded: refundedPlans,
                total_refunded: refundedTotal,
                impacted_users: impactedUserIds.size + impactedUsernames.size
            }
        });
    } catch (error) {
        if (transactionOpen) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
        }

        try {
            await dbRunAsync(
                `INSERT INTO system_migrations (migration_key, status, started_by, notes, started_at, completed_at, updated_at)
                 VALUES (?, 'failed', ?, ?, datetime('now'), NULL, datetime('now'))
                 ON CONFLICT(migration_key) DO UPDATE SET
                    status = 'failed',
                    started_by = excluded.started_by,
                    notes = excluded.notes,
                    updated_at = datetime('now')`,
                [migrationKey, operator, `Failed from admin endpoint: ${error.message}`]
            );
        } catch (_) {}

        res.status(500).json({ error: `Legacy reset migration failed: ${error.message}` });
    }
});

// ==========================================
// 9. REFERRAL SYSTEM ENDPOINTS
// ==========================================
app.get('/api/referral/stats/:username', authenticateToken, (req, res) => {
    const username = req.params.username;
    db.get(`SELECT my_referral_id, affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        const myRefId = user.my_referral_id;
        db.get(`SELECT COUNT(*) as count FROM users WHERE referred_by = ?`, [myRefId], (err2, stats) => {
            if (err2) return res.status(500).json({ error: "Database error" });
            db.all(`SELECT username, created_at, planActivated FROM users WHERE referred_by = ? ORDER BY created_at DESC`, [myRefId], (err3, referrals) => {
                res.json({
                    success: true,
                    totalReferrals: stats.count || 0,
                    earnings: user.affiliate_balance || 0,
                    referrals: referrals || []
                });
            });
        });
    });
});

app.get('/api/referral/leaderboard', (req, res) => {
    // Show only activated referrals count (users who purchased plans)
    db.all(`SELECT username, affiliate_balance as total_earned, (SELECT COUNT(*) FROM users WHERE referred_by = u.my_referral_id AND planActivated = 'true') as referral_count FROM users u WHERE role = 'user' ORDER BY affiliate_balance DESC LIMIT 10`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, leaderboard: rows || [] });
    });
});

// ==========================================
// 10. USER PROFILE & BANK DETAILS
// ==========================================
app.get('/api/user/profile/:username', authenticateToken, (req, res) => {
    if (req.user.username !== req.params.username && req.user.role !== 'admin') {
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
        const { full_name, phone } = req.body;
        const username = req.user.username;
        db.run(`UPDATE users SET full_name = ?, phone = ? WHERE LOWER(username) = LOWER(?)`,
            [full_name || null, phone || null, username], function(err) {
                if (err) return res.status(500).json({ error: "Database error" });
                res.json({ success: true, message: "Profile updated successfully" });
            });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/user/update-bank', authenticateToken, async (req, res) => {
    try {
        const { bank_name, account_number, account_holder } = req.body;
        const username = req.user.username;
        if (!bank_name || !account_number || !account_holder) {
            return res.status(400).json({ error: "All bank fields are required" });
        }
        db.run(`UPDATE users SET bank_name = ?, bank_account_number = ?, bank_account_holder = ? WHERE LOWER(username) = LOWER(?)`,
            [bank_name, account_number, account_holder, username], function(err) {
                if (err) return res.status(500).json({ error: "Database error" });
                res.json({ success: true, message: "Bank details saved successfully" });
            });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/user/change-password', authenticateToken, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        const username = req.user.username;
        if (!current_password || !new_password || new_password.length < 6) {
            return res.status(400).json({ error: "Current password and new password (min 6 chars) required" });
        }
        db.get(`SELECT password FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(404).json({ error: "User not found" });
            const valid = await bcryptjs.compare(current_password, user.password);
            if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
            const hashed = await bcryptjs.hash(new_password, 10);
            db.run(`UPDATE users SET password = ? WHERE LOWER(username) = LOWER(?)`, [hashed, username], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: "Database error" });
                res.json({ success: true, message: "Password changed successfully" });
            });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================================
// 11. ADMIN BROADCAST MESSAGE
// ==========================================
app.post('/api/admin/broadcast', authenticateToken, adminOnly, async (req, res) => {
    try {
        const { message, title } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });
        db.run(`INSERT INTO broadcasts (title, message, created_by, created_at) VALUES (?, ?, ?, datetime('now'))`, 
            [title || 'Admin Announcement', message, req.user.username], function(err) {
            if (err) return res.status(500).json({ error: "Failed to save broadcast" });
            res.json({ success: true, message: "Broadcast sent to all users" });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
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
        const { title, description, reward_amount, required_plan, image_url, link } = req.body;
        if (!title || !description || !reward_amount) {
            return res.status(400).json({ error: "Title, description and reward amount are required" });
        }
        db.run(`INSERT INTO sponsored_posts (title, description, reward_amount, required_plan, image_url, link, created_by) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [title, description, reward_amount, required_plan || 'all', image_url || null, link || null, req.user.username], function(err) {
            if (err) return res.status(500).json({ error: "Failed to create sponsored post" });
            res.json({ success: true, message: "Sponsored post created successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
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
        const { post_id } = req.body;
        const username = req.user.username;
        if (!post_id) return res.status(400).json({ error: 'Post ID required' });
        readSiteSetting('sponsored_posts_open', 'true', (settingErr, sponsoredOpen) => {
            if (settingErr) return res.status(500).json({ error: 'Failed to load site settings' });
            if (sponsoredOpen !== 'true') return res.status(403).json({ error: 'Sponsored posts are currently disabled.' });
            db.get(`SELECT id FROM sponsored_posts WHERE id = ? AND status = 'active'`, [post_id], (err, post) => {
                if (err || !post) return res.status(404).json({ error: 'Post not found' });
                db.get(`SELECT id FROM sponsored_submissions WHERE post_id = ? AND username = ?`, [post_id, username], (subErr, existing) => {
                    if (subErr) return res.status(500).json({ error: 'Database error' });
                    if (existing) return res.status(400).json({ error: 'You have already submitted this task' });
                    db.run(`INSERT INTO sponsored_submissions (post_id, username, status) VALUES (?, ?, 'pending')`,
                        [post_id, username], function(insertErr) {
                            if (insertErr) return res.status(500).json({ error: 'Failed to submit task' });
                            res.json({ success: true, message: 'Task submitted for admin review!' });
                        });
                });
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
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
    try {
        const { submission_id } = req.body;
        if (!submission_id) return res.status(400).json({ error: "Submission ID required" });
        db.get(`SELECT * FROM sponsored_submissions WHERE id = ? AND status = 'pending'`, [submission_id], (err, submission) => {
            if (err || !submission) return res.status(404).json({ error: "Submission not found" });
            db.run(`UPDATE sponsored_submissions SET status = 'approved' WHERE id = ?`, [submission_id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: "Failed to update submission" });
                db.run(`UPDATE users SET taskEarnings = taskEarnings + ? WHERE LOWER(username) = LOWER(?)`,
                    [submission.reward_amount, submission.username], function(creditErr) {
                    if (creditErr) return res.status(500).json({ error: "Failed to credit user" });
                    res.json({ success: true, message: "Submission approved and user credited!" });
                });
            });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
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

// Premium feature helper (ads, bills, sms)
function verifyPremiumAccess(username, cost, res, callback) {
    if (!isValidAmount(cost)) return res.status(400).json({ error: "Invalid amount." });
    db.get(`SELECT balance, planActivated FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.planActivated !== 'true') return res.status(403).json({ error: "Premium Feature Locked. Please activate a plan." });
        if (user.balance < cost) return res.status(400).json({ error: "Insufficient balance." });
        db.run(`UPDATE users SET balance = balance - ?, wallet_balance = wallet_balance - ? WHERE LOWER(username) = LOWER(?) AND balance >= ?`, [cost, cost, username, cost], function (updateErr) {
            if (updateErr) return res.status(500).json({ error: "Database error." });
            if (this.changes === 0) return res.status(400).json({ error: "Insufficient balance or user not found." });
            callback(user.balance - cost);
        });
    });
}

app.post('/api/ads/create', authenticateToken, actionLimiter, (req, res) => {
    verifyPremiumAccess(req.user.username, req.body.price, res, (b) => {
        db.run(`INSERT INTO ads (username, title, url, image, price) VALUES (?, ?, ?, ?, ?)`, [req.user.username, req.body.title, req.body.url, req.body.image, req.body.price], () => {
            res.json({ success: true, newBalance: b });
        });
    });
});

app.post('/api/bills/airtime', authenticateToken, actionLimiter, (req, res) => {
    verifyPremiumAccess(req.user.username, req.body.amount, res, (b) => {
        db.run(`INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'airtime', ?, ?, ?)`, [req.user.username, req.body.network, req.body.phone, req.body.amount], () => {
            res.json({ success: true, newBalance: b });
        });
    });
});

app.post('/api/bills/data', authenticateToken, actionLimiter, (req, res) => {
    verifyPremiumAccess(req.user.username, req.body.amount, res, (b) => {
        db.run(`INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'data', ?, ?, ?)`, [req.user.username, req.body.network, req.body.phone, req.body.amount], () => {
            res.json({ success: true, newBalance: b });
        });
    });
});

app.post('/api/sms/send', authenticateToken, actionLimiter, (req, res) => {
    verifyPremiumAccess(req.user.username, req.body.cost, res, (b) => {
        db.run(`INSERT INTO bulk_sms (username, sender_id, recipients_count, total_cost) VALUES (?, ?, ?, ?)`, [req.user.username, req.body.senderId, req.body.count, req.body.cost], () => {
            res.json({ success: true, newBalance: b });
        });
    });
});

function processActiveInvestmentCycles() {
    db.all(`
        SELECT i.*, u.id as linked_user_id
        FROM user_investments i
        JOIN users u ON u.id = i.user_id
        WHERE i.status = 'active'
    `, [], (err, investments) => {
        if (err) {
            console.error('Investment cron read error:', err.message);
            return;
        }

        if (!investments || investments.length === 0) return;

        const now = Date.now();
        investments.forEach((inv) => {
            const activatedAtMs = new Date(inv.activated_at).getTime();
            if (Number.isNaN(activatedAtMs)) return;

            const elapsedDays = Math.floor((now - activatedAtMs) / (24 * 60 * 60 * 1000));
            const targetCreditedDays = Math.min(inv.cycle_days, Math.max(0, elapsedDays));
            const dueDays = targetCreditedDays - (inv.days_credited || 0);

            if (dueDays > 0) {
                const payoutAmount = dueDays * inv.daily_earning;
                db.run(
                    `UPDATE users SET daily_earnings = COALESCE(daily_earnings, 0) + ? WHERE id = ?`,
                    [payoutAmount, inv.user_id],
                    (creditErr) => {
                        if (creditErr) {
                            console.error(`Investment payout credit failed for ${inv.username}:`, creditErr.message);
                            return;
                        }

                        db.run(
                            `UPDATE user_investments SET days_credited = ? WHERE id = ?`,
                            [targetCreditedDays, inv.id],
                            (updateErr) => {
                                if (updateErr) {
                                    console.error(`Investment days_credited update failed for #${inv.id}:`, updateErr.message);
                                }
                            }
                        );
                    }
                );
            }

            if (targetCreditedDays >= inv.cycle_days) {
                db.run(
                    `UPDATE users
                     SET balance = COALESCE(balance, 0) + ?,
                         wallet_balance = COALESCE(wallet_balance, 0) + ?,
                         planActivated = 'false',
                         activePackage = 'None',
                         activePackageId = NULL
                     WHERE id = ? AND planActivated = 'true'`,
                    [inv.capital, inv.capital, inv.user_id],
                    (userUpdateErr) => {
                        if (userUpdateErr) {
                            console.error(`Investment completion user update failed for ${inv.username}:`, userUpdateErr.message);
                            return;
                        }

                        db.run(
                            `UPDATE user_investments SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'active'`,
                            [inv.id],
                            (completeErr) => {
                                if (completeErr) {
                                    console.error(`Investment completion update failed for #${inv.id}:`, completeErr.message);
                                }
                            }
                        );
                    }
                );
            }
        });
    });
}

// ==========================================
// GLOBAL ERROR HANDLER & SHUTDOWN
// ==========================================
app.use((err, req, res, next) => {
    console.error(`UNHANDLED ERROR:`, err.stack);
    res.status(500).json({ error: "Internal server error" });
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED PROMISE REJECTION:', reason);
});

process.on('SIGTERM', () => {
    db.close((err) => {
        if (err) console.error('Error closing DB:', err.message);
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    processActiveInvestmentCycles();
    setInterval(processActiveInvestmentCycles, 60 * 60 * 1000);
});

// Bounds for slow/unreliable clients (notably mobile uploads). Without these a
// stalled mobile upload could leave a request (and its in-memory body) hanging
// indefinitely. The headers/request timeouts fail fast so the client can show an
// error and retry instead of appearing to freeze or refresh.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 120000; // 2 minutes to allow large/slow receipt uploads
