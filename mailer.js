// Transactional email for Access Wealth HQ.
//
// Events wired: welcome, email verification, password reset code,
// deposit approved, withdrawal paid, plan activated/upgraded.
//
// Transport selection (first match wins):
//   MAIL_TRANSPORT=json      → render only, no delivery (dev/tests; safe)
//   SMTP_HOST (+SMTP_PORT/USER/PASS/SECURE) → real SMTP via nodemailer
//   neither → disabled: send() logs a skip line and resolves { skipped:true }
//
// Every template ends with the "Get the Access Wealth app" footer block:
// deep-blue band (#112A46), gold button (#d4af37) with dark text (#0b1421),
// linking to the install page. When the Play listing is live, swap
// GET_APP_URL for the Play store URL below (single line change).

let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (error) {
    console.warn('[mail] nodemailer module unavailable; email disabled:', error.message);
}

const GET_APP_URL = 'https://accesswealthhq.com/login.html';
// Once the Play listing is live, use this instead:
// const GET_APP_URL = 'https://play.google.com/store/apps/details?id=com.accesswealthhq.app';

const BRAND = {
    band: '#112A46',
    button: '#d4af37',
    buttonText: '#0b1421',
    text: '#182533',
    muted: '#5c6b7d',
    cardBg: '#ffffff',
    pageBg: '#f2f5f8'
};

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// The shared app-install footer block (same on every transactional email).
function appFooterHtml() {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.band};border-radius:0 0 10px 10px;">
          <tr>
            <td align="center" style="padding:24px 28px;">
              <div style="color:#ffffff;font-weight:700;font-size:15px;margin:0 0 6px;">Get the Access Wealth app</div>
              <div style="color:#c7d4e6;font-size:12.5px;line-height:1.5;margin:0 0 14px;">Open on your phone and choose Install app — works offline.</div>
              <a href="${GET_APP_URL}" target="_blank" rel="noopener"
                 style="display:inline-block;background:${BRAND.button};color:${BRAND.buttonText};font-weight:800;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:8px;">Open Access Wealth HQ</a>
            </td>
          </tr>
        </table>`;
}

function appFooterText() {
    return ['', 'Get the Access Wealth app', 'Open on your phone and choose Install app — works offline.', GET_APP_URL].join('\n');
}

// Bulletproof table-based transactional layout (Outlook/Gmail-safe basics).
function renderEmail({ title, greeting, paragraphs = [], highlight = null, cta = null }) {
    const bodyRows = [
        greeting ? `<p style="margin:0 0 14px;font-size:14px;color:${BRAND.text};">${greeting}</p>` : '',
        ...paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${BRAND.text};">${p}</p>`),
        highlight ? `<div style="margin:18px 0;padding:16px;border-radius:8px;background:#f4f7fb;text-align:center;font-size:22px;font-weight:800;letter-spacing:2px;color:${BRAND.band};">${highlight}</div>` : '',
        cta ? `<div style="text-align:center;margin:20px 0;"><a href="${cta.url}" target="_blank" rel="noopener" style="display:inline-block;background:${BRAND.band};color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:8px;">${cta.label}</a></div>` : ''
    ].join('');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;">
    <div style="text-align:center;padding:0 0 16px;">
      <div style="font-size:17px;font-weight:800;color:${BRAND.band};">Access Wealth <span style="color:${BRAND.button};letter-spacing:2px;">HQ</span></div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cardBg};border-radius:10px;">
      <tr>
        <td style="padding:26px 28px 6px;">
          <h1 style="margin:0 0 16px;font-size:19px;color:${BRAND.band};">${title}</h1>
          ${bodyRows}
        </td>
      </tr>
      <tr><td style="padding:10px 0 0;">${appFooterHtml()}</td></tr>
    </table>
    <p style="text-align:center;color:${BRAND.muted};font-size:11px;margin:14px 0 0;">
      Access Wealth HQ · If you did not request this email, you can ignore it — never share your password or codes with anyone.
    </p>
  </div>
</body></html>`;

    const text = [title, '', ...[greeting, ...paragraphs].filter(Boolean).map((s) => s.replace(/<[^>]+>/g, ''))]
        .concat(cta ? [`\n${cta.label}: ${cta.url}`] : [])
        .concat(appFooterText())
        .join('\n');
    return { html, text };
}

function createMailer() {
    const enabledByDefault = Boolean(
        process.env.MAIL_TRANSPORT === 'json' ||
        (process.env.SMTP_HOST && String(process.env.SMTP_HOST).trim())
    );
    const flag = String(process.env.MAIL_ENABLED || '').trim().toLowerCase();
    const enabled = flag ? ['true', '1', 'yes'].includes(flag) : enabledByDefault;
    const from = process.env.MAIL_FROM || 'Access Wealth HQ <no-reply@accesswealthhq.com>';

    if (!enabled || !nodemailer) {
        if (!enabled) console.warn('[mail] email disabled (set SMTP_* or MAIL_TRANSPORT=json to enable).');
        return {
            enabled: false,
            async send({ to, subject }) {
                console.warn(`[mail] disabled — skipped "${subject}" → ${to}`);
                return { skipped: true };
            }
        };
    }

    const transport = process.env.MAIL_TRANSPORT === 'json'
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 465),
            secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined
        });

    const isJsonTransport = process.env.MAIL_TRANSPORT === 'json';
    return {
        enabled: true,
        async send({ to, subject, html, text }) {
            const info = await transport.sendMail({ from, to, subject, html, text });
            // jsonTransport is used in dev/tests: log the routing summary only
            // (never the body — it can contain one-time codes).
            console.warn(`[mail]${isJsonTransport ? ' (render-only)' : ''} sent "${subject}" → ${to}`);
            return info;
        }
    };
}

function isLikelyEmail(username) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(username || '').trim());
}

module.exports = { createMailer, renderEmail, isLikelyEmail, escapeHtml, GET_APP_URL };
