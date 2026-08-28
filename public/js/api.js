// Central API client for the Access Wealth HQ backend.
// - Sends Authorization: Bearer <token> on every authenticated call.
// - On 401/403 with code TOKEN_INVALID, refreshes the token ONCE via
//   POST /api/refresh-token, stores the new token + user, and retries the
//   original request ONCE. The refresh call itself is never retried.
// - If refresh fails, auth is cleared and the app routes to login.

import { store } from './store.js';

export class ApiError extends Error {
    constructor(message, { status, code, data } = {}) {
        super(message || 'Something went wrong. Please try again.');
        this.status = status || 0;
        this.code = code || null;
        this.data = data || null;
    }
}

let refreshInFlight = null;
let onSessionExpired = () => {};

export function setSessionExpiredHandler(fn) { onSessionExpired = fn; }

async function parseBody(res) {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return { error: text }; }
}

async function rawRequest(path, { method = 'GET', body, formData, auth = true } = {}) {
    const headers = {};
    if (auth && store.token) headers['Authorization'] = `Bearer ${store.token}`;
    if (body !== undefined && !formData) headers['Content-Type'] = 'application/json';

    let res;
    try {
        res = await fetch(path, {
            method,
            headers,
            body: formData ? formData : (body !== undefined ? JSON.stringify(body) : undefined)
        });
    } catch (networkErr) {
        throw new ApiError('Network error. Check your connection and try again.', { status: 0 });
    }

    const data = await parseBody(res);
    if (!res.ok) {
        throw new ApiError(data.error || `Request failed (${res.status})`, {
            status: res.status,
            code: data.code || null,
            data
        });
    }
    return data;
}

async function refreshSession() {
    // Single-flight: concurrent 401s share one refresh call.
    if (!refreshInFlight) {
        refreshInFlight = rawRequest('/api/refresh-token', { method: 'POST', body: { token: store.token } })
            .then((data) => {
                const token = data.token || data.accessToken || data.access_token || data.newToken;
                if (!token) throw new ApiError('Session refresh failed.', { status: 401 });
                store.setAuth({ token, user: data.user || store.user });
                return token;
            })
            .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
}

export async function api(path, options = {}, retried = false) {
    try {
        return await rawRequest(path, options);
    } catch (err) {
        const isTokenInvalid = err instanceof ApiError
            && (err.status === 401 || err.status === 403)
            && err.code === 'TOKEN_INVALID';

        if (isTokenInvalid && !retried && store.token) {
            try {
                await refreshSession();
            } catch (refreshErr) {
                store.clear();
                onSessionExpired();
                throw new ApiError('Your session has expired. Please log in again.', { status: 401 });
            }
            return api(path, options, true); // retry the original request exactly once
        }
        throw err;
    }
}

// Authenticated file/binary fetch (e.g. receipt images) → object URL.
export async function apiFileUrl(path) {
    const res = await fetch(path, {
        headers: store.token ? { 'Authorization': `Bearer ${store.token}` } : {}
    });
    if (!res.ok) {
        let msg = `Could not load file (${res.status})`;
        try { const data = await res.json(); if (data.error) msg = data.error; } catch (_) {}
        throw new ApiError(msg, { status: res.status });
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
}

export function logout() {
    store.clear();
}
