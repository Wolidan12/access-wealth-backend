app.use(cors({
  origin: [
    'https://accesswealthhq.com',
    'https://www.accesswealthhq.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());

// 2. THE SILVER BULLET: This hosts all your HTML pages as a real website
app.use(express.static(__dirname)); 

// THE RADAR: Prints connections to terminal
app.use((req, res, next) => {
    console.log(`[RADAR] ${req.method} request received at: ${req.url}`);
    next();
});

// Initialize SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error("Database error:", err.message);
    else console.log('✅ DATABASE CONNECTED! (Full Website Host & Payout Engine Active)');
});

// Create ALL tables (Including the new Withdrawals table)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password TEXT, 
        balance REAL DEFAULT 0, 
        taskEarnings REAL DEFAULT 0, 
        daily_earnings REAL DEFAULT 0, 
        affiliate_balance REAL DEFAULT 0, 
        my_referral_id TEXT, 
        referred_by TEXT, 
        planActivated TEXT DEFAULT 'false', 
        activePackage TEXT DEFAULT 'None'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT, 
        amount REAL, 
        sender_name TEXT, 
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
});

// ==========================================
// 1. LIVE SYNC & AUTHENTICATION
// ==========================================
app.get('/api/user/:username', (req, res) => {
    db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [req.params.username], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    });
});

app.post('/api/register', (req, res) => {
    const { username, password, referred_by } = req.body;
    const my_referral_id = "AW" + Math.floor(Math.random() * 1000000);
    db.run(`INSERT INTO users (username, password, my_referral_id, referred_by) VALUES (?, ?, ?, ?)`, 
        [username, password, my_referral_id, referred_by || null], function(err) {
            if (err) return res.status(400).json({ error: "Username already exists." });
            res.json({ success: true, message: "Registration successful!" });
    });
});

app.post('/api/login', (req, res) => {
    if (req.body.username === 'Customer@gmail.com' && req.body.password === 'Support@234') {
        console.log("✅ SUPPORT AGENT LOGGED IN!");
        return res.json({ success: true, user: { username: 'Support_Agent', planActivated: 'admin' } });
    }
    db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND password = ?`, [req.body.username, req.body.password], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "Invalid username or password" });
        console.log(`✅ USER LOGGED IN: ${user.username}`);
        res.json({ success: true, user });
    });
});

// ==========================================
// 2. SUBSCRIPTION PLANS (All 13 Tiers)
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

app.post('/api/activate', (req, res) => {
    const plan = planRewards[req.body.name];
    if (!plan || plan.price !== req.body.price) return res.status(400).json({ error: "Invalid plan" });

    db.get(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [req.body.username], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.balance < plan.price) return res.status(400).json({ error: "Insufficient deposit balance." });
        
        const newBalance = user.balance - plan.price; 
        const newDailyEarnings = (user.daily_earnings || 0) + plan.welcome; 
        
        db.run(`UPDATE users SET balance = ?, daily_earnings = ?, planActivated = 'true', activePackage = ? WHERE LOWER(username) = LOWER(?)`, 
            [newBalance, newDailyEarnings, req.body.name, req.body.username], function(updateErr) {
            
            if (updateErr) return res.status(500).json({ error: "Database failed to update account." });
            if (user.referred_by) { 
                db.run(`UPDATE users SET affiliate_balance = COALESCE(affiliate_balance, 0) + ? WHERE my_referral_id = ?`, [plan.referral, user.referred_by]); 
            }
            res.json({ success: true, newBalance });
        });
    });
});

// ==========================================
// 3. INSTANT AFFILIATE WITHDRAWAL ENGINE
// ==========================================
app.post('/api/withdraw/affiliate', (req, res) => {
    const { username, amount } = req.body;
    const withdrawAmount = parseFloat(amount);
    
    // Safety Check: Minimum Withdrawal
    if (withdrawAmount < 3000) return res.status(400).json({ error: "Minimum referral withdrawal is ₦3,000" });

    db.get(`SELECT affiliate_balance FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.affiliate_balance < withdrawAmount) return res.status(400).json({ error: "Insufficient affiliate balance." });

        // Calculate 5% Fee
        const fee = withdrawAmount * 0.05; 
        const netAmount = withdrawAmount - fee;

        // Deduct from User's wallet immediately so they can't double-click
        db.run(`UPDATE users SET affiliate_balance = affiliate_balance - ? WHERE LOWER(username) = LOWER(?)`, [withdrawAmount, username], function(err) {
            if(err) return res.status(500).json({ error: "Database error during deduction." });

            // Add to Admin Payout Queue
            db.run(`INSERT INTO withdrawals (username, amount, fee, total_deducted, wallet_type) VALUES (?, ?, ?, ?, 'affiliate')`, 
            [username, netAmount, fee, withdrawAmount], function(err2) {
                res.json({ success: true, message: `Success! ₦${netAmount} (after 5% fee) is queued for instant payout.` });
            });
        });
    });
});

