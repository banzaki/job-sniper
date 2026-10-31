// Run this BEFORE every `openclaw gateway run` (the gateway must be stopped first: it would otherwise race the same
// long-polling offset and get an HTTP 409 from Telegram). OpenClaw itself has no config option to discard updates
// queued before a restart (its own startup code calls Telegram's deleteWebhook with drop_pending_updates=false); this
// script does it with Telegram's OWN official mechanism instead: the getUpdates offset. It reads the highest pending
// update_id and immediately acknowledges past it, so the server-side queue is cleared. No update's content (message
// text, sender) is ever read, logged or printed — only a count and an id number cross this script's own output.
//
// Usage:  node --import tsx openclaw/drop-pending-telegram-updates.mjs   (run from the job-sniper repo root; reads
//         TELEGRAM_BOT_TOKEN from .env the same way the rest of Job Sniper does; never prints, logs or stores the
//         token itself). `tsx` is required only so the plain import below can resolve `src/config.ts`.
import https from 'node:https';
import { loadAppConfig } from '../src/config.ts';

const config = loadAppConfig();
const token = config.telegramBotToken;
if (!token) {
  console.log(JSON.stringify({ ok: false, reason: 'TELEGRAM_BOT_TOKEN not loaded' }));
  process.exit(1);
}

function call(method, params) {
  const qs = new URLSearchParams(params).toString();
  const path = `/bot${token}/${method}${qs ? `?${qs}` : ''}`;
  return new Promise((resolve, reject) => {
    https
      .get({ host: 'api.telegram.org', path, timeout: 15000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`bad JSON from Telegram (status ${res.statusCode})`));
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

const peek = await call('getUpdates', { offset: '-1', limit: '1', timeout: '0' });
if (!peek.ok) {
  console.log(JSON.stringify({ ok: false, reason: 'getUpdates(peek) failed', description: peek.description ?? null }));
  process.exit(1);
}
const pending = peek.result ?? [];
if (pending.length === 0) {
  console.log(JSON.stringify({ ok: true, dropped: 0, note: 'nothing was pending' }));
  process.exit(0);
}
const highestId = pending[0].update_id;
const ack = await call('getUpdates', { offset: String(highestId + 1), limit: '1', timeout: '0' });
console.log(JSON.stringify({ ok: ack.ok === true, highestPendingUpdateId: highestId, remainingAfterAck: (ack.result ?? []).length }));
