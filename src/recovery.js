import { z } from 'zod';

// Failures need a backoff even for transports that send only once per session.
export function failureRetryDelay(retryAfterMs) {
  return Number.isFinite(retryAfterMs) ? Math.max(1, retryAfterMs) : 1000;
}

export function installRecovery(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS delivery_status (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id), agent TEXT NOT NULL REFERENCES agents(name),
    attempts INTEGER NOT NULL DEFAULT 0, policy TEXT NOT NULL, attempted_at TEXT,
    last_error TEXT, outcome TEXT NOT NULL, next_retry_at TEXT
  );`);
}
export function recordAttempt(store, agent, ids, { policy }) {
  const now = new Date().toISOString();
  store.transaction(() => {
    for (const id of ids) {
      if (policy === 'durable_once') {
        const recipient = store.db.prepare('SELECT recipient FROM messages WHERE id=?').get(id)?.recipient;
        if (recipient !== agent) throw new Error('Push attempt is not in this mailbox.');
        store.db.prepare('INSERT OR IGNORE INTO push_attempts(message_id,agent) VALUES (?,?)').run(id, agent);
      }
      store.db.prepare(`INSERT INTO delivery_status(message_id,agent,attempts,policy,attempted_at,outcome,next_retry_at)
      VALUES (?,?,1,?,?,'attempting',NULL) ON CONFLICT(message_id) DO UPDATE SET attempts=attempts+1,policy=excluded.policy,
      attempted_at=excluded.attempted_at,outcome='attempting',next_retry_at=NULL`)
      .run(id, agent, policy, now);
    }
  });
}
export function recordFailure(store, agent, ids, error, { policy, retryAfterMs }) {
  const retryAt = policy === 'durable_once' ? null : new Date(Date.now() + failureRetryDelay(retryAfterMs)).toISOString();
  for (const id of ids) store.db.prepare(`UPDATE delivery_status SET last_error=?,outcome=?,next_retry_at=? WHERE message_id=? AND agent=?`)
    .run(String(error?.message ?? error), 'ambiguous', retryAt, id, agent);
}
export function recordDelivery(store, agent, ids, { policy, retryAfterMs }) {
  for (const id of ids) store.db.prepare(`UPDATE delivery_status SET last_error=NULL,outcome='transport_accepted',next_retry_at=? WHERE message_id=? AND agent=?`)
    .run(policy === 'durable_once' || !Number.isFinite(retryAfterMs) ? null : new Date(Date.now()+retryAfterMs).toISOString(), id, agent);
}
export function deliveryStatus(store, agent, id) {
  const message = store.message(agent, id);
  let attempt = store.db.prepare('SELECT * FROM delivery_status WHERE message_id=?').get(id) ?? null;
  // Older durable-once markers also suppress replay after upgrade. Surface
  // that fact even when no richer telemetry was recorded by the old version.
  if (!attempt) {
    const legacy = store.db.prepare('SELECT * FROM push_attempts WHERE message_id=?').get(id);
    if (legacy) attempt = { message_id: id, agent: legacy.agent, attempts: 1, policy: 'durable_once', attempted_at: legacy.attempted_at,
      last_error: null, outcome: message.delivered_at ? 'transport_accepted' : 'ambiguous', next_retry_at: null };
  }
  const mode = store.presence(message.recipient).mode;
  const connected = !!store.db.prepare('SELECT 1 FROM leases WHERE agent=? AND expires>?').get(message.recipient, Date.now());
  const suppressed = mode !== 'active' || !!message.acknowledged_at;
  return { message_id: id, recipient: message.recipient, delivery_mode: mode, push_connected: connected,
    delivered_at: message.delivered_at, acknowledged_at: message.acknowledged_at,
    attempt: attempt ? { ...attempt,
      // This is eligibility, not a promised delivery schedule. Preserve the
      // persisted backoff separately when a consumer is absent or paused.
      retry_not_before: attempt.next_retry_at,
      next_retry_at: suppressed || !connected || attempt.outcome === 'attempting' ? null : attempt.next_retry_at,
      retry_timing: 'earliest_eligibility_not_schedule',
    } : null,
    recovery: message.acknowledged_at ? 'Transport acknowledged; inspect radio_work for task completion.' : mode !== 'active' ? 'Await explicit human resume. Do not reactivate on peer request.' : attempt?.policy === 'durable_once' ? 'Automatic resubmission is suppressed. Recipient can recover with radio_message or radio_inbox.' : !connected ? 'No live push consumer observed. Recipient can recover with radio_message or radio_inbox; a future consumer may retry according to its delivery policy.' : 'Recipient can recover with radio_message or radio_inbox. Use the original key for send retries.' };
}
export function errorResult(error) {
  const message = String(error?.message ?? error);
  const knownCodes = new Set(['NOT_RECIPIENT', 'WORK_ALREADY_CLAIMED', 'INVALID_WORK_TRANSITION', 'INVALID_ARGUMENT', 'UNKNOWN_AGENT', 'RETRY_KEY_CONFLICT', 'INVALID_REPLY', 'MESSAGE_NOT_ACCESSIBLE', 'STORE_BUSY', 'OPERATION_FAILED']);
  let code = knownCodes.has(error?.code) ? error.code : undefined;
  if (!code) {
    if (error instanceof z.ZodError) code = 'INVALID_ARGUMENT';
    // node:sqlite reports ERR_SQLITE_ERROR with numeric errcode=5/6 (or
    // extended SQLite codes whose low byte is BUSY/LOCKED).
    else if (/SQLITE_(BUSY|LOCKED)/.test(error?.code ?? '') || [5, 6].includes(Number(error?.errcode) & 255) || /locked|busy/i.test(message)) code = 'STORE_BUSY';
    else if (/Unknown agent/.test(message)) code = 'UNKNOWN_AGENT';
    else if (/Retry key/.test(message)) code = 'RETRY_KEY_CONFLICT';
    else if (/reply_to/.test(message)) code = 'INVALID_REPLY';
    else if (/not in your inbox|not in your conversations|not accessible|not a participant/.test(message)) code = 'MESSAGE_NOT_ACCESSIBLE';
    else code = 'OPERATION_FAILED';
  }
  const retryable = code === 'STORE_BUSY';
  const actions = { UNKNOWN_AGENT: 'Call radio_agents and choose a registered peer.', RETRY_KEY_CONFLICT: 'Recover the original send from history; use a new key only for a new operation.', WORK_ALREADY_CLAIMED: 'Read radio_work; resume the recorded claim rather than repeating work.', MESSAGE_NOT_ACCESSIBLE: 'Use an ID from your own inbox or history.', INVALID_WORK_TRANSITION: 'Read radio_work and choose a valid next state.' };
  return { error: { code, message, retryable, recovery: actions[code] ?? (retryable ? 'Retry with the same arguments and send key.' : 'Correct the request or inspect local diagnostics before retrying.') } };
}