// Admin fetching the pending instant payouts
app.get('/api/admin/withdrawals', (req, res) => {
    db.all(`SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC`, [], (err, rows) => {
        res.json({ success: true, withdrawals: rows || [] });
    });
});

// Admin marking the payout as completed
app.post('/api/admin/approve-withdrawal', (req, res) => {
    const { id } = req.body;
    db.run(`UPDATE withdrawals SET status = 'approved' WHERE id = ? AND status = 'pending'`, [id], function(err) {
        res.json({ success: true });
    });
});

// ==========================================
// 4. LIVE CHAT / CUSTOMER SUPPORT API
// ==========================================
app.post('/api/chat/send', (req, res) => {
    const { user_id, sender, message } = req.body;
    db.run(`INSERT INTO messages (user_id, sender, message) VALUES (?, ?, ?)`, [user_id, sender, message], function(err) {
        if(err) return res.status(500).json({error: "Failed to send"});
        res.json({ success: true });
    });
});

app.get('/api/chat/history/:username', (req, res) => {
    db.all(`SELECT * FROM messages WHERE user_id = ? ORDER BY id ASC`, [req.params.username], (err, rows) => {
        res.json({ success: true, messages: rows || [] });
    });
});

app.get('/api/support/users', (req, res) => {
    db.all(`SELECT DISTINCT user_id FROM messages`, [], (err, rows) => {
        res.json({ success: true, users: rows || [] });
    });
});

// ==========================================
// 5. ADMIN COMMAND CENTER & UTILITIES
// ==========================================
app.post('/api/deposit', (req, res) => { 
    db.run(`INSERT INTO deposits (username, amount, sender_name, status) VALUES (?, ?, ?, 'pending')`, [req.body.username, parseFloat(req.body.amount), req.body.senderName], function() { 
        res.json({ success: true }); 
    }); 
});

app.get('/api/admin/deposits', (req, res) => { 
    db.all(`SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at DESC`, [], (err, rows) => { 
        res.json({ success: true, deposits: rows }); 
    }); 
});

app.post('/api/admin/approve-deposit', (req, res) => {
    db.get(`SELECT * FROM deposits WHERE id = ? AND status = 'pending'`, [req.body.depositId], (err, deposit) => {
        if (!deposit) return res.status(400).json({ error: "Not found or approved." });
        
        db.run(`UPDATE deposits SET status = 'approved' WHERE id = ?`, [deposit.id], function(err) {
            db.run(`UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)`, [deposit.amount, deposit.username], function(err) {
                res.json({ success: true }); 
            });
        });
    });
});

app.post('/api/admin/manual-credit', (req, res) => {
    const { username, amount, walletType } = req.body;
    const validWallets = ['balance', 'taskEarnings', 'daily_earnings', 'affiliate_balance'];
    const targetWallet = validWallets.includes(walletType) ? walletType : 'balance';

    db.run(`UPDATE users SET ${targetWallet} = COALESCE(${targetWallet}, 0) + ? WHERE LOWER(username) = LOWER(?)`, [parseFloat(amount), username], function(err) {
        if (err) return res.status(500).json({ error: "Database error." });
        res.json({ success: true, message: `Successfully credited ₦${amount} to ${username}'s ${targetWallet}!` });
    });
});

