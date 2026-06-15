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

if (!process.env.JWT_SECRET || !process.env.PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: JWT_SECRET or PAYSTACK_SECRET_KEY is missing.");
    process.exit(1);
}

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

function isValidAmount(val) {
    const num = parseFloat(val);
    return typeof num === 'number' && !isNaN(num) && isFinite(num) && num > 0;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
        full_name TEXT,
        phone TEXT,
        bank_name TEXT,
        bank_account_number TEXT,
        bank_account_holder TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const columnsToAdd = [
        { name: 'balance', type: 'REAL DEFAULT 0' },
        { name: 'taskEarnings', type: 'REAL DEFAULT 0' },
        { name: 'daily_earnings', type: 'REAL DEFAULT 0' },
        { name: 'affiliate_balance', type: 'REAL DEFAULT 0' },
        { name: 'my_referral_id', type: 'TEXT UNIQUE' },
        { name: 'referred_by', type: 'TEXT' },
        { name: 'planActivated', type: 'TEXT DEFAULT \'false\'' },
        { name: 'activePackage', type: 'TEXT DEFAULT \'None\'' },
        { name: 'role', type: 'TEXT DEFAULT \'user\'' },
        { name: 'full_name', type: 'TEXT' },
        { name: 'phone', type: 'TEXT' },
        { name: 'bank_name', type: 'TEXT' },
        { name: 'bank_account_number', type: 'TEXT' },
        { name: 'bank_account_holder', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ];

    columnsToAdd.forEach(col => {
        db.run(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.warn(`Warning adding column ${col.name}:`, err.message);
            } else if (!err) {
                console.log(`✅ Column ${col.name} added (if missing).`);
            }
        });
    });

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
        bank_details TEXT,
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

    // Admin and support accounts
    setTimeout(() => {
        db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`, (err, row) => {
            if (err) console.error("Admin check error:", err.message);
            if (!row) {
                const adminHash = bcryptjs.hashSync('Admin@234', 10);
                db.run(`INSERT OR IGNORE INTO users (username, password, role, my_referral_id, planActivated, activePackage)
                        VALUES (?, ?, 'admin', 'ADMIN123', 'true', 'Wealth VIP')`,
                        ['admin@accesswealth.com', adminHash], function(insertErr) {
                    if (insertErr) console.error("Failed to create admin:", insertErr.message);
                    else if (this.changes) console.log("✅ Admin account created: admin@accesswealth.com / Admin@234");
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
                });
            } else {
                console.log("Support account already exists.");
            }
        });
    }, 500);
});

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
    const query = `SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, role, full_name, phone, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [req.params.username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    });
});

app.post('/api/user/sync', authenticateToken, (req, res) => {
    const username = req.user.username;
    const query = `SELECT id, username, balance, taskEarnings, daily_earnings, affiliate_balance, my_referral_id, referred_by, planActivated, activePackage, role, full_name, phone, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE LOWER(username) = LOWER(?)`;
    db.get(query, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    });
});

