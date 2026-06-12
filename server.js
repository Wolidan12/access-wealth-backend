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

const app = express();

// ==========================================
// ENVIRONMENT VARIABLE VALIDATION
// ==========================================
if (!process.env.JWT_SECRET || !process.env.PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: JWT_SECRET or PAYSTACK_SECRET_KEY is missing.");
    process.exit(1);
}

// ==========================================
// SECURITY & MIDDLEWARE
// ==========================================
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = (process.env.FRONTEND_URL || 'https://accesswealthhq.com,http://localhost:3000').split(',');
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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-paystack-signature'],
    credentials: true
}));

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(express.static(__dirname));

app.use((req, res, next) => {
    console.log(`[RADAR] ${req.method} request at: ${req.url}`);
    next();
});

// ==========================================
// VALIDATION HELPERS
// ==========================================
function isValidAmount(val) {
    const num = parseFloat(val);
    return typeof num === 'number' && !isNaN(num) && isFinite(num) && num > 0;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ==========================================
// RATE LIMITERS
// ==========================================
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
// DATABASE INITIALIZATION
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : './database.sqlite';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        console.log(`✅ DATABASE CONNECTED! (Path: ${dbPath})`);
        db.configure('busyTimeout', 10000);
        db.run("PRAGMA journal_mode=WAL;", (pragmaErr) => {
            if (pragmaErr) console.error("Failed to enable WAL mode:", pragmaErr.message);
            else console.log("✅ WAL mode & BusyTimeout enabled for high concurrency.");
        });
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password TEXT, 
        balance REAL DEFAULT 0, 
        taskEarnings REAL DEFAULT 0, 
        daily_earnings REAL DEFAULT 0, 
        affiliate_balance REAL DEFAULT 0, 
        my_referral_id TEXT UNIQUE, 
        referred_by TEXT, 
        planActivated TEXT DEFAULT 'false', 
        activePackage TEXT DEFAULT 'None',
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        sender_name TEXT, 
        status TEXT DEFAULT 'pending', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS paystack_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        email TEXT,
        amount REAL,
        reference TEXT UNIQUE,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        fee REAL,
        total_deducted REAL,
        wallet_type TEXT, 
        status TEXT DEFAULT 'pending', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
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

    // Auto-create admin & support accounts if they don't exist (with error handling)
    db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`, (err, row) => {
        if (err) console.error("Admin check error:", err.message);
        if (!row) {
            const adminHash = bcryptjs.hashSync('Admin@234', 10);
            db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage)
                    VALUES (?, ?, 'admin', 'ADMIN123', 'true', 'Wealth VIP')`,
                    ['admin@accesswealth.com', adminHash], function(insertErr) {
                if (insertErr) console.error("Failed to create admin:", insertErr.message);
                else if (this.changes) console.log("✅ Admin account created: admin@accesswealth.com / Admin@234");
                else console.log("Admin account already exists.");
            });
        } else {
            console.log("Admin account already exists.");
        }
    });
    db.get(`SELECT id FROM users WHERE role = 'support' LIMIT 1`, (err, row) => {
        if (err) console.error("Support check error:", err.message);
        if (!row) {
            const supportHash = bcryptjs.hashSync('Support@234', 10);
            db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage)
                    VALUES (?, ?, 'support', 'SUPPORT123', 'true', 'Wealth VIP')`,
                    ['support@accesswealth.com', supportHash], function(insertErr) {
                if (insertErr) console.error("Failed to create support:", insertErr.message);
                else if (this.changes) console.log("✅ Support account created: support@accesswealth.com / Support@234");
                else console.log("Support account already exists.");
            });
        } else {
            console.log("Support account already exists.");
        }
    });
});

// ==========================================
// JWT AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access token required" });
    jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'AccessWealthHQ',
        audience: 'AccessWealthUsers'
    }, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token" });
        req.user = user;
        next();
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
    const query = `SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, role, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [req.params.username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    });
});

