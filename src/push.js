import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';

// Watcher gives fast local delivery; timer recovers missed filesystem events.
// A lease prevents two live consumers from pushing the same mailbox.
export function startPush(store, agent, deliver, onError = console.error, { retryAfterMs = Infinity, durableOnce = false } = {}) {
  const owner = randomUUID();
  const sent = new Map();
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
      let after = scanAfter;
      // Bound each pass so other traffic and shutdown remain responsive.
      for (let page = 0; page < 10 && !closed; page++) {
        if (store.presence(agent).mode !== 'active') break;
        const result = store.inbox(agent, { after, limit: 100 });
        const pending = result.messages.filter(m => (!durableOnce || !store.attempted(agent, m.id)) && (!sent.has(m.id) || Date.now() - sent.get(m.id) >= retryAfterMs));
        if (pending.length) {
          // Queue transports can accept a message and then time out. Persist before sending; ambiguous attempts
          // remain recoverable in inbox, but never enqueue again automatically, even after a bridge restart.
          if (durableOnce) store.markAttempted(agent, pending.map(m => m.id));
          await deliver(pending);
          if (closed) return;
          store.delivered(pending.map(m => m.id));
          for (const message of pending) sent.set(message.id, Date.now());
        }
        if (!result.has_more) { scanAfter = 0; break; }
        after = result.next_after;
        scanAfter = after;
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
