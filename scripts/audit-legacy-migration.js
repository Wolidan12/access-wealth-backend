try {
    require('dotenv').config();
} catch (_) {}
const path = require('path');
const sqlite3 = require('../sqlite-compat');

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : path.resolve(__dirname, '..', 'database.sqlite');

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

async function tableExists(tableName) {
    const row = await get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row);
}

async function getColumns(tableName) {
    const rows = await all(`PRAGMA table_info(${tableName})`);
    return rows.map((row) => row.name);
}

function pickFirst(columns, candidates) {
    return candidates.find((candidate) => columns.includes(candidate)) || null;
}

function printLine(label, value) {
    const padded = `${label}:`.padEnd(44, ' ');
    console.log(`${padded}${value}`);
}

async function runAudit() {
    const fixedPackageIds = [
        'starter_basic',
        'starter_bronze',
        'starter_silver',
        'starter_gold',
        'growth_plus',
        'growth_pro',
        'growth_max',
        'wealth_standard',
        'wealth_premium',
        'elite_vanguard',
        'elite_apex'
    ];

    const candidatePlanTables = ['user_investments', 'investments', 'earning_plans'];
    let activePlanTable = null;

    for (const tableName of candidatePlanTables) {
        const exists = await tableExists(tableName);
        if (exists) {
            activePlanTable = tableName;
            break;
        }
    }

    if (!activePlanTable) {
        throw new Error('No investment table found. Checked: user_investments, investments, earning_plans.');
    }

    const userColumns = await getColumns('users');
    const planColumns = await getColumns(activePlanTable);

    const statusColumn = pickFirst(planColumns, ['status', 'plan_status']);
    const capitalColumn = pickFirst(planColumns, ['capital', 'deposit_amount', 'amount', 'principal']);
    const packageIdColumn = pickFirst(planColumns, ['package_id', 'plan_id']);

    if (!statusColumn || !capitalColumn) {
        throw new Error(`Unsupported ${activePlanTable} structure: missing status or capital-like columns.`);
    }

    const placeholders = fixedPackageIds.map(() => '?').join(', ');
    const legacyFilter = packageIdColumn
        ? `(
              ${packageIdColumn} IS NULL OR TRIM(${packageIdColumn}) = ''
              OR LOWER(${packageIdColumn}) NOT IN (${placeholders})
           )`
        : '1=1';

    const activeLegacySql = `
        SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(${capitalColumn}, 0)), 0) AS capital_sum
        FROM ${activePlanTable}
        WHERE LOWER(COALESCE(${statusColumn}, '')) IN ('active', 'ongoing')
          AND ${legacyFilter}
    `;

    const cancelledLegacySql = `
        SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(${capitalColumn}, 0)), 0) AS capital_sum
        FROM ${activePlanTable}
        WHERE LOWER(COALESCE(${statusColumn}, '')) = 'cancelled_system_upgrade'
          AND ${legacyFilter}
    `;

    const activeLegacy = packageIdColumn
        ? await get(activeLegacySql, fixedPackageIds)
        : await get(activeLegacySql);

    const cancelledLegacy = packageIdColumn
        ? await get(cancelledLegacySql, fixedPackageIds)
        : await get(cancelledLegacySql);

    const beforeEstimate = Number(activeLegacy.count || 0) + Number(cancelledLegacy.count || 0);
    const afterCount = Number(activeLegacy.count || 0);
    const refundedTotal = Number(cancelledLegacy.capital_sum || 0);

    const nonZeroUserRoiChecks = [];
    if (userColumns.includes('current_daily_roi')) {
        nonZeroUserRoiChecks.push('COALESCE(current_daily_roi, 0) <> 0');
    }
    if (userColumns.includes('active_earning_rate')) {
        nonZeroUserRoiChecks.push('active_earning_rate IS NOT NULL AND COALESCE(active_earning_rate, 0) <> 0');
    }

    let usersWithLegacyRoi = { count: 0 };
    if (nonZeroUserRoiChecks.length) {
        usersWithLegacyRoi = await get(
            `SELECT COUNT(*) AS count FROM users WHERE ${nonZeroUserRoiChecks.join(' OR ')}`
        );
    }

    const nonZeroPlanRoiColumns = ['accrued_profit', 'pending_profit', 'floating_roi', 'unpaid_roi']
        .filter((col) => planColumns.includes(col));

    let plansWithFloatingRoi = { count: 0 };
    if (nonZeroPlanRoiColumns.length) {
        const roiConditions = nonZeroPlanRoiColumns.map((col) => `COALESCE(${col}, 0) <> 0`);
        const planRoiSql = `
            SELECT COUNT(*) AS count
            FROM ${activePlanTable}
            WHERE LOWER(COALESCE(${statusColumn}, '')) = 'cancelled_system_upgrade'
              AND ${legacyFilter}
              AND (${roiConditions.join(' OR ')})
        `;

        plansWithFloatingRoi = packageIdColumn
            ? await get(planRoiSql, fixedPackageIds)
            : await get(planRoiSql);
    }

    console.log('=== Legacy Migration Audit Report ===');
    printLine('Database', dbPath);
    printLine('Detected plan table', activePlanTable);
    printLine('Status column', statusColumn);
    printLine('Capital column', capitalColumn);
    printLine('Package ID column', packageIdColumn || 'n/a');
    console.log('-------------------------------------');
    printLine('Legacy plans before migration (estimate)', beforeEstimate);
    printLine('Legacy plans active now (after)', afterCount);
    printLine('Legacy plans cancelled_system_upgrade', Number(cancelledLegacy.count || 0));
    printLine('Total refunded capital (NGN)', refundedTotal.toFixed(2));
    console.log('-------------------------------------');
    printLine('Users with non-zero legacy ROI trackers', Number(usersWithLegacyRoi.count || 0));
    printLine('Cancelled legacy plans with floating ROI', Number(plansWithFloatingRoi.count || 0));
    console.log('=====================================');
}

runAudit()
    .then(() => {
        db.close();
        process.exit(0);
    })
    .catch((error) => {
        console.error('Legacy migration audit failed:', error.message);
        db.close();
        process.exit(1);
    });