app.post('/api/user/sync', authenticateToken, (req, res) => {
    const username = req.user.username;
    const query = `SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, role, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    });
});

// ==========================================
// IMPROVED REGISTRATION (with better error handling)
// ==========================================
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password, referred_by } = req.body;

        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        if (!/^[a-zA-Z0-9_.@-]{3,50}$/.test(username)) return res.status(400).json({ error: "Invalid username/email format" });
        if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

        // Check if username already exists
        db.get(`SELECT id FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, existing) => {
            if (err) {
                console.error("DB error on username check:", err.message);
                return res.status(500).json({ error: "Database error, please try again" });
            }
            if (existing) return res.status(400).json({ error: "Username already taken. Please choose another." });

            const my_referral_id = "AW" + crypto.randomBytes(4).toString('hex').toUpperCase();
            const hashedPassword = await bcryptjs.hash(password, 10);

            db.run(`INSERT INTO users (username, password, my_referral_id, referred_by, role) VALUES (?, ?, ?, ?, 'user')`,
                [username, hashedPassword, my_referral_id, referred_by || null], function (err) {
                    if (err) {
                        console.error("Registration insert error:", err.message);
                        if (err.message.includes("UNIQUE constraint failed: users.username")) {
                            return res.status(400).json({ error: "Username already taken (duplicate)." });
                        }
                        if (err.message.includes("UNIQUE constraint failed: users.my_referral_id")) {
                            return res.status(500).json({ error: "System error: please try again." });
                        }
                        return res.status(500).json({ error: "Database error during registration. Please try again." });
                    }
                    const token = jwt.sign({ id: this.lastID, username, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'AccessWealthHQ', audience: 'AccessWealthUsers' });
                    res.json({ success: true, message: "Registration successful!", token, user: { id: this.lastID, username, role: 'user', planActivated: 'false' } });
                });
        });
    } catch (error) {
        console.error("Registration catch error:", error);
        res.status(500).json({ error: "Registration failed due to server error." });
    }
});

// ==========================================
// LOGIN (unchanged)
// ==========================================
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        db.get(`SELECT id, username, password, role, planActivated, activePackage FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "Invalid username or password" });
            const passwordMatch = await bcryptjs.compare(password, user.password);
            if (!passwordMatch) return res.status(400).json({ error: "Invalid username or password" });
            const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'AccessWealthHQ', audience: 'AccessWealthUsers' });
            res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role, planActivated: user.planActivated, activePackage: user.activePackage } });
        });
    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

// ==========================================
// 2. PAYSTACK AUTOMATED DEPOSITS (keep as is)
// ==========================================
app.post('/api/paystack/initialize', authenticateToken, actionLimiter, async (req, res) => {
    try {
        const { amount, email } = req.body;
        if (!isValidAmount(amount) || !isValidEmail(email)) return res.status(400).json({ error: "Valid amount and email required" });
        const amountInKobo = Math.round(parseFloat(amount) * 100);
        const reference = `AW_DEP_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
        db.run(`INSERT INTO paystack_transactions (username, email, amount, reference, status) VALUES (?, ?, ?, ?, 'pending')`,
            [req.user.username, email, parseFloat(amount), reference], async function (err) {
                if (err) return res.status(500).json({ error: "Failed to create transaction record." });
                try {
                    const paystackRes = await axios.post('https://api.paystack.co/transaction/initialize',
                        { email, amount: amountInKobo, reference, callback_url: 'https://accesswealthhq.com/dashboard.html' },
                        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
                    );
                    res.json({ success: true, authorization_url: paystackRes.data.data.authorization_url, reference });
                } catch (apiError) {
                    res.status(500).json({ error: "Failed to connect to Paystack gateway." });
                }
            });
    } catch (error) {
        res.status(500).json({ error: "Server error during initialization." });
    }
});

