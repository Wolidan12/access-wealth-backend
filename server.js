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
const paystackService = require('./services/paystackService');

const app = express();
const jwtSecret = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const paystackSecret = process.env.PAYSTACK_SECRET_KEY || 'dev-paystack-secret';

if (!process.env.JWT_SECRET) {
    console.warn('WARN: JWT_SECRET is missing. Using development fallback secret. Set JWT_SECRET in production.');
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
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

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
    if (process.env.SQUAD_SECRET_KEY) return true;
    res.status(503).json({ error: 'Squad gateway is not configured on the server.' });
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

const FIXED_PACKAGES = [
    { id: 'starter_basic', name: 'Starter Basic', tier: 'Starter', capital: 500, daily_rate: 0.01, cycle_days: 10, daily_earning: 5, total_payout: 550 },
    { id: 'starter_bronze', name: 'Starter Bronze', tier: 'Starter', capital: 1500, daily_rate: 0.01, cycle_days: 10, daily_earning: 15, total_payout: 1650 },
    { id: 'starter_silver', name: 'Starter Silver', tier: 'Starter', capital: 3000, daily_rate: 0.01, cycle_days: 10, daily_earning: 30, total_payout: 3300 },
    { id: 'starter_gold', name: 'Starter Gold', tier: 'Starter', capital: 4500, daily_rate: 0.01, cycle_days: 10, daily_earning: 45, total_payout: 4950 },
    { id: 'growth_plus', name: 'Growth Plus', tier: 'Growth', capital: 10000, daily_rate: 0.012, cycle_days: 15, daily_earning: 120, total_payout: 11800 },
    { id: 'growth_pro', name: 'Growth Pro', tier: 'Growth', capital: 25000, daily_rate: 0.012, cycle_days: 15, daily_earning: 300, total_payout: 29500 },
    { id: 'growth_max', name: 'Growth Max', tier: 'Growth', capital: 50000, daily_rate: 0.012, cycle_days: 15, daily_earning: 600, total_payout: 59000 },
    { id: 'wealth_standard', name: 'Wealth Standard', tier: 'Wealth', capital: 100000, daily_rate: 0.014, cycle_days: 21, daily_earning: 1400, total_payout: 129400 },
    { id: 'wealth_premium', name: 'Wealth Premium', tier: 'Wealth', capital: 250000, daily_rate: 0.014, cycle_days: 21, daily_earning: 3500, total_payout: 323500 },
    { id: 'elite_vanguard', name: 'Elite Vanguard', tier: 'Elite', capital: 500000, daily_rate: 0.015, cycle_days: 30, daily_earning: 7500, total_payout: 725000 },
    { id: 'elite_apex', name: 'Elite Apex', tier: 'Elite', capital: 1000000, daily_rate: 0.015, cycle_days: 30, daily_earning: 15000, total_payout: 1450000 }
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
        db.configure('busyTimeout', 10000);
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
        // Paystack recipient information - stored to avoid creating duplicate recipients
        { name: 'paystack_recipient_code', type: 'TEXT' },
        { name: 'paystack_recipient_id', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
        { name: 'status', type: 'TEXT DEFAULT \'active\'' }
    ];

    columnsToAdd.forEach((col) => addColumnIfMissing('users', col.name, col.type));

    // Existing tables
    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        sender_name TEXT, 
        payment_method TEXT,
        transaction_ref TEXT,
        status TEXT DEFAULT 'pending', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
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
    // Add Paystack transfer tracking columns
    db.run(`ALTER TABLE withdrawals ADD COLUMN paystack_transfer_reference TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });
    db.run(`ALTER TABLE withdrawals ADD COLUMN paystack_transfer_date DATETIME`, (err) => {
        if (err && !err.message.includes('duplicate column name')) console.warn(err.message);
    });
    db.run(`ALTER TABLE withdrawals ADD COLUMN paystack_failure_reason TEXT`, (err) => {
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
    if (!token) return res.status(401).json({ error: "Access token required" });
    jwt.verify(token, jwtSecret, {
        issuer: 'AccessWealthHQ',
        audience: 'AccessWealthUsers'
    }, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token" });
        req.user = user;
        db.get(`SELECT status FROM users WHERE id = ?`, [user.id], (statusErr, statusRow) => {
            if (statusErr) return res.status(500).json({ error: "Server error while validating account status" });
            if (statusRow && statusRow.status === 'banned') {
                return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
            }
            next();
        });
    });
};

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
        res.json({ success: true, user });
    });
});

app.post('/api/user/sync', authenticateToken, (req, res) => {
    const username = req.user.username;
    const query = `SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, activePackageId, role, full_name, phone, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
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
                        const token = jwt.sign({ id: this.lastID, username, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'AccessWealthHQ', audience: 'AccessWealthUsers' });
                        res.json({
                            success: true,
                            message: "Registration successful!",
                            token,
                            user: {
                                id: this.lastID,
                                username,
                                role: 'user',
                                planActivated: 'false',
                                my_referral_id: my_referral_id
                            }
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
        db.get(`SELECT id, username, password, role, planActivated, activePackage, activePackageId, my_referral_id, wallet_balance, balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "Invalid username or password" });
            const passwordMatch = await bcryptjs.compare(password, user.password);
            if (!passwordMatch) return res.status(400).json({ error: "Invalid username or password" });
            const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'AccessWealthHQ', audience: 'AccessWealthUsers' });
            res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    planActivated: user.planActivated,
                    activePackage: user.activePackage,
                    activePackageId: user.activePackageId,
                    my_referral_id: user.my_referral_id,
                    wallet_balance: user.wallet_balance ?? user.balance ?? 0,
                    balance: user.balance ?? 0
                }
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

// ==========================================
// 2. SQUAD AUTOMATED DEPOSITS
// ==========================================
app.post('/api/deposit', authenticateToken, actionLimiter, createSquadDepositLink);
app.post('/api/squad/payment-link', authenticateToken, actionLimiter, createSquadDepositLink);

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

        const updateTx = await dbRunAsync(
            `UPDATE squad_transactions
             SET status = 'success', provider_reference = COALESCE(?, provider_reference), payload = ?, processed_at = datetime('now')
             WHERE reference = ? AND status = 'pending'`,
            [
                (data.transaction_ref || data.reference || null),
                JSON.stringify(event),
                reference
            ]
        );

        if (!updateTx.changes) {
            return res.sendStatus(200);
        }

        const creditResult = await dbRunAsync(
            `UPDATE users
             SET wallet_balance = COALESCE(wallet_balance, balance, 0) + ?,
                 balance = COALESCE(balance, 0) + ?
             WHERE LOWER(username) = LOWER(?) OR id = ?`,
            [paidAmount, paidAmount, transaction.username, transaction.user_id || 0]
        );

        if (!creditResult.changes) {
            return res.status(404).json({ error: 'User not found for credited transaction.' });
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
                 SET balance = ?, planActivated = 'true', activePackage = ?, activePackageId = ?
                 WHERE id = ? AND planActivated = 'false'`,
                [newBalance, selectedPackage.name, selectedPackage.id, req.user.id],
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
                                    `UPDATE users SET balance = ?, planActivated = 'false', activePackage = 'None', activePackageId = NULL WHERE id = ?`,
                                    [user.balance, req.user.id]
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

                db.run(`UPDATE users SET ${walletField} = ${walletField} - ? WHERE LOWER(username) = LOWER(?) AND ${walletField} >= ?`,
                    [amount, username, amount], function(updateErr) {
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
    if (!id) return res.status(400).json({ error: "Withdrawal ID required" });
    
    try {
        // Step 1: Fetch withdrawal (must be pending to proceed)
        const withdrawal = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!withdrawal) {
            return res.status(404).json({ error: "Withdrawal not found or already processed" });
        }

        console.log(`[WITHDRAWAL] Processing approval for withdrawal ${id} by ${req.user.username}`);

        // Step 2: Fetch user's bank details
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT bank_name, bank_account_number, bank_account_holder, bank_code, 
                           paystack_recipient_code, paystack_recipient_id 
                    FROM users WHERE LOWER(username) = LOWER(?)`, 
                [withdrawal.username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Validate user has complete bank details
        if (!user.bank_account_number || !user.bank_account_holder || !user.bank_code) {
            return res.status(400).json({ 
                error: "User has incomplete bank details. Cannot process transfer." 
            });
        }

        console.log(`[WITHDRAWAL] User bank details verified for ${withdrawal.username}`);

        // Step 3: Create or reuse Paystack recipient
        let recipient_code = user.paystack_recipient_code;
        
        if (!recipient_code) {
            console.log(`[WITHDRAWAL] Creating new Paystack recipient for ${withdrawal.username}`);
            const recipientResult = await paystackService.createPaystackRecipient(
                user.bank_code,
                user.bank_account_number,
                user.bank_account_holder
            );

            if (!recipientResult.success) {
                console.error(`[WITHDRAWAL] Failed to create recipient:`, recipientResult.error);
                return res.status(400).json({ 
                    error: "Failed to create Paystack recipient: " + recipientResult.error 
                });
            }

            recipient_code = recipientResult.recipient_code;

            // Save recipient code to user for future use
            await new Promise((resolve, reject) => {
                db.run(`UPDATE users SET paystack_recipient_code = ?, paystack_recipient_id = ? 
                        WHERE LOWER(username) = LOWER(?)`,
                    [recipient_code, recipientResult.recipient_id, withdrawal.username],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            console.log(`[WITHDRAWAL] Recipient code saved: ${recipient_code}`);
        } else {
            console.log(`[WITHDRAWAL] Reusing existing Paystack recipient: ${recipient_code}`);
        }

        // Step 4: Initiate Paystack transfer
        console.log(`[WITHDRAWAL] Initiating transfer: ${withdrawal.amount} NGN to ${recipient_code}`);
        const transferResult = await paystackService.initiatePaystackTransfer(
            recipient_code,
            withdrawal.amount,
            `Withdrawal to ${user.bank_account_holder} (Acct: ${user.bank_account_number})`
        );

        if (!transferResult.success) {
            console.error(`[WITHDRAWAL] Transfer initiation failed:`, transferResult.error);
            return res.status(400).json({ 
                error: "Failed to initiate Paystack transfer: " + transferResult.error 
            });
        }

        console.log(`[WITHDRAWAL] Transfer initiated: ${transferResult.reference}`);

        // Step 5: Update withdrawal status to 'processing' with transfer reference (using transaction)
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                
                db.run(`UPDATE withdrawals 
                        SET status = 'processing', 
                            admin_note = ?, 
                            reviewed_by = ?, 
                            reviewed_at = datetime('now'),
                            paystack_transfer_reference = ?,
                            paystack_transfer_date = datetime('now')
                        WHERE id = ? AND status = 'pending'`,
                    [note || 'Processing Paystack transfer', req.user.username, transferResult.reference, id],
                    function(err) {
                        if (err) {
                            db.run('ROLLBACK');
                            reject(err);
                        } else if (this.changes === 0) {
                            db.run('ROLLBACK');
                            reject(new Error('Withdrawal status changed unexpectedly'));
                        } else {
                            db.run('COMMIT', (commitErr) => {
                                if (commitErr) reject(commitErr);
                                else resolve();
                            });
                        }
                    }
                );
            });
        });

        console.warn(`[ADMIN] Withdrawal ${id} approved and processing by ${req.user.username}`);
        
        res.json({ 
            success: true, 
            message: "Withdrawal approved! Transfer initiated to Paystack.",
            transfer_reference: transferResult.reference
        });

    } catch (error) {
        console.error(`[WITHDRAWAL] Error processing approval:`, error);
        res.status(500).json({ error: "Server error: " + error.message });
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
        db.run(`UPDATE users SET ${walletField} = ${walletField} + ? WHERE LOWER(username) = LOWER(?)`,
            [withdrawal.amount, withdrawal.username], function(refundErr) {
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
// 5. DEPOSIT REQUESTS (User initiated)
// ==========================================
app.post('/api/request-deposit', authenticateToken, async (req, res) => {
    try {
        const { amount, payment_method, transaction_ref } = req.body;
        const username = req.user.username;
        if (!amount || amount < 1000) {
            return res.status(400).json({ error: "Minimum deposit amount is ₦1,000" });
        }
        db.run(`INSERT INTO deposits (username, amount, sender_name, status, payment_method, transaction_ref) 
                VALUES (?, ?, ?, 'pending', ?, ?)`,
                [username, amount, username, payment_method || 'bank_transfer', transaction_ref || null], function(err) {
            if (err) return res.status(500).json({ error: "Failed to create deposit request" });
            res.json({ success: true, message: "Deposit request submitted. Awaiting admin approval." });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/admin/deposits', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at DESC`, [], (err, rows) => {
        res.json({ success: true, deposits: rows });
    });
});

app.post('/api/admin/approve-deposit', authenticateToken, adminOnly, (req, res) => {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ error: "Deposit ID required" });
    db.get(`SELECT * FROM deposits WHERE id = ?`, [depositId], (err, deposit) => {
        if (err || !deposit) return res.status(400).json({ error: "Deposit not found." });
        db.run(`UPDATE deposits SET status = 'approved' WHERE id = ? AND status = 'pending'`, [deposit.id], function (updateErr) {
            if (updateErr) return res.status(500).json({ error: "Database error" });
            if (this.changes === 0) return res.status(400).json({ error: "Deposit already processed or not pending." });
            db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`, [deposit.amount, deposit.username], function (creditErr) {
                if (creditErr) return res.status(500).json({ error: "Failed to credit user" });
                console.warn(`[ADMIN] Deposit ${deposit.id} approved by ${req.user.username}`);
                res.json({ success: true, message: `Deposit of ₦${deposit.amount} approved for ${deposit.username}` });
            });
        });
    });
});

// ==========================================
// 6. DAILY TASK CLAIM
// ==========================================
app.post('/api/claim-daily-task', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
        db.get(`SELECT taskEarnings, planActivated FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(404).json({ error: "User not found" });
            if (user.planActivated !== 'true') return res.status(403).json({ error: "You must activate a plan first" });
            const today = new Date().toISOString().split('T')[0];
            db.get(`SELECT id FROM daily_claims WHERE username = ? AND claim_date = ?`, [username, today], async (err, claim) => {
                if (claim) return res.status(400).json({ error: "You have already claimed your daily task today. Come back tomorrow!" });
                const newTaskEarnings = (user.taskEarnings || 0) + amount;
                db.run(`UPDATE users SET taskEarnings = ? WHERE LOWER(username) = LOWER(?)`, [newTaskEarnings, username], function(updateErr) {
                    if (updateErr) return res.status(500).json({ error: "Failed to update earnings" });
                    db.run(`INSERT INTO daily_claims (username, claim_date, amount) VALUES (?, ?, ?)`, [username, today, amount]);
                    res.json({ success: true, message: `Successfully claimed ₦${amount}!`, newBalance: newTaskEarnings });
                });
            });
        });
    } catch (error) {
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
app.post('/api/admin/adjust-balance', authenticateToken, adminOnly, async (req, res) => {
    try {
        const { username, amount, walletType, action } = req.body;
        if (!username || !isValidAmount(amount)) {
            return res.status(400).json({ error: "Username and valid amount required" });
        }
        let query = "";
        const actionSign = action === 'subtract' ? '-' : '+';
        switch (walletType) {
            case 'taskEarnings': query = `UPDATE users SET taskEarnings = COALESCE(taskEarnings, 0) ${actionSign} ? WHERE LOWER(username) = LOWER(?)`; break;
            case 'daily_earnings': query = `UPDATE users SET daily_earnings = COALESCE(daily_earnings, 0) ${actionSign} ? WHERE LOWER(username) = LOWER(?)`; break;
            case 'affiliate_balance': query = `UPDATE users SET affiliate_balance = COALESCE(affiliate_balance, 0) ${actionSign} ? WHERE LOWER(username) = LOWER(?)`; break;
            default: query = `UPDATE users SET balance = COALESCE(balance, 0) ${actionSign} ? WHERE LOWER(username) = LOWER(?)`; break;
        }
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

app.post('/api/admin/manual-credit', authenticateToken, adminOnly, (req, res) => {
    const { username, amount, walletType } = req.body;
    console.log('[MANUAL-CREDIT DEBUG] Request:', { username, amount, walletType, adminUser: req.user?.username });
    
    if (!username || !isValidAmount(amount)) {
        console.log('[MANUAL-CREDIT DEBUG] Validation failed');
        return res.status(400).json({ error: "Username and valid amount required" });
    }
    
    // First, check if user exists and log their current balance
    db.get(`SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], (checkErr, user) => {
        if (checkErr || !user) {
            console.log('[MANUAL-CREDIT DEBUG] User not found:', username);
            return res.status(400).json({ error: "User not found" });
        }
        console.log('[MANUAL-CREDIT DEBUG] User found:', { id: user.id, username: user.username, currentBalance: user.balance, currentTaskEarnings: user.taskEarnings, currentDaily: user.daily_earnings, currentAffiliate: user.affiliate_balance });
        
        let query = "";
        switch (walletType) {
            case 'taskEarnings': query = `UPDATE users SET taskEarnings = COALESCE(taskEarnings, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
            case 'daily_earnings': query = `UPDATE users SET daily_earnings = COALESCE(daily_earnings, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
            case 'affiliate_balance': query = `UPDATE users SET affiliate_balance = COALESCE(affiliate_balance, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
            default: query = `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
        }
        
        console.log('[MANUAL-CREDIT DEBUG] Executing query:', query);
        db.run(query, [parseFloat(amount), username], function (err) {
            if (err) {
                console.error('[MANUAL-CREDIT DEBUG] Database error:', err.message, err);
                return res.status(500).json({ error: "Database error: " + err.message });
            }
            console.log('[MANUAL-CREDIT DEBUG] Update result - changes:', this.changes);
            if (this.changes === 0) {
                return res.status(400).json({ error: "User not found" });
            }
            
            // Verify the update worked by fetching updated balance
            db.get(`SELECT balance, taskEarnings, daily_earnings, affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], (verifyErr, updatedUser) => {
                console.log('[MANUAL-CREDIT DEBUG] Updated user:', updatedUser);
                console.warn(`[ADMIN] Manual credit of ₦${amount} to ${username}'s ${walletType || 'balance'} by ${req.user.username}`);
                res.json({ success: true, message: `Successfully credited ₦${amount} to ${username}'s wallet!` });
            });
        });
    });
});

app.get('/api/admin/users', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT id, username, balance, wallet_balance, taskEarnings, daily_earnings, affiliate_balance, planActivated, activePackage, role, created_at FROM users ORDER BY id DESC`, [], (err, rows) => {
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
                        `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE id = ?`,
                        [refundableCapital, plan.user_id]
                    );
                    impactedUserIds.add(Number(plan.user_id));
                } else if (plan.username) {
                    await dbRunAsync(
                        `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`,
                        [refundableCapital, plan.username]
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
        db.run(`UPDATE users SET balance = balance - ? WHERE LOWER(username) = LOWER(?) AND balance >= ?`, [cost, username, cost], function (updateErr) {
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
                         planActivated = 'false',
                         activePackage = 'None',
                         activePackageId = NULL
                     WHERE id = ? AND planActivated = 'true'`,
                    [inv.capital, inv.user_id],
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
app.listen(PORT, '0.0.0.0', () => {
    processActiveInvestmentCycles();
    setInterval(processActiveInvestmentCycles, 60 * 60 * 1000);
});