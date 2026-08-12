require('dotenv').config();
const path = require('path');
const sqlite3 = require('./sqlite-compat');

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : path.join(__dirname, 'database.sqlite');

const db = new sqlite3.Database(dbPath);
db.configure('busyTimeout', 15000);

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

(async () => {
    try {
        const count = await get('SELECT COUNT(*) AS count FROM users');
        const rows = await all(
            `SELECT username, balance, taskEarnings, daily_earnings, affiliate_balance, status
             FROM users ORDER BY id DESC LIMIT 10`
        );
        console.log('users', count ? count.count : 0);
        console.log(JSON.stringify(rows, null, 2));
    } catch (error) {
        console.error('Failed to query balances:', error.message);
        process.exitCode = 1;
    } finally {
        db.close((closeError) => {
            if (closeError) {
                console.error('Failed to close database:', closeError.message);
                process.exitCode = 1;
            }
        });
    }
})();
