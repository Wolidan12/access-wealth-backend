// Access Wealth HQ — app shell & hash router.
// Same-origin with the API (served by Express), so all calls are relative.

import { api, setSessionExpiredHandler } from './api.js';
import { store } from './store.js';
import { esc, fmtNaira, toast, initials } from './ui.js';
import { resyncPushIfGranted } from './push.js';
import { renderLanding, renderLogin, renderRegister } from './views/auth.js';
import {
    renderDashboard, renderPlans, renderDeposit, renderWithdraw,
    renderReferrals, renderProfile, renderSupport, renderAnnouncements,
    clearUserTimers
} from './views/user.js';
import {
    renderAdminOverview, renderAdminUsers, renderAdminDeposits, renderAdminWithdrawals,
    renderAdminSettings, renderAdminBroadcast, renderAdminSupport, clearAdminTimers
} from './views/admin.js';

const appRoot = document.getElementById('app');

/* ---------------- NAV DEFINITIONS ---------------- */
const USER_NAV = [
    { hash: '#/dashboard', icon: '🏠', label: 'Home' },
    { hash: '#/plans', icon: '📦', label: 'Plans' },
    { hash: '#/deposit', icon: '💳', label: 'Deposit' },
    { hash: '#/withdraw', icon: '🏧', label: 'Withdraw' },
    { hash: '#/referrals', icon: '🤝', label: 'Referrals' },
    { hash: '#/announcements', icon: '📣', label: 'News' },
    { hash: '#/support', icon: '💬', label: 'Support' },
    { hash: '#/profile', icon: '👤', label: 'Profile' }
];

const ADMIN_NAV = [
    { hash: '#/admin', icon: '📊', label: 'Overview' },
    { hash: '#/admin/users', icon: '👥', label: 'Users' },
    { hash: '#/admin/deposits', icon: '🧾', label: 'Deposits' },
    { hash: '#/admin/withdrawals', icon: '🏧', label: 'Withdrawals' },
    { hash: '#/admin/support', icon: '💬', label: 'Support inbox' },
    { hash: '#/admin/broadcast', icon: '📣', label: 'Broadcast' },
    { hash: '#/admin/settings', icon: '⚙️', label: 'Settings' }
];