app.get('/api/paystack/verify/:reference', authenticateToken, actionLimiter, async (req, res) => {
    const reference = req.params.reference;
    try {
        db.get(`SELECT * FROM paystack_transactions WHERE reference = ?`, [reference], async (err, transaction) => {
            if (err || !transaction) return res.status(404).json({ error: "Transaction not found." });
            try {
                const paystackRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
                const data = paystackRes.data.data;
                if (data.status === 'success') {
                    const amountPaid = data.amount / 100;
                    if (amountPaid < transaction.amount) return res.status(400).json({ error: "Amount paid is less than requested." });
                    db.run(`UPDATE paystack_transactions SET status = 'success' WHERE reference = ? AND status = 'pending'`, [reference], function (updateErr) {
                        if (updateErr) return res.status(500).json({ error: "Failed to update transaction status." });
                        if (this.changes === 0) return res.status(400).json({ error: "Transaction already processed." });
                        db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`, [transaction.amount, transaction.username], function (creditErr) {
                            if (creditErr) return res.status(500).json({ error: "Failed to credit user wallet." });
                            res.json({ success: true, message: `Successfully deposited ₦${transaction.amount} into your wallet!` });
                        });
                    });
                } else {
                    res.status(400).json({ error: `Payment verification failed. Status: ${data.status}` });
                }
            } catch (apiError) {
                res.status(500).json({ error: "Failed to verify transaction with Paystack." });
            }
        });
    } catch (error) {
        res.status(500).json({ error: "Server error during payment verification." });
    }
});

app.post('/api/paystack/webhook', webhookLimiter, (req, res) => {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('Missing Paystack signature header');
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
    if (hash !== signature) {
        console.warn(`Invalid webhook signature from ${req.ip}`);
        return res.status(400).send('Invalid signature');
    }
    res.sendStatus(200);
    const event = req.body;
    if (event.event === 'charge.success') {
        const reference = event.data.reference;
        const amountPaid = event.data.amount / 100;
        db.get(`SELECT * FROM paystack_transactions WHERE reference = ?`, [reference], (err, transaction) => {
            if (err || !transaction) return;
            if (amountPaid < transaction.amount) return;
            db.run(`UPDATE paystack_transactions SET status = 'success' WHERE reference = ? AND status = 'pending'`, [reference], function (updateErr) {
                if (updateErr || this.changes === 0) return;
                db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`, [transaction.amount, transaction.username], (creditErr) => {
                    if (!creditErr) console.log(`Webhook credited ₦${transaction.amount} to ${transaction.username}`);
                });
            });
        });
    }
});

// ==========================================
// 3. SUBSCRIPTION PLANS (All 13 Tiers)
// ==========================================
const planRewards = {
    'Access Starter': { price: 3000, welcome: 1500, referral: 1500 },
    'Access Basic': { price: 5500, welcome: 2500, referral: 2800 },
    'Access Plus': { price: 7500, welcome: 3500, referral: 4000 },
    'Access Pro': { price: 10000, welcome: 4800, referral: 5500 },
    'Wealth Premium': { price: 15000, welcome: 6500, referral: 8500 },
    'Wealth Elite': { price: 25000, welcome: 10000, referral: 14000 },
    'Wealth Pro Max': { price: 35000, welcome: 14000, referral: 20000 },
    'Wealth Executive': { price: 45000, welcome: 18000, referral: 25500 },
    'Wealth Apex': { price: 55000, welcome: 22000, referral: 31000 },
    'Wealth VIP': { price: 100000, welcome: 40000, referral: 55000 },
    'Wealth Tycoon': { price: 200000, welcome: 80000, referral: 115000 },
    'Wealth Mogul': { price: 350000, welcome: 140000, referral: 200000 },
    'Access Infinity': { price: 500000, welcome: 200000, referral: 300000 }
};

app.post('/api/activate', authenticateToken, actionLimiter, (req, res) => {
    const plan = planRewards[req.body.name];
    if (!plan || plan.price !== req.body.price) return res.status(400).json({ error: "Invalid plan" });
    db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.planActivated === 'true') return res.status(400).json({ error: "You already have an active package" });
        if (user.balance < plan.price) return res.status(400).json({ error: "Insufficient deposit balance." });
        const newBalance = user.balance - plan.price;
        const newDailyEarnings = (user.daily_earnings || 0) + plan.welcome;
        db.run(`UPDATE users SET balance = ?, daily_earnings = ?, planActivated = 'true', activePackage = ? WHERE id = ? AND planActivated = 'false'`,
            [newBalance, newDailyEarnings, req.body.name, req.user.id], function (updateErr) {
                if (updateErr) return res.status(500).json({ error: "Database error." });
                if (this.changes === 0) return res.status(400).json({ error: "Plan already activated or balance insufficient." });
                if (user.referred_by) {
                    db.run(`UPDATE users SET affiliate_balance = COALESCE(affiliate_balance, 0) + ? WHERE my_referral_id = ?`, [plan.referral, user.referred_by]);
                }
                res.json({ success: true, newBalance });
            });
    });
});

// ==========================================
// 4. INSTANT AFFILIATE WITHDRAWAL ENGINE
// ==========================================
app.post('/api/withdraw/affiliate', authenticateToken, actionLimiter, (req, res) => {
    const { amount } = req.body;
    if (!isValidAmount(amount)) return res.status(400).json({ error: "Valid amount required" });
    const withdrawAmount = parseFloat(amount);
    if (withdrawAmount < 3000) return res.status(400).json({ error: "Minimum referral withdrawal is ₦3,000" });
    const fee = withdrawAmount * 0.05;
    const netAmount = withdrawAmount - fee;
    db.run(`UPDATE users SET affiliate_balance = affiliate_balance - ? WHERE id = ? AND affiliate_balance >= ?`, [withdrawAmount, req.user.id, withdrawAmount], function (err) {
        if (err) return res.status(500).json({ error: "Database error during deduction." });
        if (this.changes === 0) return res.status(400).json({ error: "Insufficient affiliate balance." });
        db.run(`INSERT INTO withdrawals (username, amount, fee, total_deducted, wallet_type) VALUES (?, ?, ?, ?, 'affiliate')`, [req.user.username, netAmount, fee, withdrawAmount], function (err2) {
            if (err2) return res.status(500).json({ error: "Failed to record withdrawal." });
            res.json({ success: true, message: `Success! ₦${netAmount} (after 5% fee) is queued for instant payout.` });
        });
    });
});

