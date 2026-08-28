// Admin & support screens: overview stats, user management, deposit and
// withdrawal review, site settings, broadcasts, and the support inbox.

import { api, apiFileUrl } from '../api.js';
import { store } from '../store.js';
import {
    esc, fmtNaira, fmtNum, fmtDate, timeAgo, maskName, badge,
    toast, openModal, confirmModal, setBusy, skeletonCards, emptyState, fieldValue
} from '../ui.js';

let timers = [];
function addTimer(id) { timers.push(id); }
export function clearAdminTimers() { timers.forEach((t) => clearInterval(t)); timers = []; }

/* -------------------- OVERVIEW -------------------- */
export async function renderAdminOverview(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Admin overview</h2>
        <p class="lede">Platform health at a glance.</p></div></div>
        ${skeletonCards(5)}`;
    try {
        const { stats } = await api('/api/admin/stats');
        root.innerHTML = `
            <div class="page-head"><div><h2>Admin overview</h2>
            <p class="lede">Platform health at a glance.</p></div></div>
            <div class="stat-grid">
                <div class="stat"><div class="stat-label">👥 Total users</div><div class="stat-value num">${fmtNum(stats.totalUsers)}</div></div>
                <div class="stat"><div class="stat-label">📦 Active plans</div><div class="stat-value num">${fmtNum(stats.activePlans)}</div></div>
                <div class="stat"><div class="stat-label">💰 Approved deposits</div><div class="stat-value money">${fmtNaira(stats.revenue)}</div></div>
                <div class="stat"><div class="stat-label">🧾 Pending deposits</div><div class="stat-value num">${fmtNum(stats.pendingDeposits)}</div><div class="stat-sub"><a href="#/admin/deposits">Review now →</a></div></div>
                <div class="stat"><div class="stat-label">🏧 Pending withdrawals</div><div class="stat-value num">${fmtNum(stats.pendingWithdrawals)}</div><div class="stat-sub"><a href="#/admin/withdrawals">Review now →</a></div></div>
            </div>
            <div class="quick-actions mt-4">
                <a class="quick-action" href="#/admin/users"><span class="qa-ico">👥</span>Users</a>
                <a class="quick-action" href="#/admin/deposits"><span class="qa-ico">🧾</span>Deposits</a>
                <a class="quick-action" href="#/admin/withdrawals"><span class="qa-ico">🏧</span>Withdrawals</a>
                <a class="quick-action" href="#/admin/broadcast"><span class="qa-ico">📣</span>Broadcast</a>
                <a class="quick-action" href="#/admin/support"><span class="qa-ico">💬</span>Support inbox</a>
                <a class="quick-action" href="#/admin/settings"><span class="qa-ico">⚙️</span>Settings</a>
            </div>`;
    } catch (err) {
        root.innerHTML = emptyState('⚠️', "Couldn't load admin stats", err.message);
    }
}

/* -------------------- USERS -------------------- */
export async function renderAdminUsers(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>User management</h2>
        <p class="lede">Search members, change plans, adjust balances, or suspend accounts.</p></div></div>
        <div class="skeleton skel-card" style="min-height:200px"></div>`;

    let users, packages;
    try {
        const [usersRes, pkgsRes] = await Promise.all([
            api('/api/admin/users'),
            api('/api/packages')
        ]);
        users = usersRes.users || [];
        packages = pkgsRes.packages || [];
    } catch (err) {
        root.innerHTML = emptyState('⚠️', "Couldn't load users", err.message);
        return;
    }

    root.innerHTML = `
        <div class="page-head">
            <div><h2>User management</h2><p class="lede">Search members, change plans, adjust balances, or suspend accounts.</p></div>
            <input class="input" id="user-search" type="search" placeholder="Search username…" style="max-width:280px" aria-label="Search users" />
        </div>
        <div class="table-wrap">
            <table class="data" id="users-table">
                <thead><tr>
                    <th>User</th><th class="num">Wallet</th><th class="num">Task</th><th class="num">Affiliate</th>
                    <th>Plan</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th>
                </tr></thead>
                <tbody></tbody>
            </table>
        </div>
        <p class="small muted mt-4" id="users-count"></p>`;

    const tbody = root.querySelector('#users-table tbody');
    const countEl = root.querySelector('#users-count');

    const draw = (filter = '') => {
        const f = filter.trim().toLowerCase();
        const rows = f ? users.filter((u) => String(u.username).toLowerCase().includes(f)) : users;
        countEl.textContent = `${rows.length} of ${users.length} users`;
        tbody.innerHTML = rows.map((u) => `
            <tr>
                <td><strong>${esc(u.username)}</strong></td>
                <td class="num money">${fmtNaira(u.wallet_balance ?? u.balance ?? 0)}</td>
                <td class="num money">${fmtNaira(u.taskEarnings ?? 0)}</td>
                <td class="num money">${fmtNaira(u.affiliate_balance ?? 0)}</td>
                <td>${u.activePackage && u.activePackage !== 'None' ? esc(u.activePackage) : '<span class="muted">None</span>'}</td>
                <td>${u.role === 'admin' ? '<span class="badge badge-info">Admin</span>' : u.role === 'support' ? '<span class="badge badge-info">Support</span>' : '<span class="muted">User</span>'}</td>
                <td>${badge(u.status || 'active')}</td>
                <td class="small">${esc(fmtDate(u.created_at, { withTime: false }))}</td>
                <td>${u.role === 'admin' ? '<span class="muted small">—</span>' : `
                    <div class="row-actions">
                        <button class="btn btn-sm btn-secondary" data-plan="${esc(u.username)}">Change plan</button>
                        <button class="btn btn-sm btn-secondary" data-adjust="${esc(u.username)}">Adjust</button>
                        <button class="btn btn-sm ${String(u.status) === 'banned' ? 'btn-primary' : 'btn-danger'}" data-toggle="${esc(u.username)}" data-status="${esc(u.status)}">
                            ${String(u.status) === 'banned' ? 'Reactivate' : 'Suspend'}
                        </button>
                    </div>`}
                </td>
            </tr>`).join('') || `<tr><td colspan="9" class="center muted">No users match “${esc(filter)}”.</td></tr>`;
    };

    draw();
    root.querySelector('#user-search').addEventListener('input', (e) => draw(e.target.value));

    const refreshUsers = async () => {
        const fresh = await api('/api/admin/users');
        users = fresh.users || [];
        draw(root.querySelector('#user-search').value);
    };

    tbody.addEventListener('click', async (e) => {
        const planBtn = e.target.closest('[data-plan]');
        const adjustBtn = e.target.closest('[data-adjust]');
        const toggleBtn = e.target.closest('[data-toggle]');

        if (planBtn) {
            const username = planBtn.dataset.plan;
            const u = users.find((x) => x.username === username);
            const opts = packages.map((p) => `<option value="${esc(p.id)}" ${u?.activePackageId === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(fmtNaira(p.capital))}</option>`).join('');
            openModal({
                title: `Change plan — ${username}`,
                body: `
                    <p class="mt-0">Current plan: <strong>${esc(u?.activePackage || 'None')}</strong></p>
                    <div class="field"><label for="cp-select">New package</label>
                        <select class="select" id="cp-select">${opts}</select></div>
                    <div class="notice notice-warning"><span class="notice-ico">⚠️</span><p>This changes the user's active package immediately. <strong>No wallet balance is charged or refunded.</strong> Use as an override/correction tool.</p></div>`,
                actions: [
                    { label: 'Cancel', className: 'btn-secondary', onClick: null },
                    {
                        label: 'Change plan', className: 'btn-primary',
                        onClick: async () => {
                            const sel = document.getElementById('cp-select');
                            const data = await api('/api/admin/change-user-plan', {
                                method: 'POST',
                                body: { username, packageId: sel.value }
                            });
                            toast(data.message || 'Plan changed.', 'success');
                            await refreshUsers();
                        }
                    }
                ]
            });
        }

        if (adjustBtn) {
            const username = adjustBtn.dataset.adjust;
            openModal({
                title: `Adjust balance — ${username}`,
                body: `
                    <div class="field"><label for="adj-wallet">Wallet</label>
                        <select class="select" id="adj-wallet">
                            <option value="balance">Wallet balance</option>
                            <option value="taskEarnings">Task earnings</option>
                            <option value="daily_earnings">Daily earnings</option>
                            <option value="affiliate_balance">Affiliate balance</option>
                        </select></div>
                    <div class="field"><label for="adj-action">Action</label>
                        <select class="select" id="adj-action">
                            <option value="add">Add (credit)</option>
                            <option value="subtract">Subtract (debit)</option>
                        </select></div>
                    <div class="field"><label for="adj-amount">Amount (₦)</label>
                        <input class="input" id="adj-amount" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. 5000" /></div>
                    <div class="notice"><span class="notice-ico">ℹ️</span><p>Every adjustment is recorded in the admin activity log.</p></div>`,
                actions: [
                    { label: 'Cancel', className: 'btn-secondary', onClick: null },
                    {
                        label: 'Apply adjustment', className: 'btn-primary',
                        onClick: async () => {
                            const amount = Number(document.getElementById('adj-amount').value);
                            if (!Number.isFinite(amount) || amount <= 0) {
                                toast('Enter a valid amount greater than zero.', 'error');
                                return true;
                            }
                            const data = await api('/api/admin/adjust-balance', {
                                method: 'POST',
                                body: {
                                    username,
                                    walletType: document.getElementById('adj-wallet').value,
                                    action: document.getElementById('adj-action').value,
                                    amount
                                }
                            });
                            toast(data.message || 'Balance adjusted.', 'success');
                            await refreshUsers();
                        }
                    }
                ]
            });
        }

        if (toggleBtn) {
            const username = toggleBtn.dataset.toggle;
            const isBanned = toggleBtn.dataset.status === 'banned';
            confirmModal({
                title: isBanned ? `Reactivate ${username}?` : `Suspend ${username}?`,
                message: isBanned
                    ? 'The member will be able to log in and use their account again.'
                    : 'The member will not be able to log in until reactivated. Their balances are untouched.',
                confirmLabel: isBanned ? 'Reactivate' : 'Suspend',
                danger: !isBanned,
                onConfirm: async () => {
                    const data = await api('/api/admin/toggle-user-status', {
                        method: 'POST',
                        body: { username, status: isBanned ? 'active' : 'banned' }
                    });
                    toast(data.message || 'Status updated.', 'success');
                    await refreshUsers();
                }
            });
        }
    });
}

