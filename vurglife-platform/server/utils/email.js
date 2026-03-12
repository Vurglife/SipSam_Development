// ============================================
// VURGLIFE — EMAIL UTILITY (Resend.com)
// In dev mode: logs to console instead of sending
// ============================================

async function sendEmail(to, subject, htmlBody) {
    if (process.env.NODE_ENV !== 'production' || !process.env.RESEND_API_KEY) {
        console.log(`[EMAIL - DEV MODE]\nTo: ${to}\nSubject: ${subject}\n---`);
        return { ok: true, dev: true };
    }

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from:    'VurgLife <noreply@vurglife.com>',
                to:      [to],
                subject: subject,
                html:    wrapEmail(subject, htmlBody)
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Resend error');
        return { ok: true, id: data.id };
    } catch (err) {
        console.error('[Email] Send failed:', err.message);
        return { ok: false, error: err.message };
    }
}

function wrapEmail(subject, body) {
    return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>${subject}</title></head>
    <body style="background:#0a0f1e;margin:0;padding:40px 20px;font-family:'Segoe UI',sans-serif;">
        <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid #1a2a4a;">
            <div style="background:linear-gradient(135deg,#0a1628 0%,#1a3a6a 100%);padding:32px;text-align:center;">
                <h1 style="color:#1a8cff;font-size:28px;margin:0;letter-spacing:4px;font-weight:900;">VURGLIFE</h1>
                <p style="color:#4a9eff;margin:4px 0 0;font-size:13px;letter-spacing:2px;">GAMING PLATFORM</p>
            </div>
            <div style="padding:32px;color:#c8d8f0;line-height:1.6;">
                ${body}
            </div>
            <div style="padding:20px 32px;border-top:1px solid #1a2a4a;text-align:center;">
                <p style="color:#4a6080;font-size:12px;margin:0;">© ${new Date().getFullYear()} VurgLife. All rights reserved.</p>
            </div>
        </div>
    </body>
    </html>`;
}

module.exports = { sendEmail };
