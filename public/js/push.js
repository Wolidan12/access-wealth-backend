// Web Push client: subscribes the browser Push API with the server's VAPID
// public key and stores the subscription server-side. Pairs with the push
// handlers in /sw.js. Fails soft everywhere — a browser without push support
// simply shows the feature as unavailable.

import { api } from './api.js';

export function pushSupported() {
    return typeof window !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
}

export function pushPermission() {
    if (!pushSupported()) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
}

export async function fetchVapidKey() {
    const data = await api('/api/push/vapid-public-key', { auth: false });
    return data; // { success, enabled, publicKey }
}

function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
}

async function getRegistration() {
    return navigator.serviceWorker.getRegistration('/');
}

export async function getCurrentSubscription() {
    if (!pushSupported()) return null;
    const reg = await getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
}

// Full enable flow: permission → pushManager.subscribe → POST to backend.
export async function enablePush() {
    if (!pushSupported()) throw new Error('This browser does not support notifications.');
    const keyInfo = await fetchVapidKey();
    if (!keyInfo.enabled || !keyInfo.publicKey) {
        throw new Error('Notifications are not enabled on the server yet.');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(permission === 'denied'
            ? 'Notifications are blocked in your browser settings. Allow them for this site to enable alerts.'
            : 'Notification permission was not granted.');
    }
    const reg = await getRegistration();
    if (!reg) throw new Error('App worker is not ready yet — reload and try again.');
    const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(keyInfo.publicKey)
    });
    await api('/api/push/subscribe', {
        method: 'POST',
        body: { subscription: subscription.toJSON() }
    });
    return subscription;
}

export async function disablePush() {
    const subscription = await getCurrentSubscription();
    if (subscription) {
        try {
            await api('/api/push/unsubscribe', {
                method: 'POST',
                body: { endpoint: subscription.endpoint }
            });
        } catch (_) { /* still unsubscribe locally */ }
        await subscription.unsubscribe();
    }
}

// On boot: if the user previously granted permission, re-sync the subscription
// with the server (browsers rotate endpoints/keys; upsert is idempotent).
export async function resyncPushIfGranted() {
    try {
        if (!pushSupported() || Notification.permission !== 'granted') return;
        const keyInfo = await fetchVapidKey();
        if (!keyInfo.enabled) return;
        const reg = await getRegistration();
        if (!reg) return;
        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
            subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(keyInfo.publicKey)
            });
        }
        await api('/api/push/subscribe', {
            method: 'POST',
            body: { subscription: subscription.toJSON() }
        });
    } catch (_) { /* offline or server without push — ignore */ }
}