/* -------------------- DEPOSITS -------------------- */
export async function renderAdminDeposits(root) {
    let status = 'pending';
    root.innerHTML = `
        <div class="page-head"><div><h2>Deposit review</h2>
        <p class="lede">Verify receipts and credit wallets. Approving credits the member's wallet balance immediately.</p></div></div>
        <div class="tabs" role="tablist">
            ${['pending', 'approved', 'declined', 'all'].map((s) => `<button class="tab ${s === status ? 'active' : ''}" role="tab" data-status="${s}" aria-selected="${s === status}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
        <div id="dep-admin-list"><div class="skeleton skel-card"></div></div>`;

    const listEl = root.querySelector('#dep-admin-list');

    const load = async () => {
        listEl.innerHTML = `<div class="skeleton skel-card"></div>`;
        try {
            const data = await api(`/api/admin/deposits?status=${status}`);
            const rows = data.deposits || [];
            if (!rows.length) {
                listEl.innerHTML = emptyState('🧾', `No ${status === 'all' ? '' : status + ' '}deposits`, 'New deposit requests will appear here.');
                return;
            }
            listEl.innerHTML = `<div class="row-list">${rows.map((d) => `
                <div class="row-item">
                    <div class="row-main">
                        <div class="row-title">${esc(d.username)} · <span class="money">${fmtNaira(d.amount)}</span></div>
                        <div class="row-sub">From ${esc(d.sender_name || '—')} · ${esc(fmtDate(d.created_at))}${d.transaction_ref ? ` · Ref: ${esc(d.transaction_ref)}` : ''}${d.admin_note ? ` · Note: ${esc(d.admin_note)}` : ''}</div>
                    </div>
                    ${badge(d.status)}
                    <div class="row-actions">
                        ${d.has_receipt ? `<button class="btn btn-sm btn-secondary" data-receipt="${d.id}">View receipt</button>` : ''}
                        ${d.status === 'pending' ? `
                            <button class="btn btn-sm btn-primary" data-approve="${d.id}">Approve</button>
                            <button class="btn btn-sm btn-danger" data-decline="${d.id}">Decline</button>` : ''}
                    </div>
                </div>`).join('')}</div>`;
        } catch (err) {
            listEl.innerHTML = emptyState('⚠️', "Couldn't load deposits", err.message);
        }
    };

    await load();

    root.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            status = tab.dataset.status;
            root.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
            load();
        });
    });

    listEl.addEventListener('click', async (e) => {
        const recBtn = e.target.closest('[data-receipt]');
        const approveBtn = e.target.closest('[data-approve]');
        const declineBtn = e.target.closest('[data-decline]');

        if (recBtn) {
            const id = recBtn.dataset.receipt;
            const body = document.createElement('div');
            body.innerHTML = `<div class="center"><span class="spin dark"></span></div>`;
            openModal({ title: `Receipt — deposit #${id}`, body, wide: true });
            try {
                const url = await apiFileUrl(`/api/admin/deposit/${id}/receipt`);
                body.innerHTML = `<img class="receipt-img" src="${url}" alt="Deposit receipt #${esc(id)}" />`;
            } catch (err) {
                body.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
            }
        }

        if (approveBtn) {
            const id = approveBtn.dataset.approve;
            confirmModal({
                title: `Approve deposit #${id}?`,
                message: 'The member\'s wallet will be credited immediately with the deposit amount.',
                confirmLabel: 'Approve & credit',
                onConfirm: async () => {
                    const data = await api('/api/admin/approve-deposit', { method: 'POST', body: { depositId: Number(id) } });
                    toast(data.message || 'Deposit approved.', 'success');
                    await load();
                }
            });
        }

        if (declineBtn) {
            const id = declineBtn.dataset.decline;
            openModal({
                title: `Decline deposit #${id}?`,
                body: `
                    <p class="mt-0">The member will see your note as the reason. No balance is credited.</p>
                    <div class="field"><label for="dec-note">Reason (optional)</label>
                        <textarea class="textarea" id="dec-note" placeholder="e.g. Receipt is unreadable — please resubmit a clearer photo."></textarea></div>`,
                actions: [
                    { label: 'Cancel', className: 'btn-secondary', onClick: null },
                    {
                        label: 'Decline deposit', className: 'btn-danger',
                        onClick: async () => {
                            const note = document.getElementById('dec-note').value.trim();
                            const data = await api('/api/admin/decline-deposit', { method: 'POST', body: { depositId: Number(id), note: note || undefined } });
                            toast(data.message || 'Deposit declined.', 'success');
                            await load();
                        }
                    }
                ]
            });
        }
    });
}