/* ---------------- ROUTES ---------------- */
const routes = [
    { pattern: /^#?\/?$/, view: 'landing', render: (root) => store.isAuthed ? go('#/dashboard') : renderLanding(root), public: true },
    { pattern: /^#\/?$/, view: 'landing2', render: (root) => store.isAuthed ? go('#/dashboard') : renderLanding(root), public: true },
    { pattern: /^#\/login$/, view: 'login', render: renderLogin, public: true },
    { pattern: /^#\/register(?:\?(.*))?$/, view: 'register', render: (root, m) => renderRegister(root, parseQuery(m[1])), public: true },

    { pattern: /^#\/dashboard$/, view: 'dashboard', render: renderDashboard },
    { pattern: /^#\/plans$/, view: 'plans', render: renderPlans },
    { pattern: /^#\/deposit$/, view: 'deposit', render: renderDeposit },
    { pattern: /^#\/withdraw$/, view: 'withdraw', render: renderWithdraw },
    { pattern: /^#\/referrals$/, view: 'referrals', render: renderReferrals },
    { pattern: /^#\/profile$/, view: 'profile', render: renderProfile },
    { pattern: /^#\/support$/, view: 'support', render: renderSupport },
    { pattern: /^#\/announcements$/, view: 'announcements', render: renderAnnouncements },

    { pattern: /^#\/admin$/, view: 'admin', render: renderAdminOverview, admin: true },
    { pattern: /^#\/admin\/users$/, view: 'admin-users', render: renderAdminUsers, admin: true },
    { pattern: /^#\/admin\/deposits$/, view: 'admin-deposits', render: renderAdminDeposits, admin: true },
    { pattern: /^#\/admin\/withdrawals$/, view: 'admin-withdrawals', render: renderAdminWithdrawals, admin: true },
    { pattern: /^#\/admin\/settings$/, view: 'admin-settings', render: renderAdminSettings, admin: true },
    { pattern: /^#\/admin\/broadcast$/, view: 'admin-broadcast', render: renderAdminBroadcast, admin: true },
    { pattern: /^#\/admin\/support$/, view: 'admin-support', render: renderAdminSupport, staff: true }
];

function parseQuery(qs) {
    const out = {};
    if (!qs) return out;
    for (const pair of qs.split('&')) {
        const [k, v] = pair.split('=');
        if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return out;
}

function go(hash) {
    if (location.hash === hash) { renderRoute(); } else { location.hash = hash; }
}

/* ---------------- SHELL RENDERING ---------------- */
function isAdminRoute(hash) { return hash.startsWith('#/admin'); }

function navItems() {
    if (!store.isAuthed) return [];
    if (isAdminRoute(location.hash) && store.isStaff) {
        return store.isAdmin ? ADMIN_NAV : ADMIN_NAV.filter((i) => i.hash === '#/admin/support' || i.hash === '#/admin');
    }
    return USER_NAV;
}

function activeNavHash() {
    const h = location.hash || '#/';
    if (h.startsWith('#/admin')) return h;
    return h;
}

function renderShell(contentHtml) {
    const user = store.user;
    const items = navItems();
    const active = activeNavHash();

    if (!store.isAuthed) {
        appRoot.innerHTML = contentHtml;
        return;
    }

    const sideLinks = items.map((i) => `
        <a class="nav-link ${active === i.hash ? 'active' : ''}" href="${i.hash}" ${active === i.hash ? 'aria-current="page"' : ''}>
            <span class="nav-ico" aria-hidden="true">${i.icon}</span> ${i.label}
        </a>`).join('');

    const bottomItems = (isAdminRoute(location.hash) && store.isStaff)
        ? [ADMIN_NAV[0], ADMIN_NAV[1], ADMIN_NAV[2], ADMIN_NAV[3], ADMIN_NAV[6]].filter(Boolean)
        : [USER_NAV[0], USER_NAV[1], USER_NAV[2], USER_NAV[7], USER_NAV[6]].filter(Boolean);

    const bottomLinks = bottomItems.map((i) => `
        <a href="${i.hash}" class="${active === i.hash ? 'active' : ''}" ${active === i.hash ? 'aria-current="page"' : ''}>
            <span class="nav-ico" aria-hidden="true">${i.icon}</span>${i.label}
        </a>`).join('');

    const adminSwitch = store.isStaff
        ? `<a class="nav-link" href="${isAdminRoute(location.hash) ? '#/dashboard' : '#/admin'}">
               <span class="nav-ico" aria-hidden="true">🔄</span> ${isAdminRoute(location.hash) ? 'Member view' : 'Admin panel'}
           </a>` : '';

    appRoot.innerHTML = `
    <div class="shell">
        <aside class="side-nav" aria-label="Main navigation">
            ${isAdminRoute(location.hash) && store.isStaff ? '<div class="nav-label">Administration</div>' : '<div class="nav-label">Menu</div>'}
            ${sideLinks}
            ${adminSwitch}
            <div style="flex:1"></div>
            <button class="nav-link" id="nav-logout"><span class="nav-ico" aria-hidden="true">🚪</span> Log out</button>
            <div class="small muted" style="padding:12px">Access Wealth HQ<br/>Member &amp; investment portal</div>
        </aside>
        <main class="shell-main" id="main" tabindex="-1">
            <div id="maintenance-slot"></div>
            ${contentHtml}
        </main>
    </div>
    <nav class="bottom-nav" aria-label="Mobile navigation">${bottomLinks}</nav>`;

    const logoutBtn = appRoot.querySelector('#nav-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            store.clear();
            toast('You have been logged out.', 'info');
            go('#/login');
        });
    }

    loadSiteFlags();
}

async function loadSiteFlags() {
    const slot = document.getElementById('maintenance-slot');
    if (!slot) return;
    try {
        const data = await api('/api/site-settings');
        const s = data.settings || {};
        slot.innerHTML = String(s.maintenance_mode || 'false').toLowerCase() === 'true'
            ? `<div class="maintenance-banner" role="status">🛠 Access Wealth is in maintenance mode. Some features may be temporarily unavailable.</div>`
            : '';
    } catch (_) { slot.innerHTML = ''; }
}

/* ---------------- TOPBAR (always visible) ---------------- */
function renderTopbar() {
    let topbar = document.querySelector('.topbar');
    if (!store.isAuthed) {
        if (topbar) topbar.remove();
        return;
    }
    const user = store.user || {};
    if (!topbar) {
        topbar = document.createElement('header');
        topbar.className = 'topbar';
        document.body.prepend(topbar);
    }
    topbar.innerHTML = `
        <a class="brand" href="${store.isStaff ? '#/admin' : '#/dashboard'}">
            <img src="/assets/logo.svg" alt="Access Wealth HQ logo" />
            <span class="brand-name">Access Wealth<small>HQ</small></span>
        </a>
        <span class="topbar-spacer"></span>
        ${user.wallet_balance !== undefined || user.balance !== undefined
            ? `<span class="badge" style="background:rgba(255,255,255,0.14);color:#fff;gap:6px">💼 <span class="money">${esc(fmtNaira(user.wallet_balance ?? user.balance ?? 0))}</span></span>`
            : ''}
        <button class="user-chip" id="user-chip" aria-label="Open profile">
            <span class="avatar" aria-hidden="true">${esc(initials(user.full_name || user.username))}</span>
            <span class="chip-name">${esc(user.full_name || user.username || 'Account')}</span>
        </button>`;
    topbar.querySelector('#user-chip').addEventListener('click', () => go('#/profile'));
}

store.onChange(() => {
    renderTopbar();
});

/* ---------------- ROUTER ---------------- */
async function renderRoute() {
    clearUserTimers();
    clearAdminTimers();

    const hash = location.hash || '#/';
    const route = routes.find((r) => r.pattern.test(hash));

    if (!route) { go(store.isAuthed ? '#/dashboard' : '#/'); return; }

    // Guards
    if (!route.public && !store.isAuthed) {
        sessionStorage.setItem('awhq.redirect', hash);
        go('#/login');
        return;
    }
    if (route.admin && !store.isAdmin) { go(store.isStaff && route.staff ? hash : '#/dashboard'); return; }
    if (route.staff && !store.isStaff) { go('#/dashboard'); return; }

    const match = hash.match(route.pattern);
    const viewHost = document.createElement('div');
    viewHost.id = 'view';

    if (route.public) {
        renderTopbar();
        appRoot.innerHTML = '';
        appRoot.appendChild(viewHost);
        await route.render(viewHost, match);
    } else {
        renderShell('');
        renderTopbar();
        const main = document.getElementById('main');
        main.appendChild(viewHost);
        try {
            await route.render(viewHost, match);
        } catch (err) {
            viewHost.innerHTML = `<div class="empty card"><span class="empty-ico">⚠️</span><h3>Something went wrong</h3><p>${esc(err?.message || 'Unexpected error')}</p><button class="btn btn-secondary" onclick="location.reload()">Reload</button></div>`;
        }
        main.focus({ preventScroll: true });
    }

    document.title = titleFor(hash);
    window.scrollTo(0, 0);
}

const TITLES = {
    '#/dashboard': 'Dashboard', '#/plans': 'Packages', '#/deposit': 'Fund wallet',
    '#/withdraw': 'Withdraw', '#/referrals': 'Referrals', '#/profile': 'Profile',
    '#/support': 'Support', '#/announcements': 'Announcements', '#/login': 'Log in',
    '#/register': 'Create account', '#/admin': 'Admin', '#/admin/users': 'Users · Admin',
    '#/admin/deposits': 'Deposits · Admin', '#/admin/withdrawals': 'Withdrawals · Admin',
    '#/admin/settings': 'Settings · Admin', '#/admin/broadcast': 'Broadcast · Admin',
    '#/admin/support': 'Support inbox · Admin'
};

function titleFor(hash) {
    const base = TITLES[hash];
    return base ? `${base} · Access Wealth HQ` : 'Access Wealth HQ';
}

/* ---------------- BOOT ---------------- */
async function boot() {
    setSessionExpiredHandler(() => {
        toast('Your session has expired. Please log in again.', 'info');
        go('#/login');
    });

    window.addEventListener('hashchange', renderRoute);

    // Restore session silently (per auth spec: don't force logout for old tokens).
    if (store.isAuthed) {
        try {
            const data = await api('/api/user/sync', { method: 'POST' });
            if (data.user) store.setUser(data.user);
            resyncPushIfGranted(); // re-register push subscription if previously allowed
        } catch (_) { /* api client already handles refresh/logout */ }
    }

    await renderRoute();

    // Register the PWA service worker (network-only; enables install prompt).
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
}

boot();
