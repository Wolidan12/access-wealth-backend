// Shared UI primitives: formatting, escaping, toasts, modals, badges,
// skeletons and small render helpers used across every screen.

export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const nairaFmt = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0
});

export function fmtNaira(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '₦0';
    return nairaFmt.format(n);
}

export function fmtNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('en-NG').format(n);
}

export function fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0%';
    return `${parseFloat((n * 100).toFixed(2))}%`;
}

export function fmtDate(value, { withTime = true } = {}) {
    if (!value) return '—';
    const raw = String(value).trim();
    const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.length <= 10 ? 'T00:00:00' : ''));
    if (Number.isNaN(d.getTime())) return esc(raw);
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString('en-NG', opts);
}

export function timeAgo(value) {
    if (!value) return '';
    const raw = String(value).trim();
    const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return d.toLocaleDateString('en-NG', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function maskName(username) {
    const s = String(username || '');
    const at = s.indexOf('@');
    if (at > 1) {
        const head = s.slice(0, Math.min(3, at));
        return `${head}•••@${s.slice(at + 1)}`;
    }
    if (s.length <= 4) return s[0] + '•••';
    return `${s.slice(0, 3)}•••${s.slice(-2)}`;
}

export function badge(status) {
    const map = {
        pending: ['pending', 'Awaiting review'],
        processing: ['processing', 'Processing'],
        approved: ['approved', 'Approved'],
        completed: ['completed', 'Completed'],
        declined: ['declined', 'Declined'],
        active: ['active', 'Active'],
        banned: ['banned', 'Suspended'],
        true: ['active', 'Active'],
        false: ['muted', 'Not active']
    };
    const key = String(status ?? '').toLowerCase();
    const [cls, label] = map[key] || ['info', status || 'Unknown'];
    return `<span class="badge badge-${cls}">${esc(label)}</span>`;
}

export function tierBadge(tier) {
    const t = String(tier || '').toLowerCase();
    const cls = ['starter', 'growth', 'wealth', 'elite'].includes(t) ? `tier-${t}` : 'badge-info';
    return `<span class="badge ${cls.replace('badge-', 'badge ')}" style="gap:0">${esc(tier || 'Plan')}</span>`;
}

/* ---------- Toasts ---------- */
export function toast(message, type = 'info', timeoutMs = 4200) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span>${esc(message)}</span><button class="toast-close" aria-label="Dismiss notification">×</button>`;
    const close = () => { el.remove(); };
    el.querySelector('.toast-close').addEventListener('click', close);
    root.appendChild(el);
    if (timeoutMs) setTimeout(close, timeoutMs);
}

/* ---------- Modals ---------- */
let modalStack = [];

export function openModal({ title, body, actions = [], onClose, wide = false }) {
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const bodyHtml = typeof body === 'string' ? body : '';
    backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="max-width:720px"' : ''}>
            <button class="modal-x" aria-label="Close dialog">×</button>
            <h3 class="modal-title">${esc(title)}</h3>
            <div class="modal-body"></div>
            <div class="modal-actions flex mt-4" style="justify-content:flex-end"></div>
        </div>`;

    const bodyEl = backdrop.querySelector('.modal-body');
    if (body instanceof Node) bodyEl.appendChild(body); else bodyEl.innerHTML = bodyHtml;

    const actionsEl = backdrop.querySelector('.modal-actions');
    actions.forEach((action) => {
        const btn = document.createElement('button');
        btn.className = `btn ${action.className || 'btn-secondary'}`;
        btn.innerHTML = action.label;
        btn.addEventListener('click', async () => {
            if (!action.onClick) return closeModal(backdrop);
            btn.disabled = true;
            btn.dataset.original = btn.innerHTML;
            btn.innerHTML = `<span class="spin"></span>&nbsp;Working…`;
            try {
                const keepOpen = await action.onClick();
                if (!keepOpen) closeModal(backdrop);
            } catch (err) {
                toast(err.message || 'Action failed', 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = btn.dataset.original;
            }
        });
        actionsEl.appendChild(btn);
    });
    if (!actions.length) actionsEl.remove();

    backdrop.querySelector('.modal-x').addEventListener('click', () => closeModal(backdrop));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });

    const onKey = (e) => { if (e.key === 'Escape') closeModal(backdrop); };
    document.addEventListener('keydown', onKey);
    backdrop._onKey = onKey;

    root.appendChild(backdrop);
    modalStack.push(backdrop);
    const firstInput = backdrop.querySelector('input, select, textarea, button:not(.modal-x):not(.modal-actions .btn)');
    (firstInput || backdrop.querySelector('.modal-x')).focus();
    return backdrop;
}

export function closeModal(backdrop) {
    const target = backdrop || modalStack[modalStack.length - 1];
    if (!target) return;
    if (target._onKey) document.removeEventListener('keydown', target._onKey);
    target.remove();
    modalStack = modalStack.filter((m) => m !== target);
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
    openModal({
        title,
        body: `<p class="mt-0">${message}</p>`,
        actions: [
            { label: 'Cancel', className: 'btn-secondary', onClick: null },
            { label: esc(confirmLabel), className: danger ? 'btn-danger' : 'btn-primary', onClick: onConfirm }
        ]
    });
}

/* ---------- Buttons/loading helpers ---------- */
export function setBusy(btn, busy, busyLabel = 'Working…') {
    if (!btn) return;
    if (busy) {
        btn.dataset.original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="spin"></span>&nbsp;${esc(busyLabel)}`;
    } else {
        btn.disabled = false;
        if (btn.dataset.original) btn.innerHTML = btn.dataset.original;
    }
}

export function skeletonCards(n = 3) {
    return `<div class="stat-grid">${Array.from({ length: n }).map(() => '<div class="skeleton skel-card"></div>').join('')}</div>`;
}

export function emptyState(icon, title, hint = '', ctaHtml = '') {
    return `<div class="empty card"><span class="empty-ico" aria-hidden="true">${icon}</span><h3>${esc(title)}</h3><p>${esc(hint)}</p>${ctaHtml}</div>`;
}

export function errorState(err, retryFnName = '') {
    return `<div class="empty card">
        <span class="empty-ico" aria-hidden="true">⚠️</span>
        <h3>We couldn't load this</h3>
        <p>${esc(err?.message || 'Unexpected error')}</p>
        ${retryFnName ? `<button class="btn btn-secondary" onclick="${retryFnName}">Try again</button>` : ''}
    </div>`;
}

export function initials(username) {
    const s = String(username || 'A').trim();
    return (s[0] || 'A').toUpperCase();
}

// Robust form field lookup — works in every browser engine and embedded webview
// (named form properties like `form.username` are not universal).
export function fieldEl(form, name) {
    return form.querySelector(`[name="${name}"]`);
}

export function fieldValue(form, name) {
    const el = fieldEl(form, name);
    return el ? el.value : '';
}

export function copyToClipboard(text, label = 'Copied to clipboard') {
    const done = () => toast(label, 'success');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else {
        legacyCopy(text, done);
    }
}

function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (_) { toast('Copy failed — please copy manually.', 'error'); }
    ta.remove();
}