/* -------------------- WITHDRAWALS -------------------- */
export async function renderAdminWithdrawals(root) {
    let status = 'pending';
    root.innerHTML = `
        <div class="page-head"><div><h2>Withdrawal review</h2>
        <p class="lede">Approve payouts (moves them to processing) or decline to refund the member's wallet.</p></div></div>
        <div class="tabs" role="tablist">
            ${['pending', 'processing', 'completed', 'declined', 'all'].map((s) => `<button class="tab ${s === status ? 'active' : ''}" role="tab" data-status="${s}" aria-selected="${s === status}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
        <div id="wd-admin-list"><div class="skeleton skel-card"></div></div>`;

    const listEl = root.querySelector('#wd-admin-list');

    const load = async () => {
        listEl.innerHTML = `<div class="skeleton skel-card"></div>`;
        try {
            const data = await api(`/api/admin/withdrawals?status=${status}`);
            const rows = data.withdrawals || data.rows || [];
            if (!rows.length) {
                listEl.innerHTML = emptyState('🏧', `No ${status === 'all' ? '' : status + ' '}withdrawals`, 'New withdrawal requests will appear here.');
                return;
            }
            listEl.innerHTML = `<div class="row-list">${rows.map((w) => {
                let bank = {};
                try { bank = typeof w.bank_details === 'string' ? JSON.parse(w.bank_details || '{}') : (w.bank_details || {}); } catch (_) {}
                return `
                <div class="row-item">
                    <div class="row-main">
                        <div class="row-title">${esc(w.username)} · <span class="money">${fmtNaira(w.amount)}</span> <span class="small muted">(${esc(w.wallet_type || 'balance')})</span></div>
                        <div class="row-sub">${esc(bank.bank_name || '—')} · ${esc(bank.account_number || '—')} · ${esc(bank.account_holder || '—')} · ${esc(fmtDate(w.created_at))}${w.admin_note ? ` · ${esc(w.admin_note)}` : ''}</div>
                    </div>
                    ${badge(w.status)}
                    <div class="row-actions">
                        ${w.status === 'pending' ? `
                            <button class="btn btn-sm btn-primary" data-approve="${w.id}">Approve</button>
                            <button class="btn btn-sm btn-danger" data-decline="${w.id}">Decline & refund</button>` : ''}
                        ${w.status === 'processing' ? `
                            <button class="btn btn-sm btn-primary" data-complete="${w.id}">✔ Mark as paid</button>` : ''}
                    </div>
                </div>`;
            }).join('')}</div>`;
        } catch (err) {
            listEl.innerHTML = emptyState('⚠️', "Couldn't load withdrawals", err.message);
        }
    };

    await load();

    root.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            status = tab.dataset.status;
            root.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
            load();
        });
    });

    listEl.addEventListener('click', async (e) => {
        const approveBtn = e.target.closest('[data-approve]');
        const declineBtn = e.target.closest('[data-decline]');
        const completeBtn = e.target.closest('[data-complete]');

        if (approveBtn) {
            const id = approveBtn.dataset.approve;
            confirmModal({
                title: `Approve withdrawal #${id}?`,
                message: 'Status moves to "Processing" — pay the member from the business account, and the record stays in the processing tab.',
                confirmLabel: 'Approve for processing',
                onConfirm: async () => {
                    const data = await api('/api/admin/approve-withdrawal', { method: 'POST', body: { id: Number(id) } });
                    toast(data.message || 'Withdrawal approved.', 'success');
                    await load();
                }
            });
        }

        if (declineBtn) {
            const id = declineBtn.dataset.decline;
            openModal({
                title: `Decline withdrawal #${id}?`,
                body: `
                    <p class="mt-0">The amount is instantly refunded to the member's wallet they withdrew from.</p>
                    <div class="field"><label for="wd-dec-note">Reason (optional)</label>
                        <textarea class="textarea" id="wd-dec-note" placeholder="e.g. Account name does not match your profile."></textarea></div>`,
                actions: [
                    { label: 'Cancel', className: 'btn-secondary', onClick: null },
                    {
                        label: 'Decline & refund', className: 'btn-danger',
                        onClick: async () => {
                            const note = document.getElementById('wd-dec-note').value.trim();
                            const data = await api('/api/admin/decline-withdrawal', { method: 'POST', body: { id: Number(id), note: note || undefined } });
                            toast(data.message || 'Withdrawal declined & refunded.', 'success');
                            await load();
                        }
                    }
                ]
            });
        }

        if (completeBtn) {
            const id = completeBtn.dataset.complete;
            confirmModal({
                title: `Mark withdrawal #${id} as paid?`,
                message: 'Only do this after the bank transfer to the member has been completed. The member gets a "Withdrawal paid" push and email immediately.',
                confirmLabel: 'Mark as paid',
                onConfirm: async () => {
                    const data = await api('/api/admin/complete-withdrawal', { method: 'POST', body: { id: Number(id) } });
                    toast(data.message || 'Withdrawal marked as paid.', 'success');
                    await load();
                }
            });
        }
    });
}

