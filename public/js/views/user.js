// Member-facing screens: dashboard, plans, deposit, withdraw, referrals,
// profile & bank details, support chat, and announcements.

import { api } from '../api.js';
import { store } from '../store.js';
import {
    esc, fmtNaira, fmtNum, fmtPct, fmtDate, timeAgo, maskName, badge, tierBadge,
    toast, openModal, confirmModal, setBusy, skeletonCards, emptyState, copyToClipboard, fieldValue, fieldEl
} from '../ui.js';

let timers = [];

function addTimer(id) { timers.push(id); }
export function clearUserTimers() { timers.forEach((t) => clearInterval(t)); timers = []; }

async function refreshUser() {
    try {
        const data = await api('/api/user/sync', { method: 'POST' });
        if (data.user) store.setUser(data.user);
        return data.user;
    } catch (_) {
        return store.user;
    }
}

function walletChips(user) {
    return `
    <div class="stat-grid">
        <div class="stat stat-hero">
            <div class="stat-label">💼 Wallet balance</div>
            <div class="stat-value money">${fmtNaira(user?.wallet_balance ?? user?.balance ?? 0)}</div>
            <div class="stat-sub">Available for deposits into packages &amp; upgrades</div>
        </div>
        <div class="stat">
            <div class="stat-label">✅ Task earnings</div>
            <div class="stat-value money">${fmtNaira(user?.taskEarnings ?? 0)}</div>
            <div class="stat-sub">From daily claims</div>
        </div>
        <div class="stat">
            <div class="stat-label">🤝 Affiliate balance</div>
            <div class="stat-value money">${fmtNaira(user?.affiliate_balance ?? 0)}</div>
            <div class="stat-sub">From your referrals' activations</div>
        </div>
    </div>`;
}

function nudgeCards(user) {
    const bits = [];
    if (!user?.profile_complete) {
        bits.push(`<div class="notice notice-warning"><span class="notice-ico">🪪</span><p><strong>Complete your profile.</strong> Add your full name and phone number so support can reach you. <a href="#/profile"><strong>Update profile</strong></a></p></div>`);
    }
    if (!user?.bank_complete) {
        bits.push(`<div class="notice"><span class="notice-ico">🏦</span><p><strong>Add your bank details</strong> so withdrawals go straight to your account. <a href="#/profile"><strong>Add bank details</strong></a></p></div>`);
    }
    return bits.join('');
}

/* ================= DASHBOARD ================= */
export async function renderDashboard(root) {
    root.innerHTML = `
        <div class="page-head">
            <div><h2>Dashboard</h2><p class="lede">Loading your account…</p></div>
        </div>
        ${skeletonCards(3)}
        <div class="skeleton skel-card" style="min-height:140px"></div>`;

    const [user, activeRes, pendingWd, broadcasts] = await Promise.all([
        refreshUser(),
        api('/api/active-investment').catch(() => null),
        api('/api/user/pending-withdrawal').catch(() => null),
        api('/api/broadcasts').catch(() => ({ broadcasts: [] }))
    ]);

    const name = user?.full_name?.split(' ')[0] || user?.username || 'member';
    const inv = activeRes?.investment || null;

    let claimZone = '';
    if (inv) {
        claimZone = `
            <div class="card">
                <div class="card-header">
                    <h3>Daily claim — ${esc(inv.package_name || 'Active package')}</h3>
                    <span class="badge badge-active">Active</span>
                </div>
                <p class="mt-0">Your daily earning is <strong class="money">${fmtNaira(inv.daily_earning)}</strong>. Claim once every 24 hours.</p>
                <div class="flex">
                    <button class="btn btn-accent" id="claim-btn">🎁 Claim ${esc(fmtNaira(inv.daily_earning))}</button>
                    <span id="claim-status" class="countdown hide"></span>
                </div>
                <div id="claim-note" class="small mt-4"></div>
            </div>`;
    } else {
        claimZone = `
            <div class="card">
                <div class="card-header"><h3>Activate a package to start earning</h3></div>
                <p class="mt-0">You don't have an active package yet. Fund your wallet, then activate a package to start claiming daily earnings.</p>
                <div class="flex">
                    <a class="btn btn-primary" href="#/plans">View packages</a>
                    <a class="btn btn-secondary" href="#/deposit">Fund wallet</a>
                </div>
            </div>`;
    }

    let activeCard = '';
    if (inv) {
        const cycleDays = Number(inv.cycle_days) || 0;
        const credited = Number(inv.days_credited) || 0;
        const pct = cycleDays > 0 ? Math.min(100, Math.round((credited / cycleDays) * 100)) : 0;
        activeCard = `
            <div class="card">
                <div class="card-header">
                    <h3>${esc(inv.package_name || 'Active package')}</h3>
                    ${tierBadge(inv.package_id?.split('_')[0] ? inv.package_id.split('_')[0][0].toUpperCase() + inv.package_id.split('_')[0].slice(1) : '')}
                </div>
                <div class="pkg-rows">
                    <div class="row"><span>Capital</span><span class="money">${fmtNaira(inv.capital)}</span></div>
                    <div class="row"><span>Daily earning</span><span class="money">${fmtNaira(inv.daily_earning)}</span></div>
                    <div class="row"><span>Cycle progress</span><span class="num">${fmtNum(credited)} / ${fmtNum(cycleDays)} days</span></div>
                    <div class="row"><span>Projected total payout</span><span class="money">${fmtNaira(inv.total_payout)}</span></div>
                    <div class="row"><span>Status</span><span>${badge(inv.status || 'active')}</span></div>
                </div>
                <div class="progress mt-4" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Cycle progress">
                    <div class="progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="flex mt-4">
                    <a class="btn btn-secondary btn-sm" href="#/plans">Upgrade plan</a>
                    <a class="btn btn-ghost btn-sm" href="#/deposit">Fund wallet</a>
                </div>
            </div>`;
    }

    const pendingNotice = pendingWd?.hasPending
        ? `<div class="notice notice-warning"><span class="notice-ico">⏳</span><p>You have a withdrawal <strong>${esc(pendingWd.status || 'pending')}</strong>. It will be reviewed by an admin — you can track it under <a href="#/withdraw"><strong>Withdraw</strong></a>.</p></div>`
        : '';

    const bcList = (broadcasts?.broadcasts || []).slice(0, 3);
    const bcCard = bcList.length ? `
        <div class="card">
            <div class="card-header"><h3>📣 Announcements</h3><a class="btn btn-ghost btn-sm" href="#/announcements">View all</a></div>
            <div class="stack-sm">
                ${bcList.map((b) => `
                    <div>
                        <strong>${esc(b.title || 'Announcement')}</strong>
                        <div class="small">${esc(b.message)}</div>
                        <div class="small muted">${esc(timeAgo(b.created_at))}</div>
                    </div>`).join('<hr class="divider" />')}
            </div>
        </div>` : '';

    root.innerHTML = `
        <div class="page-head">
            <div>
                <h2>Hello, ${esc(name)} 👋</h2>
                <p class="lede">Here is your Access Wealth HQ account at a glance.</p>
            </div>
            <a class="btn btn-primary" href="#/deposit">+ Fund wallet</a>
        </div>

        ${nudgeCards(user)}
        ${pendingNotice}
        ${walletChips(user)}
        ${claimZone}
        <div class="two-col mt-4">
            ${activeCard || '<div></div>'}
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>Quick actions</h3></div>
                    <div class="quick-actions">
                        <a class="quick-action" href="#/plans"><span class="qa-ico">📦</span>Packages</a>
                        <a class="quick-action" href="#/deposit"><span class="qa-ico">💳</span>Deposit</a>
                        <a class="quick-action" href="#/withdraw"><span class="qa-ico">🏧</span>Withdraw</a>
                        <a class="quick-action" href="#/referrals"><span class="qa-ico">🤝</span>Referrals</a>
                        <a class="quick-action" href="#/support"><span class="qa-ico">💬</span>Support</a>
                        <a class="quick-action" href="#/profile"><span class="qa-ico">👤</span>Profile</a>
                    </div>
                </div>
                ${bcCard}
            </div>
        </div>`;

    if (inv) wireClaim(root);
}

