// Public screens: landing page, login and registration.

import { api } from '../api.js';
import { store } from '../store.js';
import { esc, fmtNaira, fmtPct, fmtNum, toast, setBusy, tierBadge, fieldValue } from '../ui.js';

const TIER_ORDER = ['Starter', 'Growth', 'Wealth', 'Elite'];

function pkgCardPublic(p) {
    const totalRoi = p.capital > 0 ? ((p.total_payout - p.capital) / p.capital) : 0;
    return `
    <article class="card pkg-card">
        <div class="pkg-tier-row">
            <h3 class="pkg-name">${esc(p.name)}</h3>
            ${tierBadge(p.tier)}
        </div>
        <div class="pkg-capital money">${fmtNaira(p.capital)}</div>
        <div class="pkg-rows">
            <div class="row"><span>Daily earning</span><span>${fmtNaira(p.daily_earning)} (${fmtPct(p.daily_rate)}/day)</span></div>
            <div class="row"><span>Cycle</span><span>${fmtNum(p.cycle_days)} days</span></div>
            <div class="row"><span>Total payout</span><span>${fmtNaira(p.total_payout)}</span></div>
            <div class="row"><span>Referral bonus</span><span>${fmtNaira(p.referral_bonus)}</span></div>
        </div>
        <a class="btn btn-secondary pkg-cta" href="#/register">Get started</a>
    </article>`;
}

export async function renderLanding(root) {
    root.innerHTML = `
    <div class="public-wrap">
        <nav class="public-nav" aria-label="Public navigation">
            <a class="brand" href="#/">
                <img src="/assets/logo.svg" alt="Access Wealth HQ logo" />
                <span>Access Wealth <small>HQ</small></span>
            </a>
            <span class="spacer"></span>
            <a class="btn btn-ghost" href="#/login">Log in</a>
            <a class="btn btn-primary" href="#/register">Create account</a>
        </nav>

        <header class="hero">
            <div class="hero-inner">
                <div>
                    <p class="eyebrow">Access Wealth HQ</p>
                    <h1>Manage your Access Wealth membership in one place.</h1>
                    <p class="lede">
                        Activate an investment package, track your daily earnings, fund your wallet by bank
                        transfer with receipt upload, withdraw to your bank, and grow with referrals —
                        all with clear, honest status updates at every step.
                    </p>
                    <div class="cta-row">
                        <a class="btn btn-accent" href="#/register">Create your account</a>
                        <a class="btn btn-ghost" href="#/login">I already have an account</a>
                    </div>
                    <div class="hero-stats">
                        <div class="hstat"><div class="hstat-value">11</div><div class="hstat-label">Packages</div></div>
                        <div class="hstat"><div class="hstat-value">4</div><div class="hstat-label">Tiers</div></div>
                        <div class="hstat"><div class="hstat-value">₦500</div><div class="hstat-label">Entry from</div></div>
                        <div class="hstat"><div class="hstat-value">24/7</div><div class="hstat-label">In-app support</div></div>
                    </div>
                </div>
            </div>
        </header>

        <section class="section" id="packages">
            <div class="section-inner">
                <div class="section-head">
                    <h2>Investment packages</h2>
                    <p>Every package pays a fixed daily earning for its full cycle. Figures below are loaded live from Access Wealth, so what you see is what you get.</p>
                </div>
                <div id="landing-pkgs"><div class="skeleton skel-card" style="min-height:180px"></div></div>
            </div>
        </section>

        <section class="section section-alt">
            <div class="section-inner">
                <div class="section-head">
                    <h2>How Access Wealth works</h2>
                    <p>Four steps, no surprises. You always know the status of your money.</p>
                </div>
                <div class="steps">
                    <div class="step"><h3>Create your account</h3><p>Sign up with your email and a password. Add a referral code if a member invited you.</p></div>
                    <div class="step"><h3>Fund your wallet</h3><p>Transfer to the official Access Wealth account and upload your receipt. An admin reviews and credits your wallet.</p></div>
                    <div class="step"><h3>Activate a package</h3><p>Choose a package you can afford. Daily earnings start counting from activation.</p></div>
                    <div class="step"><h3>Claim & withdraw</h3><p>Claim earnings daily, then withdraw to your bank account once you reach the minimum.</p></div>
                </div>
            </div>
        </section>

        <footer class="public-footer">
            <div class="foot-inner">
                <div><strong>Access Wealth HQ</strong> — member &amp; investment portal.</div>
                <p class="disclaimer">Access Wealth presents package earnings as published in the package catalogue and shows every deposit and withdrawal status honestly (pending, approved or declined). Earnings depend on package terms; past payouts are not a promise of future results. Only fund amounts you can afford. Never share your password or one-time codes with anyone, including people claiming to be support.</p>
            </div>
        </footer>
    </div>`;

    try {
        const data = await api('/api/packages', { auth: false });
        const pkgs = (data.packages || []).slice().sort((a, b) => a.capital - b.capital);
        const grouped = TIER_ORDER
            .map((tier) => ({ tier, items: pkgs.filter((p) => (p.tier || '').toLowerCase() === tier.toLowerCase()) }))
            .filter((g) => g.items.length);
        document.getElementById('landing-pkgs').innerHTML = grouped.map((g) => `
            <h3 class="mt-5">${esc(g.tier)} tier</h3>
            <div class="pkg-grid">${g.items.map(pkgCardPublic).join('')}</div>
        `).join('') || '<p class="muted">Packages will appear here shortly.</p>';
    } catch (err) {
        document.getElementById('landing-pkgs').innerHTML =
            `<div class="notice notice-warning"><span class="notice-ico">⚠️</span><p>Live package list is unavailable right now (${esc(err.message)}). You can still create an account and view packages inside.</p></div>`;
    }
}