/* -------------------- SETTINGS -------------------- */
export async function renderAdminSettings(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Site settings</h2>
        <p class="lede">Feature switches for the whole platform. Changes apply immediately to every user.</p></div></div>
        <div class="skeleton skel-card"></div>`;

    let settings;
    try {
        const data = await api('/api/site-settings');
        settings = data.settings || {};
    } catch (err) {
        root.innerHTML = emptyState('⚠️', "Couldn't load settings", err.message);
        return;
    }

    const defs = [
        ['maintenance_mode', 'Maintenance mode', 'Show a maintenance notice across the app.'],
        ['registrations_open', 'Registrations open', 'Allow new members to create accounts.'],
        ['deposits_open', 'Deposits open', 'Allow members to submit deposits.'],
        ['withdrawals_open', 'Withdrawals open', 'Allow members to request withdrawals.'],
        ['sponsored_posts_open', 'Sponsored posts open', 'Allow sponsored-task submissions.']
    ];

    root.innerHTML = `
        <div class="page-head"><div><h2>Site settings</h2>
        <p class="lede">Feature switches for the whole platform. Changes apply immediately to every user.</p></div></div>
        <div class="card">
            <div class="stack-sm" id="settings-list">
                ${defs.map(([key, label, hint]) => {
                    const on = String(settings[key] ?? 'true').toLowerCase() === 'true';
                    return `
                    <div class="row-item" style="box-shadow:none">
                        <div class="row-main"><div class="row-title">${esc(label)}</div><div class="row-sub">${esc(hint)}</div></div>
                        <label class="switch">
                            <input type="checkbox" data-setting="${key}" ${on ? 'checked' : ''} aria-label="${esc(label)}" />
                            <span class="track"></span>
                            <span class="switch-label" data-state>${on ? 'On' : 'Off'}</span>
                        </label>
                    </div>`;
                }).join('')}
            </div>
        </div>`;

    root.querySelectorAll('[data-setting]').forEach((input) => {
        input.addEventListener('change', async () => {
            const key = input.dataset.setting;
            const value = input.checked ? 'true' : 'false';
            const labelEl = input.closest('.switch').querySelector('[data-state]');
            input.disabled = true;
            try {
                const data = await api('/api/admin/settings', { method: 'POST', body: { [key]: value } });
                toast(`${labelEl.previousSibling ? '' : ''}${data.message || 'Setting updated'}`, 'success');
                labelEl.textContent = input.checked ? 'On' : 'Off';
            } catch (err) {
                input.checked = !input.checked;
                toast(err.message, 'error');
            } finally {
                input.disabled = false;
            }
        });
    });
}

/* -------------------- BROADCAST -------------------- */
export async function renderAdminBroadcast(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Broadcast announcements</h2>
        <p class="lede">Send an official notice to every member's announcements feed.</p></div></div>
        <div class="two-col">
            <div class="card">
                <div class="card-header"><h3>New broadcast</h3></div>
                <form id="bc-form">
                    <div class="field"><label for="bc-title">Title</label>
                        <input class="input" id="bc-title" name="title" maxlength="200" placeholder="e.g. Weekend payout schedule" /></div>
                    <div class="field"><label for="bc-message">Message</label>
                        <textarea class="textarea" id="bc-message" name="message" maxlength="5000" required placeholder="Write in plain language. Members will see this exactly as written."></textarea></div>
                    <button class="btn btn-primary" type="submit" id="bc-btn">Send to all members</button>
                </form>
            </div>
            <div class="card">
                <div class="card-header"><h3>Recent broadcasts</h3></div>
                <div id="bc-history"><div class="skeleton skel-card" style="min-height:80px"></div></div>
            </div>
        </div>`;

    const loadHistory = async () => {
        try {
            const data = await api('/api/broadcasts/all');
            const rows = data.broadcasts || [];
            root.querySelector('#bc-history').innerHTML = rows.length
                ? `<div class="stack-sm">${rows.slice(0, 10).map((b) => `
                    <div><strong>${esc(b.title || 'Announcement')}</strong>
                    <div class="small">${esc(b.message)}</div>
                    <div class="small muted">${esc(timeAgo(b.created_at))} · by ${esc(maskName(b.created_by || 'admin'))}</div></div>`).join('<hr class="divider" />')}</div>`
                : `<div class="empty"><span class="empty-ico">📣</span><p>No broadcasts yet.</p></div>`;
        } catch (err) {
            root.querySelector('#bc-history').innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
        }
    };
    await loadHistory();

    const form = root.querySelector('#bc-form');
    const btn = root.querySelector('#bc-btn');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = fieldValue(form, 'message').trim();
        if (!message) { toast('Write a message first.', 'error'); return; }
        setBusy(btn, true, 'Sending…');
        try {
            const data = await api('/api/admin/broadcast', { method: 'POST', body: { title: fieldValue(form, 'title').trim(), message } });
            toast(data.message || 'Broadcast sent.', 'success');
            form.reset();
            await loadHistory();
        } catch (err) { toast(err.message, 'error'); }
        finally { setBusy(btn, false); }
    });
}

