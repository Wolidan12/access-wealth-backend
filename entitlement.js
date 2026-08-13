const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LEGACY_PLAN_TABLES = ['user_investments', 'investments', 'earning_plans'];
const ACTIVE_PLAN_STATUSES = ['active', 'ongoing', 'running', 'in_progress'];

function createEntitlementHelpers(deps) {
    const {
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
    } = deps;

    const tableExistsCache = new Map();
    const tableColumnsCache = new Map();

    function pickFirstColumn(columns, candidates) {
        return candidates.find((candidate) => columns.includes(candidate)) || null;
    }

    function isUsablePackageLabel(value) {
        const label = String(value || '').trim();
        if (!label) return false;
        return !['none', 'null', 'undefined', '0', 'false'].includes(label.toLowerCase());
    }

    function findCatalogPackage(packageId, packageName) {
        const idKey = String(packageId || '').trim().toLowerCase();
        if (idKey && PACKAGE_BY_ID[idKey]) return PACKAGE_BY_ID[idKey];

        const nameKey = String(packageName || '').trim().toLowerCase();
        if (nameKey && PACKAGE_BY_NAME[nameKey]) return PACKAGE_BY_NAME[nameKey];

        if (nameKey) {
            for (const pkg of FIXED_PACKAGES) {
                const pkgName = pkg.name.toLowerCase();
                if (nameKey.includes(pkgName) || pkgName.includes(nameKey) || nameKey.includes(pkg.id)) {
                    return pkg;
                }
            }
        }
        return null;
    }

    function normalizeRate(value) {
        const rate = toFiniteNumber(value);
        if (rate === null || rate <= 0) return null;
        return rate > 1 ? rate / 100 : rate;
    }

    function computeDailyEarning({ dailyEarning, capital, dailyRate, packageId, packageName }) {
        const stored = toFiniteNumber(dailyEarning);
        if (stored !== null && stored > 0) return stored;

        const catalog = findCatalogPackage(packageId, packageName);
        const cap = toFiniteNumber(capital);
        const rate = normalizeRate(dailyRate) ?? (catalog ? catalog.daily_rate : null);
        if (cap !== null && cap > 0 && rate !== null && rate > 0) {
            return cap * rate;
        }
        if (catalog) {
            if (cap !== null && cap > 0) return cap * catalog.daily_rate;
            return catalog.daily_earning;
        }
        return null;
    }

    async function tableExists(tableName) {
        if (tableExistsCache.has(tableName)) return tableExistsCache.get(tableName);
        const row = await dbGetAsync(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
            [tableName]
        );
        const exists = Boolean(row);
        tableExistsCache.set(tableName, exists);
        return exists;
    }

    async function getTableColumnNames(tableName) {
        if (tableColumnsCache.has(tableName)) return tableColumnsCache.get(tableName);
        const rows = await dbAllAsync(`PRAGMA table_info(${tableName})`);
        const columns = (rows || []).map((row) => row.name);
        tableColumnsCache.set(tableName, columns);
        return columns;
    }

    function readRowField(row, candidates) {
        if (!row) return undefined;
        for (const key of candidates) {
            if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
                return row[key];
            }
        }
        return undefined;
    }

    function shapeEntitlement(raw, source) {
        if (!raw) return null;
        const packageId = readRowField(raw, ['package_id', 'packageId', 'plan_id', 'activePackageId']);
        const packageName = readRowField(raw, ['package_name', 'packageName', 'plan_name', 'name', 'activePackage']);
        const capital = toFiniteNumber(readRowField(raw, [
            'capital', 'deposit_amount', 'amount', 'principal', 'plan_capital', 'investment_capital'
        ]));
        const dailyRate = normalizeRate(readRowField(raw, [
            'daily_rate', 'dailyRate', 'roi', 'rate', 'active_earning_rate', 'current_daily_roi'
        ]));
        const catalog = findCatalogPackage(packageId, packageName);
        const dailyEarning = computeDailyEarning({
            dailyEarning: readRowField(raw, ['daily_earning', 'dailyEarning', 'daily_roi', 'daily_profit', 'earning']),
            capital: capital ?? catalog?.capital,
            dailyRate: dailyRate ?? catalog?.daily_rate,
            packageId,
            packageName
        });
        const cycleDays = toFiniteNumber(readRowField(raw, ['cycle_days', 'cycleDays', 'duration', 'days']))
            ?? catalog?.cycle_days
            ?? 30;
        const resolvedCapital = capital ?? catalog?.capital ?? 0;
        const resolvedRate = dailyRate
            ?? catalog?.daily_rate
            ?? (resolvedCapital > 0 && dailyEarning ? dailyEarning / resolvedCapital : 0);
        const totalPayout = toFiniteNumber(readRowField(raw, ['total_payout', 'totalPayout']))
            ?? catalog?.total_payout
            ?? (resolvedCapital + (dailyEarning || 0) * cycleDays);

        const hasIdentity = isUsablePackageLabel(packageId)
            || isUsablePackageLabel(packageName)
            || resolvedCapital > 0
            || (dailyEarning || 0) > 0;
        if (!hasIdentity) return null;

        return {
            source,
            id: raw.id || null,
            package_id: isUsablePackageLabel(packageId) ? String(packageId) : (catalog?.id || null),
            package_name: isUsablePackageLabel(packageName) ? String(packageName) : (catalog?.name || 'Legacy Plan'),
            capital: resolvedCapital,
            daily_rate: resolvedRate || 0,
            daily_earning: dailyEarning || 0,
            cycle_days: Number.isInteger(cycleDays) ? cycleDays : Math.round(cycleDays || 30),
            total_payout: totalPayout || 0,
            referral_bonus: toFiniteNumber(raw.referral_bonus) ?? (catalog ? getReferralBonus(catalog) : 0),
            days_credited: toFiniteNumber(raw.days_credited) ?? 0,
            status: raw.status || 'active',
            activated_at: raw.activated_at || raw.created_at || null,
            completed_at: raw.completed_at || null
        };
    }

    async function findActivePlanInTable(tableName, user) {
        if (!(await tableExists(tableName))) return null;
        const columns = await getTableColumnNames(tableName);
        if (!columns.length) return null;

        const statusColumn = pickFirstColumn(columns, ['status', 'plan_status']);
        const userIdColumn = pickFirstColumn(columns, ['user_id', 'uid']);
        const usernameColumn = pickFirstColumn(columns, ['username', 'user_name']);
        const orderColumn = pickFirstColumn(columns, ['activated_at', 'created_at', 'id']);

        const conditions = [];
        const params = [];
        if (statusColumn) {
            const placeholders = ACTIVE_PLAN_STATUSES.map(() => '?').join(', ');
            conditions.push(`LOWER(COALESCE(${statusColumn}, '')) IN (${placeholders})`);
            params.push(...ACTIVE_PLAN_STATUSES);
        }

        const ownerConditions = [];
        if (userIdColumn && user.id != null) {
            ownerConditions.push(`${userIdColumn} = ?`);
            params.push(user.id);
        }
        if (usernameColumn && user.username) {
            ownerConditions.push(`LOWER(${usernameColumn}) = LOWER(?)`);
            params.push(user.username);
        }
        if (!ownerConditions.length) return null;
        conditions.push(`(${ownerConditions.join(' OR ')})`);

        const row = await dbGetAsync(
            `SELECT * FROM ${tableName}
             WHERE ${conditions.join(' AND ')}
             ORDER BY ${orderColumn || 'rowid'} DESC
             LIMIT 1`,
            params
        );
        return shapeEntitlement(row, tableName);
    }

    function shapeEntitlementFromUser(user) {
        const hasFlag = isTrueFlag(user.planActivated);
        const hasPackage = isUsablePackageLabel(user.activePackage) || isUsablePackageLabel(user.activePackageId);
        const hasRate = normalizeRate(user.active_earning_rate ?? user.current_daily_roi ?? user.daily_rate) !== null;
        const hasCapital = toFiniteNumber(user.plan_capital ?? user.investment_capital) > 0;
        if (!hasFlag && !hasPackage && !hasRate && !hasCapital) return null;

        return shapeEntitlement({
            package_id: user.activePackageId,
            package_name: user.activePackage,
            capital: user.plan_capital ?? user.investment_capital,
            daily_rate: user.active_earning_rate ?? user.current_daily_roi ?? user.daily_rate,
            daily_earning: user.daily_earning_amount ?? user.plan_daily_earning,
            cycle_days: user.cycle_days,
            total_payout: user.total_payout,
            status: 'active'
        }, 'user_fields');
    }

    async function resolveActiveEntitlement(user) {
        if (!user) return null;

        const candidates = [];
        for (const tableName of LEGACY_PLAN_TABLES) {
            try {
                const fromTable = await findActivePlanInTable(tableName, user);
                if (fromTable) candidates.push(fromTable);
            } catch (error) {
                console.warn(`Active entitlement lookup skipped for ${tableName}:`, error.message);
            }
        }

        const fromUser = shapeEntitlementFromUser(user);
        if (fromUser) candidates.push(fromUser);

        const withEarnings = candidates.find((item) => toFiniteNumber(item.daily_earning) > 0);
        if (withEarnings) return withEarnings;
        if (candidates.length) return candidates[0];

        if (user.username) {
            try {
                const lastClaim = await dbGetAsync(
                    `SELECT amount FROM daily_claims
                     WHERE LOWER(username) = LOWER(?) AND COALESCE(amount, 0) > 0
                     ORDER BY datetime(created_at) DESC, id DESC
                     LIMIT 1`,
                    [user.username]
                );
                if (lastClaim && (isTrueFlag(user.planActivated) || isUsablePackageLabel(user.activePackage) || isUsablePackageLabel(user.activePackageId))) {
                    return shapeEntitlement({
                        package_id: user.activePackageId,
                        package_name: user.activePackage,
                        daily_earning: lastClaim.amount
                    }, 'last_claim');
                }
            } catch (_) {
                // daily_claims may not exist yet during very early startup.
            }
        }

        return null;
    }

    function applyEntitlementToUser(user, entitlement) {
        if (!user || !entitlement) return user;
        return {
            ...user,
            planActivated: 'true',
            activePackage: entitlement.package_name || user.activePackage || 'Legacy Plan',
            activePackageId: entitlement.package_id || user.activePackageId || null
        };
    }

    async function serializeUserWithEntitlement(user) {
        const entitlement = await resolveActiveEntitlement(user);
        return serializeUser(applyEntitlementToUser(user, entitlement));
    }

    function extractAccessToken(req) {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        if (authHeader) {
            const value = String(authHeader).trim();
            const bearer = /^Bearer\s+(.+)$/i.exec(value);
            if (bearer) return bearer[1].trim();
            if (value && !/\s/.test(value)) return value;
        }
        const headerToken = req.headers['x-access-token'] || req.headers['x-auth-token'];
        if (headerToken) return String(headerToken).trim();

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const fromBody = body.token || body.accessToken || body.access_token
            || body.refreshToken || body.refresh_token || body.newToken;
        if (fromBody) return String(fromBody).trim();
        return null;
    }

    function buildTokenPayload(user, extra = {}) {
        const token = signAccessToken(user);
        return {
            success: true,
            token,
            accessToken: token,
            access_token: token,
            newToken: token,
            ...extra
        };
    }

    function nextClaimAtFrom(date = new Date()) {
        return new Date(date.getTime() + CLAIM_COOLDOWN_MS).toISOString();
    }

    function parseSqliteDate(value) {
        if (!value) return null;
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        const raw = String(value).trim();
        if (!raw) return null;
        const isoGuess = raw.includes('T') ? raw : raw.replace(' ', 'T');
        const parsed = new Date(isoGuess);
        if (!Number.isNaN(parsed.getTime())) return parsed;
        const fallback = Date.parse(raw);
        return Number.isNaN(fallback) ? null : new Date(fallback);
    }

    function serializeActiveInvestment(entitlement) {
        if (!entitlement) return null;
        return {
            package_id: entitlement.package_id,
            package_name: entitlement.package_name,
            capital: entitlement.capital,
            daily_rate: entitlement.daily_rate,
            daily_earning: entitlement.daily_earning,
            cycle_days: entitlement.cycle_days,
            total_payout: entitlement.total_payout,
            id: entitlement.id,
            referral_bonus: entitlement.referral_bonus,
            days_credited: entitlement.days_credited,
            status: entitlement.status || 'active',
            activated_at: entitlement.activated_at,
            completed_at: entitlement.completed_at
        };
    }

    function invalidateSchemaCache() {
        tableExistsCache.clear();
        tableColumnsCache.clear();
    }

    return {
        CLAIM_COOLDOWN_MS,
        resolveActiveEntitlement,
        serializeUserWithEntitlement,
        extractAccessToken,
        buildTokenPayload,
        nextClaimAtFrom,
        parseSqliteDate,
        serializeActiveInvestment,
        invalidateSchemaCache
    };
}

module.exports = {
    createEntitlementHelpers,
    CLAIM_COOLDOWN_MS
};