export function renderLogin(root) {
    root.innerHTML = `
    <div class="auth-wrap">
        <div class="auth-card">
            <div class="card">
                <div class="auth-brand">
                    <img src="/assets/logo.svg" alt="Access Wealth HQ logo" />
                    <div class="auth-title">Welcome back</div>
                    <div class="auth-sub">Log in to your Access Wealth HQ account</div>
                </div>
                <form id="login-form" novalidate>
                    <div class="field">
                        <label for="login-username">Email or username</label>
                        <input class="input" id="login-username" name="username" type="text" autocomplete="username" required placeholder="you@example.com" />
                    </div>
                    <div class="field">
                        <label for="login-password">Password</label>
                        <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Your password" />
                    </div>
                    <div class="field"><div class="error-text hide" id="login-error" role="alert"></div></div>
                    <button class="btn btn-primary btn-block" type="submit" id="login-btn">Log in</button>
                </form>
                <p class="auth-alt">New to Access Wealth? <a href="#/register"><strong>Create an account</strong></a></p>
            </div>
            <p class="auth-back"><a href="#/">← Back to home</a></p>
        </div>
    </div>`;

    const form = root.querySelector('#login-form');
    const errEl = root.querySelector('#login-error');
    const btn = root.querySelector('#login-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.classList.add('hide');
        const username = fieldValue(form, 'username').trim();
        const password = fieldValue(form, 'password');
        if (!username || !password) {
            errEl.textContent = 'Enter your email/username and password.';
            errEl.classList.remove('hide');
            return;
        }
        setBusy(btn, true, 'Logging in…');
        try {
            const data = await api('/api/login', { method: 'POST', auth: false, body: { username, password } });
            const token = data.token || data.accessToken || data.access_token || data.newToken;
            store.setAuth({ token, user: data.user });
            toast(`Welcome back, ${data.user?.full_name || data.user?.username || 'member'}!`, 'success');
            location.hash = '#/dashboard';
        } catch (err) {
            if (err.status === 429) {
                errEl.textContent = 'Too many attempts. Please wait a minute and try again.';
            } else {
                errEl.textContent = err.message || 'Login failed.';
            }
            errEl.classList.remove('hide');
        } finally {
            setBusy(btn, false);
        }
    });
}

export function renderRegister(root, params = {}) {
    const refCode = params.ref || '';
    root.innerHTML = `
    <div class="auth-wrap">
        <div class="auth-card">
            <div class="card">
                <div class="auth-brand">
                    <img src="/assets/logo.svg" alt="Access Wealth HQ logo" />
                    <div class="auth-title">Create your account</div>
                    <div class="auth-sub">Join Access Wealth HQ in under a minute</div>
                </div>
                <form id="reg-form" novalidate>
                    <div class="field">
                        <label for="reg-username">Email or username</label>
                        <input class="input" id="reg-username" name="username" type="email" autocomplete="username" required placeholder="you@example.com" />
                        <div class="hint">You will use this to log in.</div>
                    </div>
                    <div class="field">
                        <label for="reg-password">Password</label>
                        <input class="input" id="reg-password" name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="At least 6 characters" />
                    </div>
                    <div class="field">
                        <label for="reg-ref">Referral code <span class="muted">(optional)</span></label>
                        <input class="input" id="reg-ref" name="referred_by" type="text" placeholder="e.g. AW1A2B3C4D" value="${esc(refCode)}" />
                        <div class="hint">If a member invited you, enter their code — it rewards them when you activate a package.</div>
                    </div>
                    <div class="field"><div class="error-text hide" id="reg-error" role="alert"></div></div>
                    <button class="btn btn-primary btn-block" type="submit" id="reg-btn">Create account</button>
                </form>
                <p class="auth-alt">Already have an account? <a href="#/login"><strong>Log in</strong></a></p>
            </div>
            <p class="auth-back"><a href="#/">← Back to home</a></p>
        </div>
    </div>`;

    const form = root.querySelector('#reg-form');
    const errEl = root.querySelector('#reg-error');
    const btn = root.querySelector('#reg-btn');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.classList.add('hide');
        const username = fieldValue(form, 'username').trim();
        const password = fieldValue(form, 'password');
        const referred_by = fieldValue(form, 'referred_by').trim();

        if (!/^[a-zA-Z0-9_.@-]{3,50}$/.test(username)) {
            errEl.textContent = 'Use a valid email or username (3–50 characters).';
            errEl.classList.remove('hide');
            return;
        }
        if (password.length < 6) {
            errEl.textContent = 'Password must be at least 6 characters.';
            errEl.classList.remove('hide');
            return;
        }
        setBusy(btn, true, 'Creating account…');
        try {
            const body = { username, password };
            if (referred_by) body.referred_by = referred_by;
            const data = await api('/api/register', { method: 'POST', auth: false, body });
            const token = data.token || data.accessToken || data.access_token || data.newToken;
            store.setAuth({ token, user: data.user });
            toast('Account created — welcome to Access Wealth HQ!', 'success');
            location.hash = '#/dashboard';
        } catch (err) {
            errEl.textContent = err.status === 429
                ? 'Too many attempts. Please wait a minute and try again.'
                : (err.message || 'Registration failed.');
            errEl.classList.remove('hide');
        } finally {
            setBusy(btn, false);
        }
    });
}
