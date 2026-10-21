import { z } from 'zod';

export const workState = z.enum(['accepted', 'in_progress', 'blocked', 'completed', 'declined']);
export const workInput = z.object({
  id: z.number().int().positive(),
  state: workState,
  key: z.string().min(1).max(128).describe('Stable operation key. Reuse after a restart; a different key cannot claim this request.'),
  detail: z.string().max(2000).optional(),
  result_ref: z.string().max(2000).optional(),
}).strict();

export function installWork(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS work_items (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    agent TEXT NOT NULL REFERENCES agents(name), claim_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('accepted','in_progress','blocked','completed','declined')),
    detail TEXT, result_ref TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
}
export function readWork(store, agent, id) {
  const message = store.message(agent, id);
  return { message_id: message.id, work: store.db.prepare('SELECT * FROM work_items WHERE message_id=?').get(id) ?? null };
}
export function updateWork(store, agent, input) {
  const { id, state, key, detail, result_ref } = workInput.parse(input);
  return store.transaction(() => {
    const message = store.message(agent, id);
    if (message.recipient !== agent) throw Object.assign(new Error('Only the recipient may claim or update work.'), { code: 'NOT_RECIPIENT' });
    const old = store.db.prepare('SELECT * FROM work_items WHERE message_id=?').get(id);
    if (old && old.claim_key !== key) throw Object.assign(new Error('Request already claimed. Inspect its work state; do not repeat the operation.'), { code: 'WORK_ALREADY_CLAIMED' });
    if (!old && !['accepted', 'declined'].includes(state)) throw Object.assign(new Error('First accept or decline the request.'), { code: 'INVALID_WORK_TRANSITION' });
    const transitions = { accepted: ['accepted','in_progress','blocked','completed','declined'], in_progress: ['in_progress','blocked','completed'], blocked: ['blocked','in_progress','completed','declined'], completed: ['completed'], declined: ['declined'] };
    if (old && !transitions[old.state].includes(state)) throw Object.assign(new Error(`Cannot change ${old.state} work to ${state}.`), { code: 'INVALID_WORK_TRANSITION' });
    // A repeated update is safe; preserve prior optional fields when omitted.
    store.db.prepare(`INSERT INTO work_items(message_id,agent,claim_key,state,detail,result_ref) VALUES (?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET state=excluded.state, detail=excluded.detail, result_ref=excluded.result_ref,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(id, agent, key, state, detail ?? old?.detail ?? null, result_ref ?? old?.result_ref ?? null);
    // Accepting durably stops transport replay; completion remains independently visible.
    store.db.prepare("UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?").run(id);
    return { message_id: id, work: store.db.prepare('SELECT * FROM work_items WHERE message_id=?').get(id) };
  });
}
export function listWork(store, agent, { state, after = 0, limit = 20 } = {}) {
  store.agent(agent); z.number().int().nonnegative().parse(after); z.number().int().min(1).max(100).parse(limit);
  if (state) workState.parse(state);
  const rows = store.db.prepare(`SELECT w.*, m.sender, m.thread_id FROM work_items w JOIN messages m ON m.id=w.message_id
    WHERE (m.sender=? OR m.recipient=?) AND w.message_id>? ${state ? 'AND w.state=?' : ''} ORDER BY w.message_id LIMIT ?`)
    .all(agent, agent, after, ...(state ? [state] : []), limit + 1);
  return { work: rows.slice(0,limit), has_more: rows.length > limit, next_after: rows.slice(0,limit).at(-1)?.message_id ?? null };
}