/* -------------------- SUPPORT INBOX -------------------- */
export async function renderAdminSupport(root) {
    root.innerHTML = `
        <div class="page-head"><div><h2>Support inbox</h2>
        <p class="lede">Pick a member to open their conversation. Replies appear in their Support chat instantly.</p></div></div>
        <div class="two-col">
            <div class="card card-pad-sm"><div id="inbox-list"><div class="skeleton skel-card"></div></div></div>
            <div class="card card-pad-sm"><div id="inbox-chat"><div class="empty"><span class="empty-ico">💬</span><p>Select a conversation.</p></div></div></div>
        </div>`;

    const listEl = root.querySelector('#inbox-list');
    const chatEl = root.querySelector('#inbox-chat');
    let activeUser = null;

    let convos = [];
    try {
        const data = await api('/api/support/users');
        convos = (data.users || []).map((u) => u.user_id).filter(Boolean);
    } catch (err) {
        listEl.innerHTML = emptyState('⚠️', "Couldn't load inbox", err.message);
        return;
    }

    const drawList = () => {
        listEl.innerHTML = convos.length
            ? `<div class="stack-sm">${convos.map((u) => `
                <button class="nav-link ${u === activeUser ? 'active' : ''}" data-convo="${esc(u)}">
                    <span class="nav-ico">👤</span> ${esc(u)}
                </button>`).join('')}</div>`
            : `<div class="empty"><span class="empty-ico">💬</span><p>No conversations yet. Members' chats will appear here.</p></div>`;
    };
    drawList();

    const openConvo = async (username) => {
        activeUser = username;
        drawList();
        chatEl.innerHTML = `
            <div class="chat-box">
                <div class="chat-scroll" id="adm-chat-scroll"></div>
                <form class="chat-input-row" id="adm-chat-form">
                    <input class="input" id="adm-chat-input" placeholder="Reply as support…" maxlength="5000" autocomplete="off" />
                    <button class="btn btn-primary" type="submit">Send</button>
                </form>
            </div>`;

        const scroll = chatEl.querySelector('#adm-chat-scroll');
        const load = async () => {
            try {
                const data = await api(`/api/chat/history/${encodeURIComponent(username)}`);
                const msgs = data.messages || [];
                scroll.innerHTML = msgs.map((m) => {
                    const theirs = String(m.sender).toLowerCase() === username.toLowerCase();
                    return `<div class="chat-msg ${theirs ? 'theirs' : 'mine'}">${esc(m.message)}<span class="chat-meta">${theirs ? esc(username) : 'You (support)'} · ${esc(timeAgo(m.created_at || ''))}</span></div>`;
                }).join('') || `<div class="empty"><span class="empty-ico">💬</span><p>No messages.</p></div>`;
                scroll.scrollTop = scroll.scrollHeight;
            } catch (err) { /* keep last render */ }
        };
        await load();

        if (activeUser) {
            addTimer(setInterval(() => { if (activeUser === username) load(); }, 10000));
        }

        const form = chatEl.querySelector('#adm-chat-form');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = chatEl.querySelector('#adm-chat-input');
            const message = input.value.trim();
            if (!message) return;
            try {
                await api('/api/chat/send', { method: 'POST', body: { user_id: username, message } });
                input.value = '';
                await load();
            } catch (err) { toast(err.message, 'error'); }
        });
    };

    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-convo]');
        if (btn) openConvo(btn.dataset.convo);
    });

    if (convos.length) openConvo(convos[0]);
}