function wireClaim(root) {
    const btn = root.querySelector('#claim-btn');
    const status = root.querySelector('#claim-status');
    const note = root.querySelector('#claim-note');

    const startCountdown = (nextIso) => {
        status.classList.remove('hide');
        const tick = () => {
            const target = new Date(nextIso).getTime();
            const left = target - Date.now();
            if (left <= 0) {
                status.textContent = '✨ You can claim now';
                btn.disabled = false;
                clearInterval(timerId);
                return;
            }
            const h = Math.floor(left / 3600000);
            const m = Math.floor((left % 3600000) / 60000);
            const s = Math.floor((left % 60000) / 1000);
            status.textContent = `⏳ Next claim in ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        };
        tick();
        const timerId = setInterval(tick, 1000);
        addTimer(timerId);
    };

    btn.addEventListener('click', async () => {
        setBusy(btn, true, 'Claiming…');
        try {
            const data = await api('/api/claim-daily-task', { method: 'POST' });
            toast(data.message || `Claimed ${fmtNaira(data.claimed_amount)}!`, 'success');
            note.innerHTML = `<span class="text-success">✔ ${esc(fmtNaira(data.claimed_amount))} added to your task earnings.</span>`;
            if (data.next_claim_at) { btn.disabled = true; startCountdown(data.next_claim_at); }
            refreshUser();
        } catch (err) {
            if (err.data && err.data.already_claimed) {
                note.innerHTML = `<span class="text-accent">✔ Already claimed today — come back tomorrow.</span>`;
                btn.disabled = true;
                if (err.data.next_claim_at) startCountdown(err.data.next_claim_at);
            } else if (err.code === 'PLAN_REQUIRED') {
                note.innerHTML = 'Activate a package first to claim daily earnings.';
            } else {
                toast(err.message, 'error');
            }
        } finally {
            setBusy(btn, false);
            if (status && !status.classList.contains('hide') && status.textContent.includes('Next claim')) btn.disabled = true;
        }
    });
}

/* ================= PLANS ================= */
export async function renderPlans(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Investment packages</h2>
        <p class="lede">Live package figures, straight from Access Wealth. Activate once; upgrade any time to a higher package by paying only the difference.</p></div></div>
        <div class="pkg-grid">${'<div class="skeleton skel-card" style="min-height:220px"></div>'.repeat(4)}</div>`;

    const [pkgsRes, activeRes] = await Promise.all([
        api('/api/packages', { auth: store.isAuthed }),
        store.isAuthed ? api('/api/active-investment').catch(() => null) : Promise.resolve(null)
    ]);
    const packages = (pkgsRes.packages || []).slice().sort((a, b) => a.capital - b.capital);
    const inv = activeRes?.investment || null;
    const balance = Number(activeRes?.balance ?? store.user?.wallet_balance ?? 0);

    const cardFor = (p) => {
        const isActive = inv && (inv.package_id === p.id);
        const eligibleUpgrade = inv && Number(p.capital) > Number(inv.capital);
        const upgradeCost = eligibleUpgrade ? Number(p.capital) - Number(inv.capital) : 0;
        const totalRoi = p.capital > 0 ? ((p.total_payout - p.capital) / p.capital) : 0;

        let cta;
        if (isActive) {
            cta = `<button class="btn btn-secondary pkg-cta" disabled>✔ Current package</button>`;
        } else if (eligibleUpgrade) {
            const afford = balance >= upgradeCost;
            cta = `<button class="btn ${afford ? 'btn-primary' : 'btn-secondary'} pkg-cta" data-upgrade="${esc(p.id)}">⬆ Upgrade — pay ${esc(fmtNaira(upgradeCost))}</button>`;
        } else if (inv) {
            cta = `<button class="btn btn-secondary pkg-cta" disabled title="Only higher packages are available while your plan is active">Not eligible (lower tier)</button>`;
        } else {
            const afford = balance >= Number(p.capital);
            cta = `<button class="btn ${afford ? 'btn-primary' : 'btn-secondary'} pkg-cta" data-activate="${esc(p.id)}">Activate ${afford ? '' : '· fund wallet first'}</button>`;
        }

        return `
        <article class="card pkg-card ${isActive ? 'pkg-active' : ''}">
            ${isActive ? '<span class="pkg-flag">Your plan</span>' : ''}
            <div class="pkg-tier-row"><h3 class="pkg-name">${esc(p.name)}</h3>${tierBadge(p.tier)}</div>
            <div class="pkg-capital money">${fmtNaira(p.capital)}</div>
            <div class="pkg-rows">
                <div class="row"><span>Daily earning</span><span>${fmtNaira(p.daily_earning)} (${fmtPct(p.daily_rate)}/day)</span></div>
                <div class="row"><span>Cycle</span><span>${fmtNum(p.cycle_days)} days</span></div>
                <div class="row"><span>Total payout</span><span>${fmtNaira(p.total_payout)} (+${fmtPct(totalRoi)})</span></div>
                <div class="row"><span>Referral bonus</span><span>${fmtNaira(p.referral_bonus)}</span></div>
            </div>
            ${cta}
            ${eligibleUpgrade && balance < upgradeCost ? `<div class="small text-danger">You need ${esc(fmtNaira(upgradeCost - balance))} more. <a href="#/deposit">Fund wallet</a></div>` : ''}
        </article>`;
    };

    const tiers = [...new Set(packages.map((p) => p.tier || 'Other'))];
    root.innerHTML = `
        <div class="page-head">
            <div>
                <h2>Investment packages</h2>
                <p class="lede">${inv
                    ? `You are on <strong>${esc(inv.package_name)}</strong> — you can upgrade to any higher package and pay only the difference.`
                    : 'Choose a package that matches your budget. Capital comes from your wallet balance.'}</p>
            </div>
            <div class="stack-sm" style="text-align:right">
                <div class="small muted">Wallet balance</div>
                <div class="money" style="font-size:1.3rem;font-weight:800">${fmtNaira(balance)}</div>
            </div>
        </div>
        ${tiers.map((tier) => `
            <h3 class="mt-5">${esc(tier)} tier</h3>
            <div class="pkg-grid">${packages.filter((p) => (p.tier || 'Other') === tier).map(cardFor).join('')}</div>
        `).join('')}
        <div class="notice mt-5"><span class="notice-ico">ℹ️</span><p>Package figures are loaded live from the server. Earnings follow the package terms you activate; Access Wealth never promises profits beyond the published package catalogue.</p></div>`;

    root.querySelectorAll('[data-activate]').forEach((btn) => {
        btn.addEventListener('click', () => openActivateModal(btn.dataset.activate, packages, balance, root));
    });
    root.querySelectorAll('[data-upgrade]').forEach((btn) => {
        btn.addEventListener('click', () => openUpgradeModal(btn.dataset.upgrade, packages, inv, balance, root));
    });
}

function openActivateModal(pkgId, packages, balance, root) {
    const p = packages.find((x) => x.id === pkgId);
    if (!p) return;
    const afford = balance >= Number(p.capital);
    openModal({
        title: `Activate ${p.name}`,
        body: `
            <p class="mt-0">Activating deducts <strong class="money">${fmtNaira(p.capital)}</strong> from your wallet and starts a ${fmtNum(p.cycle_days)}-day cycle at <strong class="money">${fmtNaira(p.daily_earning)}</strong> per day.</p>
            <div class="pkg-rows">
                <div class="row"><span>Your wallet balance</span><span class="money">${fmtNaira(balance)}</span></div>
                <div class="row"><span>Package capital</span><span class="money text-danger">−${fmtNaira(p.capital)}</span></div>
                <div class="row"><span>Balance after activation</span><span class="money">${fmtNaira(Math.max(0, balance - p.capital))}</span></div>
            </div>
            ${afford ? '' : `<div class="notice notice-danger mt-4"><span class="notice-ico">⚠️</span><p>Insufficient balance. You need ${esc(fmtNaira(p.capital - balance))} more. <a href="#/deposit">Fund your wallet</a> first.</p></div>`}`,
        actions: [
            { label: 'Cancel', className: 'btn-secondary', onClick: null },
            ...(afford ? [{
                label: 'Activate package', className: 'btn-primary',
                onClick: async () => {
                    const data = await api('/api/activate', { method: 'POST', body: { package_id: pkgId } });
                    toast(data.message || 'Package activated!', 'success');
                    await refreshUser();
                    renderPlans(root);
                }
            }] : [{ label: 'Fund wallet', className: 'btn-primary', onClick: async () => { location.hash = '#/deposit'; } }])
        ]
    });
}

function openUpgradeModal(pkgId, packages, inv, balance, root) {
    const p = packages.find((x) => x.id === pkgId);
    if (!p || !inv) return;
    const upgradeCost = Number(p.capital) - Number(inv.capital);
    const afford = balance >= upgradeCost;
    openModal({
        title: `Upgrade to ${p.name}`,
        body: `
            <p class="mt-0">You currently have <strong>${esc(inv.package_name)}</strong> (capital ${fmtNaira(inv.capital)}).
            Upgrading to <strong>${esc(p.name)}</strong> costs only the difference, deducted from your wallet. Your current cycle closes and the new one starts immediately — earnings already credited are kept.</p>
            <div class="pkg-rows">
                <div class="row"><span>New daily earning</span><span class="money">${fmtNaira(p.daily_earning)}</span></div>
                <div class="row"><span>New cycle</span><span>${fmtNum(p.cycle_days)} days</span></div>
                <div class="row"><span>Your wallet balance</span><span class="money">${fmtNaira(balance)}</span></div>
                <div class="row"><span><strong>You pay</strong></span><span class="money text-danger">−${fmtNaira(upgradeCost)}</span></div>
            </div>
            ${afford ? '' : `<div class="notice notice-danger mt-4"><span class="notice-ico">⚠️</span><p>Insufficient balance. You need ${esc(fmtNaira(upgradeCost - balance))} more. Please <a href="#/deposit">fund your wallet</a>.</p></div>`}`,
        actions: [
            { label: 'Cancel', className: 'btn-secondary', onClick: null },
            ...(afford ? [{
                label: `Pay ${esc(fmtNaira(upgradeCost))} & upgrade`, className: 'btn-primary',
                onClick: async () => {
                    const data = await api('/api/upgrade-package', { method: 'POST', body: { package_id: pkgId } });
                    toast(data.message || 'Upgrade complete!', 'success');
                    await refreshUser();
                    renderPlans(root);
                }
            }] : [{ label: 'Fund wallet', className: 'btn-primary', onClick: async () => { location.hash = '#/deposit'; } }])
        ]
    });
}

/* ================= DEPOSIT ================= */
export async function renderDeposit(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Fund your wallet</h2>
        <p class="lede">Deposits are made by bank transfer. Upload your receipt and an admin will credit your wallet after review.</p></div></div>
        <div class="skeleton skel-card" style="min-height:160px"></div>`;

    const [infoRes, depositsRes] = await Promise.all([
        api('/api/payment/manual-info', { auth: false }),
        api('/api/my-deposits').catch(() => ({ deposits: [] }))
    ]);
    const info = infoRes.payment || {};

    root.innerHTML = `
        <div class="page-head"><div><h2>Fund your wallet</h2>
        <p class="lede">Deposits are made by bank transfer. Upload your receipt and an admin will credit your wallet after review.</p></div></div>
        <div class="two-col">
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>1 · Transfer to the official account</h3></div>
                    ${info.enabled === false
                        ? `<div class="notice notice-danger"><span class="notice-ico">🚫</span><p>Manual deposits are currently disabled. Please check back later or contact support.</p></div>`
                        : `
                    <div class="stack-sm">
                        <div class="copy-field"><span class="small">Bank</span><code>${esc(info.bank_name || '—')}</code></div>
                        <div class="copy-field"><span class="small">Account name</span><code>${esc(info.account_name || '—')}</code></div>
                        <div class="copy-field"><span class="small">Account number</span><code>${esc(info.account_number || '—')}</code>
                            <button class="btn btn-sm btn-secondary" id="copy-acct" type="button">Copy</button>
                        </div>
                        <p class="small mb-0">${esc(info.instructions || '')}</p>
                    </div>`}
                </div>
                <div class="card">
                    <div class="card-header"><h3>2 · Submit your deposit</h3></div>
                    <form id="dep-form" novalidate>
                        <div class="field">
                            <label for="dep-amount">Amount (₦)</label>
                            <input class="input" id="dep-amount" name="amount" type="number" min="1000" step="100" inputmode="numeric" placeholder="e.g. 5000" required />
                            <div class="hint">Minimum deposit is ₦1,000.</div>
                        </div>
                        <div class="field">
                            <label for="dep-sender">Sender name (account you paid from)</label>
                            <input class="input" id="dep-sender" name="sender_name" type="text" autocomplete="name" placeholder="e.g. Adaeze Okafor" />
                        </div>
                        <div class="field">
                            <label for="dep-ref">Transaction reference <span class="muted">(optional)</span></label>
                            <input class="input" id="dep-ref" name="transaction_ref" type="text" placeholder="Bank/transfer reference" />
                        </div>
                        <div class="field">
                            <label>Payment receipt (required)</label>
                            <div class="dropzone" id="dz" tabindex="0" role="button" aria-label="Upload payment receipt">
                                <span class="dz-ico">🧾</span>
                                <strong>Tap to choose</strong> or drag a photo/PDF here
                                <div class="hint">PNG, JPG, GIF, WEBP or PDF — max 5MB.</div>
                                <input type="file" id="dep-file" accept="image/*,.pdf" class="hide" />
                            </div>
                            <div class="error-text hide" id="dep-error" role="alert"></div>
                        </div>
                        <button class="btn btn-primary btn-block" type="submit" id="dep-btn" ${info.enabled === false ? 'disabled' : ''}>Upload receipt &amp; submit</button>
                    </form>
                </div>
            </div>
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>Deposit history</h3><button class="btn btn-ghost btn-sm" id="dep-refresh" type="button">Refresh</button></div>
                    <div id="dep-history"></div>
                </div>
            </div>
        </div>`;

    const copyBtn = root.querySelector('#copy-acct');
    if (copyBtn) copyBtn.addEventListener('click', () => copyToClipboard(info.account_number || '', 'Account number copied'));

    const dz = root.querySelector('#dz');
    const fileInput = root.querySelector('#dep-file');
    const errEl = root.querySelector('#dep-error');
    let selectedFile = null;

    const showFile = () => {
        errEl.classList.add('hide');
        if (!selectedFile) return;
        if (selectedFile.size > 5 * 1024 * 1024) {
            errEl.textContent = 'That file is over 5MB. Please choose a smaller or compressed photo.';
            errEl.classList.remove('hide');
            selectedFile = null;
            return;
        }
        let preview = '';
        if (selectedFile.type.startsWith('image/')) {
            preview = `<img class="dz-preview" alt="Receipt preview" src="${URL.createObjectURL(selectedFile)}" />`;
        } else {
            preview = `<div class="mt-4">📄 ${esc(selectedFile.name)}</div>`;
        }
        dz.innerHTML = `<span class="dz-ico">✅</span><strong>${esc(selectedFile.name)}</strong><div class="hint">${(selectedFile.size / 1024).toFixed(0)} KB — tap to replace</div>${preview}`;
        dz.appendChild(fileInput);
    };

    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('drag');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            selectedFile = e.dataTransfer.files[0];
            showFile();
        }
    });
    fileInput.addEventListener('change', () => {
        selectedFile = fileInput.files[0] || null;
        showFile();
    });

    const renderHistory = (deposits) => {
        const el = root.querySelector('#dep-history');
        if (!deposits.length) {
            el.innerHTML = `<div class="empty"><span class="empty-ico">🧾</span><p>No deposits yet. Your requests will appear here with their review status.</p></div>`;
            return;
        }
        el.innerHTML = `<div class="row-list">${deposits.map((d) => `
            <div class="row-item">
                <div class="row-main">
                    <div class="row-title money">${fmtNaira(d.amount)}</div>
                    <div class="row-sub">${esc(fmtDate(d.created_at))}${d.admin_note ? ` · ${esc(d.admin_note)}` : ''}</div>
                </div>
                ${badge(d.status)}
            </div>`).join('')}</div>`;
    };
    renderHistory(depositsRes.deposits || []);

    root.querySelector('#dep-refresh').addEventListener('click', async () => {
        try {
            const fresh = await api('/api/my-deposits');
            renderHistory(fresh.deposits || []);
        } catch (err) { toast(err.message, 'error'); }
    });

    const form = root.querySelector('#dep-form');
    const btn = root.querySelector('#dep-btn');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.classList.add('hide');
        const amount = Number(fieldValue(form, 'amount'));
        if (!Number.isFinite(amount) || amount < 1000) {
            errEl.textContent = 'Minimum deposit amount is ₦1,000.';
            errEl.classList.remove('hide');
            return;
        }
        if (!selectedFile) {
            errEl.textContent = 'Please upload your payment receipt to complete the deposit request.';
            errEl.classList.remove('hide');
            return;
        }
        const fd = new FormData();
        fd.append('amount', String(amount));
        fd.append('payment_method', 'bank_transfer');
        if (fieldValue(form, 'sender_name').trim()) fd.append('sender_name', fieldValue(form, 'sender_name').trim());
        if (fieldValue(form, 'transaction_ref').trim()) fd.append('transaction_ref', fieldValue(form, 'transaction_ref').trim());
        fd.append('receipt', selectedFile);

        setBusy(btn, true, 'Uploading…');
        try {
            const data = await api('/api/request-deposit/upload', { method: 'POST', formData: fd });
            toast(data.message || 'Deposit submitted for review.', 'success');
            form.reset();
            selectedFile = null;
            dz.innerHTML = `<span class="dz-ico">🧾</span><strong>Tap to choose</strong> or drag a photo/PDF here<div class="hint">PNG, JPG, GIF, WEBP or PDF — max 5MB.</div>`;
            dz.appendChild(fileInput);
            const fresh = await api('/api/my-deposits');
            renderHistory(fresh.deposits || []);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.classList.remove('hide');
        } finally {
            setBusy(btn, false);
        }
    });
}

/* ================= WITHDRAW ================= */
export async function renderWithdraw(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Withdraw funds</h2>
        <p class="lede">Withdraw to your registered bank account. Minimum ₦3,000; one request at a time.</p></div></div>
        <div class="skeleton skel-card" style="min-height:160px"></div>`;

    const [user, pending, history] = await Promise.all([
        refreshUser(),
        api('/api/user/pending-withdrawal').catch(() => null),
        api('/api/user/withdrawals').catch(() => ({ withdrawals: [] }))
    ]);

    const wallets = [
        { key: 'balance', label: 'Wallet balance', value: Number(user?.wallet_balance ?? user?.balance ?? 0) },
        { key: 'task', label: 'Task earnings', value: Number(user?.taskEarnings ?? 0) },
        { key: 'affiliate', label: 'Affiliate balance', value: Number(user?.affiliate_balance ?? 0) }
    ];

    const hasBank = user?.bank_complete;
    const hasPending = pending?.hasPending;

    root.innerHTML = `
        <div class="page-head"><div><h2>Withdraw funds</h2>
        <p class="lede">Withdraw to your registered bank account. Minimum ₦3,000; one pending request at a time.</p></div></div>
        <div class="two-col">
            <div class="stack">
                ${hasPending ? `<div class="notice notice-warning"><span class="notice-ico">⏳</span><p>You already have a withdrawal <strong>${esc(pending.status || 'pending')}</strong>. You'll be able to submit a new request once it is resolved.</p></div>` : ''}
                ${!hasBank ? `<div class="notice"><span class="notice-ico">🏦</span><p>You haven't saved bank details yet. You can enter them below for this request, or <a href="#/profile">save them to your profile</a>.</p></div>` : ''}
                <div class="card">
                    <div class="card-header"><h3>New withdrawal</h3></div>
                    <form id="wd-form" novalidate>
                        <div class="field">
                            <label for="wd-wallet">Wallet</label>
                            <select class="select" id="wd-wallet" name="wallet_type">
                                ${wallets.map((w) => `<option value="${w.key}">${esc(w.label)} — ${esc(fmtNaira(w.value))}</option>`).join('')}
                            </select>
                        </div>
                        <div class="field">
                            <label for="wd-amount">Amount (₦)</label>
                            <input class="input" id="wd-amount" name="amount" type="number" min="3000" step="100" inputmode="numeric" placeholder="Min ₦3,000" required ${hasPending ? 'disabled' : ''} />
                            <div class="hint" id="wd-available"></div>
                        </div>
                        <div class="field">
                            <label for="wd-bank">Bank name</label>
                            <input class="input" id="wd-bank" name="bank_name" type="text" value="${esc(user?.bank_name || '')}" placeholder="e.g. Moniepoint" />
                        </div>
                        <div class="field">
                            <label for="wd-acct">Account number</label>
                            <input class="input" id="wd-acct" name="account_number" type="text" inputmode="numeric" value="${esc(user?.bank_account_number || '')}" placeholder="10-digit account number" />
                        </div>
                        <div class="field">
                            <label for="wd-holder">Account holder name</label>
                            <input class="input" id="wd-holder" name="account_holder" type="text" value="${esc(user?.bank_account_holder || '')}" placeholder="Name on the account" />
                        </div>
                        <div class="field"><div class="error-text hide" id="wd-error" role="alert"></div></div>
                        <button class="btn btn-primary btn-block" type="submit" id="wd-btn" ${hasPending ? 'disabled' : ''}>Submit withdrawal request</button>
                    </form>
                </div>
            </div>
            <div class="card">
                <div class="card-header"><h3>Withdrawal history</h3></div>
                <div id="wd-history"></div>
            </div>
        </div>`;

    const form = root.querySelector('#wd-form');
    const errEl = root.querySelector('#wd-error');
    const btn = root.querySelector('#wd-btn');
    const availableHint = root.querySelector('#wd-available');

    const updateAvailable = () => {
        const w = wallets.find((x) => x.key === fieldValue(form, 'wallet_type'));
        availableHint.textContent = w ? `Available in ${w.label}: ${fmtNaira(w.value)}` : '';
    };
    fieldEl(form, 'wallet_type').addEventListener('change', updateAvailable);
    updateAvailable();

    const renderHistory = (rows) => {
        const el = root.querySelector('#wd-history');
        if (!rows.length) {
            el.innerHTML = `<div class="empty"><span class="empty-ico">🏧</span><p>No withdrawals yet.</p></div>`;
            return;
        }
        el.innerHTML = `<div class="row-list">${rows.map((w) => `
            <div class="row-item">
                <div class="row-main">
                    <div class="row-title money">${fmtNaira(w.amount)} <span class="small muted">· ${esc(w.wallet_type)}</span></div>
                    <div class="row-sub">${esc(fmtDate(w.created_at))}${w.admin_note ? ` · ${esc(w.admin_note)}` : ''}</div>
                </div>
                ${badge(w.status)}
            </div>`).join('')}</div>`;
    };
    renderHistory(history.withdrawals || []);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.classList.add('hide');
        const amount = Number(fieldValue(form, 'amount'));
        const wallet_type = fieldValue(form, 'wallet_type');
        if (!Number.isFinite(amount) || amount < 3000) {
            errEl.textContent = 'Minimum withdrawal amount is ₦3,000.';
            errEl.classList.remove('hide');
            return;
        }
        const selected = wallets.find((w) => w.key === wallet_type);
        if (selected && amount > selected.value) {
            errEl.textContent = `Insufficient balance in ${selected.label}.`;
            errEl.classList.remove('hide');
            return;
        }
        const bank = fieldValue(form, 'bank_name').trim();
        const acct = fieldValue(form, 'account_number').trim();
        const holder = fieldValue(form, 'account_holder').trim();
        if (!bank || !acct || !holder) {
            errEl.textContent = 'Please fill in all bank details for this payout.';
            errEl.classList.remove('hide');
            return;
        }
        setBusy(btn, true, 'Submitting…');
        try {
            const data = await api('/api/request-withdrawal', {
                method: 'POST',
                body: { amount, wallet_type, bank_details: { bank_name: bank, account_number: acct, account_holder: holder } }
            });
            toast(data.message || 'Withdrawal submitted — awaiting approval.', 'success');
            renderWithdraw(root);
        } catch (err) {
            errEl.textContent = err.message;
            errEl.classList.remove('hide');
        } finally {
            setBusy(btn, false);
        }
    });
}

/* ================= REFERRALS ================= */
export async function renderReferrals(root) {
    const user = store.user || {};
    const username = user.username;
    root.innerHTML = `
        <div class="page-head"><div><h2>Referrals</h2>
        <p class="lede">Invite friends — when they activate a package, you earn the package's referral bonus straight into your affiliate balance.</p></div></div>
        <div class="skeleton skel-card" style="min-height:160px"></div>`;

    const [statsRes, boardRes] = await Promise.all([
        api(`/api/referral/stats/${encodeURIComponent(username)}`),
        api('/api/referral/leaderboard', { auth: false }).catch(() => ({ leaderboard: [] }))
    ]);

    const refCode = statsRes?.my_referral_id || user.my_referral_id || '';
    const refLink = `${location.origin}/#/register?ref=${encodeURIComponent(refCode)}`;

    root.innerHTML = `
        <div class="page-head"><div><h2>Referrals</h2>
        <p class="lede">Invite friends — when they activate a package, you earn the package's referral bonus straight into your affiliate balance.</p></div></div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-label">👥 Total referrals</div><div class="stat-value num">${fmtNum(statsRes.totalReferrals || 0)}</div></div>
            <div class="stat"><div class="stat-label">💰 Affiliate earnings</div><div class="stat-value money">${fmtNaira(statsRes.earnings || 0)}</div></div>
        </div>

        <div class="two-col">
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>Your referral code</h3></div>
                    <div class="stack-sm">
                        <div class="copy-field"><code>${esc(refCode || '—')}</code><button class="btn btn-sm btn-secondary" id="copy-code" type="button">Copy code</button></div>
                        <div class="copy-field"><code>${esc(refLink)}</code><button class="btn btn-sm btn-secondary" id="copy-link" type="button">Copy link</button></div>
                        <p class="small mb-0">Share the code or the full link — new members enter the code when they create their account.</p>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Your referrals</h3></div>
                    <div id="ref-list"></div>
                </div>
            </div>
            <div class="card">
                <div class="card-header"><h3>🏆 Leaderboard</h3></div>
                <div id="ref-board"></div>
            </div>
        </div>`;

    root.querySelector('#copy-code').addEventListener('click', () => copyToClipboard(refCode, 'Referral code copied'));
    root.querySelector('#copy-link').addEventListener('click', () => copyToClipboard(refLink, 'Referral link copied'));

    const refs = statsRes.referrals || [];
    root.querySelector('#ref-list').innerHTML = refs.length
        ? `<div class="row-list">${refs.map((r) => `
            <div class="row-item">
                <div class="row-main">
                    <div class="row-title">${esc(maskName(r.username))}</div>
                    <div class="row-sub">Joined ${esc(fmtDate(r.created_at, { withTime: false }))}</div>
                </div>
                ${badge(String(r.planActivated) === 'true' ? 'active' : 'pending')}
            </div>`).join('')}</div>`
        : `<div class="empty"><span class="empty-ico">🤝</span><p>No referrals yet — share your link to get started.</p></div>`;

    const board = boardRes.leaderboard || [];
    root.querySelector('#ref-board').innerHTML = board.length
        ? `<div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>Member</th><th>Activated refs</th><th class="num">Earned</th></tr></thead>
           <tbody>${board.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(maskName(b.username))}</td><td class="num">${fmtNum(b.referral_count || 0)}</td><td class="num money">${fmtNaira(b.total_earned || 0)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><span class="empty-ico">🏆</span><p>The leaderboard will fill up as members refer.</p></div>`;
}

/* ================= PROFILE ================= */
export async function renderProfile(root) {
    const user = store.user || {};
    root.innerHTML = `
        <div class="page-head"><div><h2>Profile &amp; settings</h2>
        <p class="lede">Keep your personal and bank details current so support and payouts reach you.</p></div></div>
        <div class="two-col">
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>Personal details</h3></div>
                    <form id="profile-form">
                        <div class="field"><label for="pf-username">Username / email</label>
                            <input class="input" id="pf-username" value="${esc(user.username || '')}" disabled /></div>
                        <div class="field"><label for="pf-name">Full name</label>
                            <input class="input" id="pf-name" name="full_name" autocomplete="name" value="${esc(user.full_name || '')}" placeholder="Your full name" required /></div>
                        <div class="field"><label for="pf-phone">Phone number</label>
                            <input class="input" id="pf-phone" name="phone" autocomplete="tel" inputmode="tel" value="${esc(user.phone || '')}" placeholder="e.g. 0803 000 0000" required /></div>
                        <button class="btn btn-primary" type="submit" id="pf-btn">Save profile</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Bank details</h3></div>
                    <form id="bank-form">
                        <div class="field"><label for="bk-name">Bank name</label>
                            <input class="input" id="bk-name" name="bank_name" value="${esc(user.bank_name || '')}" placeholder="e.g. Moniepoint" required /></div>
                        <div class="field"><label for="bk-acct">Account number</label>
                            <input class="input" id="bk-acct" name="account_number" inputmode="numeric" value="${esc(user.bank_account_number || '')}" placeholder="6–20 digits" required /></div>
                        <div class="field"><label for="bk-holder">Account holder</label>
                            <input class="input" id="bk-holder" name="account_holder" value="${esc(user.bank_account_holder || '')}" placeholder="Name on the account" required /></div>
                        <button class="btn btn-primary" type="submit" id="bk-btn">Save bank details</button>
                    </form>
                </div>
            </div>
            <div class="stack">
                <div class="card">
                    <div class="card-header"><h3>Security</h3></div>
                    <form id="pw-form">
                        <div class="field"><label for="pw-current">Current password</label>
                            <input class="input" id="pw-current" name="current_password" type="password" autocomplete="current-password" required /></div>
                        <div class="field"><label for="pw-new">New password</label>
                            <input class="input" id="pw-new" name="new_password" type="password" autocomplete="new-password" minlength="6" required /></div>
                        <button class="btn btn-secondary" type="submit" id="pw-btn">Change password</button>
                    </form>
                </div>
                <div class="card">
                    <div class="card-header"><h3>Account</h3></div>
                    <div class="pkg-rows">
                        <div class="row"><span>Referral code</span><span>${esc(user.my_referral_id || '—')}</span></div>
                        <div class="row"><span>Referred by</span><span>${esc(maskName(user.referred_by || '')) || '—'}</span></div>
                        <div class="row"><span>Account role</span><span>${esc(user.role || 'user')}</span></div>
                        <div class="row"><span>Status</span><span>${badge(user.status || 'active')}</span></div>
                    </div>
                    <hr class="divider" />
                    <button class="btn btn-danger btn-block" id="logout-btn" type="button">Log out</button>
                </div>
            </div>
        </div>`;

    const bindSave = (formId, btnId, path, mapFields, successMsg) => {
        const form = root.querySelector(formId);
        const btn = root.querySelector(btnId);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            setBusy(btn, true, 'Saving…');
            try {
                const body = mapFields(form);
                const data = await api(path, { method: 'POST', body });
                toast(data.message || successMsg, 'success');
                await refreshUser();
            } catch (err) { toast(err.message, 'error'); }
            finally { setBusy(btn, false); }
        });
    };

    bindSave('#profile-form', '#pf-btn', '/api/user/update-profile',
        (f) => ({ full_name: fieldValue(f, 'full_name').trim(), phone: fieldValue(f, 'phone').trim() }), 'Profile saved');
    bindSave('#bank-form', '#bk-btn', '/api/user/update-bank',
        (f) => ({ bank_name: fieldValue(f, 'bank_name').trim(), account_number: fieldValue(f, 'account_number').trim(), account_holder: fieldValue(f, 'account_holder').trim() }), 'Bank details saved');
    bindSave('#pw-form', '#pw-btn', '/api/user/change-password',
        (f) => ({ current_password: fieldValue(f, 'current_password'), new_password: fieldValue(f, 'new_password') }), 'Password changed');

    root.querySelector('#logout-btn').addEventListener('click', () => {
        confirmModal({
            title: 'Log out?',
            message: 'You will need your password to log back in.',
            confirmLabel: 'Log out',
            onConfirm: async () => {
                store.clear();
                location.hash = '#/login';
            }
        });
    });
}

