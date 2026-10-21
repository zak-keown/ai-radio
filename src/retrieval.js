import { z } from 'zod';

const idInput = z.number().int().positive();
const cursorInput = z.number().int().nonnegative();
const limitInput = z.number().int().min(1).max(100);

/** Retrieve one durable message without disclosing other participants' traffic. */
export function getMessage(store, agent, id) {
  store.agent(agent);
  idInput.parse(id);
  const message = store.db.prepare('SELECT * FROM messages WHERE id=? AND (sender=? OR recipient=?)').get(id, agent, agent);
  if (!message) throw new Error(`Message ${id} is not in your conversations.`);
  return message;
}

/** ID cursors remain stable when timestamps collide and unrelated messages create gaps. */
export function readHistory(store, agent, { peer, thread_id, after = 0, before, limit = 20, order = 'asc', query } = {}) {
  store.agent(agent);
  cursorInput.parse(after); limitInput.parse(limit);
  z.enum(['asc', 'desc']).parse(order);
  if (before !== undefined) cursorInput.parse(before);
  const where = ['(sender=? OR recipient=?)', 'id>?'];
  const values = [agent, agent, after];
  if (before !== undefined) { where.push('id<?'); values.push(before); }
  if (peer !== undefined) { store.agent(peer); where.push('(sender=? OR recipient=?)'); values.push(peer, peer); }
  if (thread_id !== undefined) { z.string().uuid().parse(thread_id); where.push('thread_id=?'); values.push(thread_id); }
  if (query !== undefined) {
    z.string().min(1).max(1000).parse(query);
    // instr treats wildcard characters as literal text rather than LIKE syntax.
    where.push('instr(lower(body),lower(?))>0'); values.push(query);
  }
  const rows = store.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`).all(...values, limit + 1);
  const messages = rows.slice(0, limit);
  return {
    messages,
    has_more: rows.length > limit,
    next_after: order === 'asc' ? messages.at(-1)?.id ?? null : null,
    next_before: order === 'desc' ? messages.at(-1)?.id ?? null : null,
  };
}

/** List conversations by most recent activity; fetch message bodies separately. */
export function listThreads(store, agent, { peer, before, limit = 20 } = {}) {
  store.agent(agent); limitInput.parse(limit);
  if (before !== undefined) cursorInput.parse(before);
  const where = ['(sender=? OR recipient=?)'];
  const values = [agent, agent];
  if (peer !== undefined) { store.agent(peer); where.push('(sender=? OR recipient=?)'); values.push(peer, peer); }
  const rows = store.db.prepare(`
    WITH visible AS (SELECT * FROM messages WHERE ${where.join(' AND ')}),
    summary AS (
      SELECT thread_id, MAX(id) AS last_message_id, COUNT(*) AS message_count,
        SUM(CASE WHEN recipient=? AND acknowledged_at IS NULL THEN 1 ELSE 0 END) AS pending
      FROM visible GROUP BY thread_id
    )
    SELECT s.*, m.created_at AS last_activity,
      CASE WHEN m.sender=? THEN m.recipient ELSE m.sender END AS peer,
      substr(m.body,1,240) AS latest_message_preview
    FROM summary s JOIN visible m ON m.id=s.last_message_id
    ${before !== undefined ? 'WHERE s.last_message_id<?' : ''}
    ORDER BY s.last_message_id DESC LIMIT ?
  `).all(...values, agent, agent, ...(before !== undefined ? [before] : []), limit + 1);
  const threads = rows.slice(0, limit);
  return { threads, has_more: rows.length > limit, next_before: threads.at(-1)?.last_message_id ?? null };
}
