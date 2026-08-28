// Auth/session store. Persists the token + user object so returning users
// stay signed in; notifies subscribers on every change.

const KEY = 'awhq.auth.v1';

let state = load();
const listeners = new Set();

function load() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { token: null, user: null };
        const parsed = JSON.parse(raw);
        return { token: parsed.token || null, user: parsed.user || null };
    } catch (_) {
        return { token: null, user: null };
    }
}

function persist() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ token: state.token, user: state.user }));
    } catch (_) { /* storage can fail in private mode; session still works in-memory */ }
    listeners.forEach((fn) => { try { fn(state); } catch (_) {} });
}

export const store = {
    get token() { return state.token; },
    get user() { return state.user; },
    get isAuthed() { return Boolean(state.token); },
    get isAdmin() { return state.user && state.user.role === 'admin'; },
    get isStaff() { return state.user && (state.user.role === 'admin' || state.user.role === 'support'); },

    setAuth({ token, user }) {
        state = { token: token || state.token, user: user ?? state.user };
        persist();
    },

    setUser(user) {
        state = { ...state, user };
        persist();
    },

    clear() {
        state = { token: null, user: null };
        try { localStorage.removeItem(KEY); } catch (_) {}
        listeners.forEach((fn) => { try { fn(state); } catch (_) {} });
    },

    onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }
};