/* ================= SUPPORT CHAT ================= */
export async function renderSupport(root) {
    const user = store.user || {};
    root.innerHTML = `
        <div class="page-head"><div><h2>Support chat</h2>
        <p class="lede">Chat directly with the Access Wealth support team. We usually reply within a few hours.</p></div></div>
        <div class="card card-pad-sm">
            <div class="chat-box">
                <div class="chat-scroll" id="chat-scroll"><div class="empty"><span class="spin dark"></span></div></div>
                <form class="chat-input-row" id="chat-form">
                    <input class="input" id="chat-input" placeholder="Type your message…" maxlength="5000" autocomplete="off" />
                    <button class="btn btn-primary" type="submit" id="chat-send">Send</button>
                </form>
            </div>
        </div>`;

    await api('/api/chat/welcome', { method: 'POST' }).catch(() => {});

    const scroll = root.querySelector('#chat-scroll');
    const load = async () => {
        try {
            const data = await api(`/api/chat/history/${encodeURIComponent(user.username)}`);
            const msgs = data.messages || [];
            const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 60;
            scroll.innerHTML = msgs.length ? msgs.map((m) => {
                const mine = String(m.sender).toLowerCase() === String(user.username).toLowerCase();
                return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}">${esc(m.message)}<span class="chat-meta">${mine ? 'You' : 'Support'} · ${esc(timeAgo(m.created_at || m.timestamp || ''))}</span></div>`;
            }).join('') : `<div class="empty"><span class="empty-ico">💬</span><p>No messages yet — say hello!</p></div>`;
            if (atBottom) scroll.scrollTop = scroll.scrollHeight;
        } catch (_) { /* keep last state on transient errors */ }
    };
    await load();
    scroll.scrollTop = scroll.scrollHeight;
    addTimer(setInterval(load, 12000));

    const form = root.querySelector('#chat-form');
    const input = root.querySelector('#chat-input');
    const btn = root.querySelector('#chat-send');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        setBusy(btn, true, '…');
        try {
            await api('/api/chat/send', { method: 'POST', body: { message } });
            input.value = '';
            await load();
            scroll.scrollTop = scroll.scrollHeight;
        } catch (err) { toast(err.message, 'error'); }
        finally { setBusy(btn, false); }
    });
}

/* ================= ANNOUNCEMENTS ================= */
export async function renderAnnouncements(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Announcements</h2>
        <p class="lede">Official updates from the Access Wealth team.</p></div></div>
        <div class="skeleton skel-card"></div>`;
    try {
        const data = await api('/api/broadcasts');
        const rows = data.broadcasts || [];
        root.innerHTML = `
            <div class="page-head"><div><h2>Announcements</h2>
            <p class="lede">Official updates from the Access Wealth team.</p></div></div>
            ${rows.length ? `<div class="stack">${rows.map((b) => `
                <div class="card">
                    <div class="card-header"><h3>${esc(b.title || 'Announcement')}</h3><span class="small muted">${esc(fmtDate(b.created_at))}</span></div>
                    <p class="mb-0" style="white-space:pre-wrap">${esc(b.message)}</p>
                </div>`).join('')}</div>`
            : emptyState('📣', 'No announcements yet', 'Official updates will appear here.')}`;
    } catch (err) {
        root.innerHTML = emptyState('⚠️', "Couldn't load announcements", err.message);
    }
}