app.get('/api/admin/stats', (req, res) => {
    const stats = { totalUsers: 0, activePlans: 0, revenue: 0, pendingPayouts: 0, pendingWithdrawals: 0 };
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => { 
        if (row) stats.totalUsers = row.count;
        db.get("SELECT COUNT(*) as count FROM users WHERE planActivated = 'true'", [], (err, row) => { 
            if (row) stats.activePlans = row.count;
            db.get("SELECT SUM(amount) as total FROM deposits WHERE status = 'approved'", [], (err, row) => { 
                if (row && row.total) stats.revenue = row.total;
                db.get("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'", [], (err, row) => { 
                    if (row) stats.pendingPayouts = row.count;
                    db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'", [], (err, row) => {
                        if (row) stats.pendingWithdrawals = row.count;
                        res.json({ success: true, stats });
                    });
                });
            });
        });
    });
});

app.get('/api/admin/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY id DESC", [], (err, rows) => { res.json({ success: true, users: rows }); });
});

function verifyPremiumAccess(username, cost, res, callback) { 
    db.get(`SELECT balance, planActivated FROM users WHERE LOWER(username) = LOWER(?)`, [username], (err, user) => { 
        if (err || !user) return res.status(400).json({ error: "User not found" }); 
        if (user.planActivated !== 'true') return res.status(403).json({ error: "Premium Feature Locked." }); 
        if (user.balance < cost) return res.status(400).json({ error: "Insufficient balance." }); 
        callback(user.balance - cost); 
    }); 
}

app.post('/api/ads/create', (req, res) => { verifyPremiumAccess(req.body.username, req.body.price, res, (b) => { db.run(`UPDATE users SET balance = ? WHERE LOWER(username) = LOWER(?)`, [b, req.body.username], () => { db.run(`INSERT INTO ads (username, title, url, image, price) VALUES (?, ?, ?, ?, ?)`, [req.body.username, req.body.title, req.body.url, req.body.image, req.body.price], () => { res.json({ success: true, newBalance: b }); }); }); }); });
app.post('/api/bills/airtime', (req, res) => { verifyPremiumAccess(req.body.username, req.body.amount, res, (b) => { db.run(`UPDATE users SET balance = ? WHERE LOWER(username) = LOWER(?)`, [b, req.body.username], () => { db.run(`INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'airtime', ?, ?, ?)`, [req.body.username, req.body.network, req.body.phone, req.body.amount], () => { res.json({ success: true, newBalance: b }); }); }); }); });
app.post('/api/bills/data', (req, res) => { verifyPremiumAccess(req.body.username, req.body.amount, res, (b) => { db.run(`UPDATE users SET balance = ? WHERE LOWER(username) = LOWER(?)`, [b, req.body.username], () => { db.run(`INSERT INTO bills (username, bill_type, network, phone, amount) VALUES (?, 'data', ?, ?, ?)`, [req.body.username, req.body.network, req.body.phone, req.body.amount], () => { res.json({ success: true, newBalance: b }); }); }); }); });
app.post('/api/sms/send', (req, res) => { verifyPremiumAccess(req.body.username, req.body.cost, res, (b) => { db.run(`UPDATE users SET balance = ? WHERE LOWER(username) = LOWER(?)`, [b, req.body.username], () => { db.run(`INSERT INTO bulk_sms (username, sender_id, recipients_count, total_cost) VALUES (?, ?, ?, ?)`, [req.body.username, req.body.senderId, req.body.count, req.body.cost], () => { res.json({ success: true, newBalance: b }); }); }); }); });

const PORT = process.env.PORT || 3000;process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Master Server running on port ${PORT}`));