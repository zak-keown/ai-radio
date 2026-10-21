import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { failureRetryDelay } from './recovery.js';

// Watcher gives fast local delivery; timer recovers missed filesystem events.
// A lease prevents two live consumers from pushing the same mailbox.
export function startPush(store, agent, deliver, onError = console.error, { retryAfterMs = Infinity, durableOnce = false } = {}) {
  const owner = randomUUID();
  const sent = new Map();
  const failedUntil = new Map((store.db?.prepare(`SELECT message_id,next_retry_at FROM delivery_status
    WHERE agent=? AND outcome='ambiguous' AND next_retry_at>?`).all(agent, new Date().toISOString()) ?? [])
    .map(row => [row.message_id, Date.parse(row.next_retry_at)]));
  let closed = false;
  let running = false;
  let blocked = false;
  let scanAfter = 0;
  const tick = async () => {
    if (closed || running) return;
    running = true;
    try {
      if (store.presence(agent).mode !== 'active') { store.release(agent, owner); return; }
      if (!store.lease(agent, owner)) {
        if (!blocked) onError(new Error(`Another push consumer owns ${agent}. Use a unique agent name for each session.`));
        blocked = true;
        return;
      }
      blocked = false;
      // One bounded packet per pass; retain a cursor so an unacknowledged
      // first page cannot starve newer requests in a large mailbox.
      if (!closed && store.presence(agent).mode === 'active') {
        const result = store.inbox(agent, { after: scanAfter, limit: 100 });
        const pending = result.messages.filter(m => (!durableOnce || !store.attempted(agent, m.id)) && Date.now() >= (failedUntil.get(m.id) ?? 0) && (!sent.has(m.id) || Date.now() - sent.get(m.id) >= retryAfterMs));
        if (pending.length) {
          const ids = pending.map(m => m.id);
          const policy = durableOnce ? 'durable_once' : Number.isFinite(retryAfterMs) ? 'until_acknowledged' : 'session_once';
          const recovery = { policy, retryAfterMs };
          // Queue transports can accept a message and then time out. Persist before sending; ambiguous attempts
          // remain recoverable in inbox, but never enqueue again automatically, even after a bridge restart.
          if (durableOnce && !store.recordAttempt) store.markAttempted(agent, ids);
          store.recordAttempt?.(agent, ids, recovery);
          try { await deliver(pending); }
          catch (error) {
            const retryAt = Date.now() + failureRetryDelay(retryAfterMs);
            for (const id of ids) failedUntil.set(id, retryAt);
            store.recordFailure?.(agent, ids, error, recovery);
            throw error;
          }
          if (closed) return;
          store.delivered(ids);
          store.recordDelivery?.(agent, ids, recovery);
          for (const message of pending) {
            failedUntil.delete(message.id);
            sent.set(message.id, Date.now());
          }
        }
        scanAfter = result.has_more ? result.next_after : 0;
      }
    } catch (error) { if (!closed) onError(error); }
    finally { running = false; }
  };
  const watcher = watch(store.directory, () => { void tick(); });
  watcher.on('error', onError);
  const heartbeat = setInterval(() => {
    if (!closed && running) {
      try { store.lease(agent, owner); } catch (error) { onError(error); }
    }
  }, 3000);
  const timer = setInterval(() => { void tick(); }, 1000);
  void tick();
  return () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    watcher.close();
    store.release(agent, owner);
  };
}