app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password, referred_by } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        if (!/^[a-zA-Z0-9_.@-]{3,50}$/.test(username)) return res.status(400).json({ error: "Invalid username/email format" });
        if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

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
        });
    } catch (error) {
        console.error("Registration catch error:", error);
        res.status(500).json({ error: "Registration failed due to server error." });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password required" });
        db.get(`SELECT id, username, password, role, planActivated, activePackage, my_referral_id FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
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
                    my_referral_id: user.my_referral_id
                }
            });
        });
    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

// ==========================================
// 2. PAYSTACK AUTOMATED DEPOSITS
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
// 4. WITHDRAWAL REQUESTS (User initiated)
// ==========================================
app.post('/api/request-withdrawal', authenticateToken, async (req, res) => {
    try {
        const { amount, wallet_type, bank_details } = req.body;
        const username = req.user.username;
        
        if (!amount || amount < 3000) {
            return res.status(400).json({ error: "Minimum withdrawal amount is ₦3,000" });
        }
        
        let walletField = '';
        if (wallet_type === 'affiliate') walletField = 'affiliate_balance';
        else if (wallet_type === 'task') walletField = 'taskEarnings';
        else walletField = 'balance';
        
        db.get(`SELECT ${walletField} as balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(404).json({ error: "User not found" });
            if (user.balance < amount) return res.status(400).json({ error: "Insufficient balance" });
            
            db.run(`UPDATE users SET ${walletField} = ${walletField} - ? WHERE LOWER(username) = LOWER(?) AND ${walletField} >= ?`, 
                [amount, username, amount], function(updateErr) {
                if (updateErr || this.changes === 0) return res.status(500).json({ error: "Failed to process withdrawal" });
                
                db.run(`INSERT INTO withdrawals (username, amount, wallet_type, status, bank_details) 
                        VALUES (?, ?, ?, 'pending', ?)`,
                        [username, amount, wallet_type, JSON.stringify(bank_details || {})], function(err2) {
                    if (err2) return res.status(500).json({ error: "Failed to create withdrawal request" });
                    res.json({ success: true, message: "Withdrawal request submitted. Awaiting admin approval." });
                });
            });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
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
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }
        
        db.get(`SELECT taskEarnings, planActivated FROM users WHERE LOWER(username) = LOWER(?)`, [username], async (err, user) => {
            if (err || !user) return res.status(404).json({ error: "User not found" });
            
            if (user.planActivated !== 'true') {
                return res.status(403).json({ error: "You must activate a plan first" });
            }
            
            const today = new Date().toISOString().split('T')[0];
            db.get(`SELECT id FROM daily_claims WHERE username = ? AND claim_date = ?`, [username, today], async (err, claim) => {
                if (claim) {
                    return res.status(400).json({ error: "You have already claimed your daily task today. Come back tomorrow!" });
                }
                
                const newTaskEarnings = (user.taskEarnings || 0) + amount;
                
                db.run(`UPDATE users SET taskEarnings = ? WHERE LOWER(username) = LOWER(?)`, [newTaskEarnings, username], function(updateErr) {
                    if (updateErr) return res.status(500).json({ error: "Failed to update earnings" });
                    
                    db.run(`INSERT INTO daily_claims (username, claim_date, amount) VALUES (?, ?, ?)`, [username, today, amount]);
                    
                    res.json({ 
                        success: true, 
                        message: `Successfully claimed ₦${amount}!`, 
                        newBalance: newTaskEarnings 
                    });
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
// 8. ADMIN COMMAND CENTER & UTILITIES
// ==========================================
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

// ==========================================
// 9. REFERRAL SYSTEM ENDPOINTS (Enhanced)
// ==========================================
app.get('/api/referral/stats/:username', authenticateToken, (req, res) => {
    const username = req.params.username;
    db.get(`SELECT my_referral_id FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        const myRefId = user.my_referral_id;
        db.get(`SELECT COUNT(*) as count, COALESCE(SUM(affiliate_balance), 0) as earnings FROM users WHERE referred_by = ?`, [myRefId], (err2, stats) => {
            if (err2) return res.status(500).json({ error: "Database error" });
            db.all(`SELECT username, created_at, planActivated FROM users WHERE referred_by = ? ORDER BY created_at DESC`, [myRefId], (err3, referrals) => {
                res.json({ 
                    success: true, 
                    totalReferrals: stats.count || 0, 
                    earnings: stats.earnings || 0,
                    referrals: referrals || []
                });
            });
        });
    });
});

app.get('/api/referral/leaderboard', (req, res) => {
    db.all(`SELECT username, affiliate_balance as total_earned, (SELECT COUNT(*) FROM users WHERE referred_by = u.my_referral_id) as referral_count FROM users u WHERE role = 'user' ORDER BY affiliate_balance DESC LIMIT 10`, [], (err, rows) => {
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
    const userPlan = req.user.activePackage || 'None';
    db.all(`SELECT * FROM sponsored_posts WHERE status = 'active' AND (required_plan = 'all' OR required_plan = ?) ORDER BY created_at DESC`, 
        [userPlan], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, posts: rows || [] });
    });
});

app.post('/api/claim-sponsored-post', authenticateToken, async (req, res) => {
    try {
        const { post_id } = req.body;
        const username = req.user.username;
        db.get(`SELECT reward_amount FROM sponsored_posts WHERE id = ? AND status = 'active'`, [post_id], (err, post) => {
            if (err || !post) return res.status(404).json({ error: "Post not found" });
            db.run(`UPDATE users SET taskEarnings = taskEarnings + ? WHERE LOWER(username) = LOWER(?)`, 
                [post.reward_amount, username], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: "Failed to credit reward" });
                res.json({ success: true, message: `Claimed ₦${post.reward_amount} successfully!` });
            });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error" });
    }
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
// DEBUG ROUTES (REMOVE AFTER USE)
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
    db.all(`SELECT username, role, my_referral_id FROM users`, [], (err, rows) => {
        if (err) res.json({ error: err.message });
        else res.json({ users: rows });
    });
});

app.get('/debug/fix-referral-ids', (req, res) => {
    db.run(`UPDATE users SET my_referral_id = 'AW' || upper(hex(randomblob(4))) WHERE my_referral_id IS NULL OR my_referral_id = ''`, function(err) {
        if (err) {
            console.error("Fix error:", err.message);
            return res.json({ error: err.message });
        }
        res.json({ success: true, updated: this.changes });
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