app.get('/api/admin/withdrawals', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC`, [], (err, rows) => {
        res.json({ success: true, withdrawals: rows || [] });
    });
});

app.post('/api/admin/approve-withdrawal', authenticateToken, adminOnly, (req, res) => {
    const { id } = req.body;
    db.run(`UPDATE withdrawals SET status = 'approved' WHERE id = ? AND status = 'pending'`, [id], function (err) {
        if (err) return res.status(500).json({ error: "Database error" });
        if (this.changes === 0) return res.status(400).json({ error: "Withdrawal not found or already approved" });
        console.warn(`[ADMIN] Withdrawal ${id} approved by ${req.user.username}`);
        res.json({ success: true });
    });
});

// ==========================================
// 5. LIVE CHAT / CUSTOMER SUPPORT API
// ==========================================
app.get('/api/chat/history/:username', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin' && req.user.username.toLowerCase() !== req.params.username.toLowerCase()) {
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

// ==========================================
// 6. ADMIN COMMAND CENTER & UTILITIES
// ==========================================
app.post('/api/deposit', authenticateToken, actionLimiter, (req, res) => {
    const { amount, senderName } = req.body;
    if (!isValidAmount(amount) || !senderName) return res.status(400).json({ error: "Valid amount and sender name required" });
    db.run(`INSERT INTO deposits (username, amount, sender_name, status) VALUES (?, ?, ?, 'pending')`, [req.user.username, parseFloat(amount), senderName], function () {
        res.json({ success: true, message: "Deposit request submitted for admin approval" });
    });
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

app.post('/api/admin/manual-credit', authenticateToken, adminOnly, (req, res) => {
    const { username, amount, walletType } = req.body;
    if (!username || !isValidAmount(amount)) return res.status(400).json({ error: "Username and valid amount required" });
    let query = "";
    switch (walletType) {
        case 'taskEarnings': query = `UPDATE users SET taskEarnings = COALESCE(taskEarnings, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
        case 'daily_earnings': query = `UPDATE users SET daily_earnings = COALESCE(daily_earnings, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
        case 'affiliate_balance': query = `UPDATE users SET affiliate_balance = COALESCE(affiliate_balance, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
        default: query = `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`; break;
    }
    db.run(query, [parseFloat(amount), username], function (err) {
        if (err) return res.status(500).json({ error: "Database error." });
        if (this.changes === 0) return res.status(400).json({ error: "User not found" });
        console.warn(`[ADMIN] Manual credit of ₦${amount} to ${username}'s ${walletType || 'balance'} by ${req.user.username}`);
        res.json({ success: true, message: `Successfully credited ₦${amount} to ${username}'s wallet!` });
    });
});

app.get('/api/admin/users', authenticateToken, adminOnly, (req, res) => {
    db.all(`SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance, planActivated, activePackage, role, created_at FROM users ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, users: rows });
    });
});

app.get('/api/admin/stats', authenticateToken, adminOnly, (req, res) => {
    const stats = { totalUsers: 0, activePlans: 0, revenue: 0, pendingDeposits: 0, pendingWithdrawals: 0 };
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => { if (row) stats.totalUsers = row.count;
        db.get("SELECT COUNT(*) as count FROM users WHERE planActivated = 'true'", [], (err, row) => { if (row) stats.activePlans = row.count;
            const revenueQuery = `SELECT (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE status = 'approved') + (SELECT COALESCE(SUM(amount), 0) FROM paystack_transactions WHERE status = 'success') AS total`;
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

// ==========================================
// DEBUG ROUTES (temporary – remove after testing)
// ==========================================
app.get('/debug/ensure-admin', async (req, res) => {
    try {
        const adminHash = bcryptjs.hashSync('Admin@234', 10);
        db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage)
                VALUES (?, ?, 'admin', 'ADMIN123', 'true', 'Wealth VIP')`,
                ['admin@accesswealth.com', adminHash], function(err) {
            if (err) return res.json({ error: err.message });
            res.json({ success: true, changes: this.changes, message: this.changes ? "Admin created" : "Admin already exists" });
        });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/debug/check-users', (req, res) => {
    db.all(`SELECT username, role FROM users`, [], (err, rows) => {
        if (err) res.json({ error: err.message });
        else res.json({ users: rows });
    });
});

// ==========================================
// GLOBAL ERROR HANDLER & SHUTDOWN
// ==========================================
app.use((err, req, res, next) => {
    console.error(`UNHANDLED ERROR:`, err.stack);
    res.status(500).json({ error: "Internal server error" });
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing DB...');
    db.close((err) => {
        if (err) console.error('Error closing DB:', err.message);
        else console.log('DB closed.');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend running on port ${PORT}`);
});