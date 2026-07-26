require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
    : path.resolve(__dirname, '..', 'database.sqlite');

const db = new sqlite3.Database(dbPath);

db.configure('busyTimeout', 15000);

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

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

async function runMigration() {
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
        throw new Error('No legacy investment table found. Checked: user_investments, investments, earning_plans.');
    }

    const userColumns = await getColumns('users');
    const planColumns = await getColumns(activePlanTable);

    const statusColumn = pickFirst(planColumns, ['status', 'plan_status']);
    const capitalColumn = pickFirst(planColumns, ['capital', 'deposit_amount', 'amount', 'principal']);
    const packageIdColumn = pickFirst(planColumns, ['package_id', 'plan_id']);
    const planUserIdColumn = pickFirst(planColumns, ['user_id', 'uid']);
    const planUsernameColumn = pickFirst(planColumns, ['username', 'user_name']);

    if (!statusColumn || !capitalColumn || (!planUserIdColumn && !planUsernameColumn)) {
        throw new Error(
            `Unsupported legacy table shape for ${activePlanTable}. Required: status, capital/deposit_amount, and user_id or username.`
        );
    }

    const completeAtColumn = pickFirst(planColumns, ['completed_at', 'closed_at', 'updated_at']);
    const floatingRoiColumns = [
        'current_daily_roi',
        'active_earning_rate',
        'accrued_profit',
        'pending_profit',
        'floating_roi',
        'unpaid_roi'
    ].filter((column) => planColumns.includes(column));

    let affectedPlans = [];
    if (packageIdColumn) {
        const placeholders = fixedPackageIds.map(() => '?').join(', ');
        affectedPlans = await all(
            `SELECT *
             FROM ${activePlanTable}
             WHERE LOWER(${statusColumn}) IN ('active', 'ongoing')
               AND (
                 ${packageIdColumn} IS NULL OR TRIM(${packageIdColumn}) = ''
                 OR LOWER(${packageIdColumn}) NOT IN (${placeholders})
               )`,
            fixedPackageIds
        );
    } else {
        affectedPlans = await all(
            `SELECT * FROM ${activePlanTable} WHERE LOWER(${statusColumn}) IN ('active', 'ongoing')`
        );
    }

    await run('BEGIN IMMEDIATE TRANSACTION');

    try {
        let refundedPlans = 0;
        let refundedTotal = 0;
        const affectedUserIds = new Set();
        const affectedUsernames = new Set();

        for (const plan of affectedPlans) {
            const capitalRaw = Number(plan[capitalColumn] || 0);
            const refundableCapital = Number.isFinite(capitalRaw) && capitalRaw > 0 ? capitalRaw : 0;

            if (refundableCapital > 0) {
                if (planUserIdColumn && plan[planUserIdColumn]) {
                    const userId = Number(plan[planUserIdColumn]);
                    await run(
                        'UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE id = ?',
                        [refundableCapital, userId]
                    );
                    affectedUserIds.add(userId);
                } else if (planUsernameColumn && plan[planUsernameColumn]) {
                    const username = String(plan[planUsernameColumn]);
                    await run(
                        'UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE LOWER(username) = LOWER(?)',
                        [refundableCapital, username]
                    );
                    affectedUsernames.add(username);
                }

                refundedPlans += 1;
                refundedTotal += refundableCapital;
            }

            if (plan.id) {
                const setFragments = [`${statusColumn} = 'cancelled_system_upgrade'`];
                const params = [];

                if (completeAtColumn && completeAtColumn !== 'updated_at') {
                    setFragments.push(`${completeAtColumn} = datetime('now')`);
                }

                floatingRoiColumns.forEach((column) => {
                    if (column === 'active_earning_rate') {
                        setFragments.push(`${column} = NULL`);
                    } else {
                        setFragments.push(`${column} = 0`);
                    }
                });

                await run(
                    `UPDATE ${activePlanTable} SET ${setFragments.join(', ')} WHERE id = ?`,
                    [plan.id]
                );
            }
        }

        if (userColumns.includes('daily_earnings')) {
            if (affectedUserIds.size > 0) {
                for (const userId of affectedUserIds) {
                    await run('UPDATE users SET daily_earnings = 0 WHERE id = ?', [userId]);
                }
            }
            if (affectedUsernames.size > 0) {
                for (const username of affectedUsernames) {
                    await run('UPDATE users SET daily_earnings = 0 WHERE LOWER(username) = LOWER(?)', [username]);
                }
            }
        }

        if (userColumns.includes('current_daily_roi')) {
            if (affectedUserIds.size > 0) {
                for (const userId of affectedUserIds) {
                    await run('UPDATE users SET current_daily_roi = 0 WHERE id = ?', [userId]);
                }
            }
            if (affectedUsernames.size > 0) {
                for (const username of affectedUsernames) {
                    await run('UPDATE users SET current_daily_roi = 0 WHERE LOWER(username) = LOWER(?)', [username]);
                }
            }
        }

        if (userColumns.includes('active_earning_rate')) {
            if (affectedUserIds.size > 0) {
                for (const userId of affectedUserIds) {
                    await run('UPDATE users SET active_earning_rate = NULL WHERE id = ?', [userId]);
                }
            }
            if (affectedUsernames.size > 0) {
                for (const username of affectedUsernames) {
                    await run('UPDATE users SET active_earning_rate = NULL WHERE LOWER(username) = LOWER(?)', [username]);
                }
            }
        }

        if (userColumns.includes('planActivated') || userColumns.includes('activePackage') || userColumns.includes('activePackageId')) {
            if (affectedUserIds.size > 0) {
                for (const userId of affectedUserIds) {
                    await run(
                        "UPDATE users SET planActivated = 'false', activePackage = 'None', activePackageId = NULL WHERE id = ?",
                        [userId]
                    );
                }
            }
            if (affectedUsernames.size > 0) {
                for (const username of affectedUsernames) {
                    await run(
                        "UPDATE users SET planActivated = 'false', activePackage = 'None', activePackageId = NULL WHERE LOWER(username) = LOWER(?)",
                        [username]
                    );
                }
            }
        }

        await run('COMMIT');

    } catch (error) {
        await run('ROLLBACK');
        throw error;
    }
}

runMigration()
    .then(() => {
        db.close();
        process.exit(0);
    })
    .catch((error) => {
        console.error('Legacy plan migration failed:', error.message);
        db.close();
        process.exit(1);
    });
