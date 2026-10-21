import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Use a lowercase agent name, e.g. codex or claude-review.');
export const deliveryMode = z.enum(['active', 'quiet', 'paused', 'stopped']);
export const providerName = z.enum(['codex', 'claude']);
export const pageSize = z.number().int().min(1).max(100).default(20);
export const cursor = z.number().int().nonnegative().default(0);
export const sendInput = z.object({
  to: agentName.describe('Recipient from radio_agents.'),
  body: z.string().min(1).max(16000).refine(s => s.trim().length > 0, 'Message cannot be blank.'),
  reply_to: z.number().int().positive().optional().describe('ID of a message between you and this recipient.'),
  key: z.string().min(1).max(128).optional().describe('Reuse this key to retry a send safely.'),
}).strict();

export class RadioStore {
  constructor(project) {
    this.project = realpathSync(resolve(project));
    this.directory = join(this.project, '.ai-radio');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const ignorePath = join(this.directory, '.gitignore');
    try { writeFileSync(ignorePath, '*\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.path = join(this.directory, 'radio.sqlite3');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Database is newer than this ai-radio version. Upgrade ai-radio.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL REFERENCES agents(name), recipient TEXT NOT NULL REFERENCES agents(name),
        body TEXT NOT NULL, thread_id TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id),
        retry_key TEXT, delivered_at TEXT, acknowledged_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(sender, retry_key)
      );
      CREATE INDEX IF NOT EXISTS inbox ON messages(recipient, acknowledged_at, id);
      CREATE INDEX IF NOT EXISTS conversation ON messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS leases (agent TEXT PRIMARY KEY REFERENCES agents(name), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_modes (
        agent TEXT PRIMARY KEY REFERENCES agents(name), mode TEXT NOT NULL CHECK(mode IN ('active','quiet','paused','stopped'))
      );
      CREATE TABLE IF NOT EXISTS push_attempts (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id), agent TEXT NOT NULL REFERENCES agents(name),
        attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      PRAGMA user_version=1;
    `);
  }
  close() { if (this.db.isOpen) this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  register(name, provider) {
    agentName.parse(name); providerName.parse(provider);
    this.db.prepare('INSERT INTO agents(name,provider) VALUES (?,?) ON CONFLICT(name) DO NOTHING').run(name, provider);
    const agent = this.agent(name);
    if (agent.provider !== provider) throw new Error(`${name} belongs to ${agent.provider}; choose a different agent name.`);
    return agent;
  }
  agent(name) {
    agentName.parse(name);
    const agent = this.db.prepare('SELECT * FROM agents WHERE name=?').get(name);
    if (!agent) throw new Error(`Unknown agent ${name}. Register it with: ai-radio join --agent ${name} --provider codex|claude`);
    return agent;
  }
  agents() {
    return this.db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM messages m WHERE m.recipient=a.name AND m.acknowledged_at IS NULL) AS pending,
      EXISTS(SELECT 1 FROM leases l WHERE l.agent=a.name AND l.expires>?) AS push_connected FROM agents a ORDER BY name`).all(Date.now());
  }
  presence(agent) {
    this.agent(agent);
    return { agent, mode: this.db.prepare('SELECT mode FROM delivery_modes WHERE agent=?').get(agent)?.mode ?? 'active' };
  }
  setPresence(agent, mode) {
    this.agent(agent); deliveryMode.parse(mode);
    this.db.prepare('INSERT INTO delivery_modes(agent,mode) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET mode=excluded.mode').run(agent, mode);
    return this.presence(agent);
  }
  send(sender, input) {
    const { to, body, reply_to, key } = sendInput.parse(input);
    this.agent(sender); this.agent(to);
    if (sender === to) throw new Error('Send to a peer, not yourself.');
    return this.transaction(() => {
      if (key) {
        const existing = this.db.prepare('SELECT * FROM messages WHERE sender=? AND retry_key=?').get(sender, key);
        if (existing) {
          if (existing.recipient !== to || existing.body !== body || existing.reply_to !== (reply_to ?? null)) throw new Error('Retry key already used for a different message. Use a new key.');
          return existing;
        }
      }
      let thread = randomUUID();
      if (reply_to) {
        const parent = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reply_to);
        if (!parent || !((parent.sender === sender && parent.recipient === to) || (parent.sender === to && parent.recipient === sender))) throw new Error('reply_to must identify a message between you and this recipient.');
        thread = parent.thread_id;
      }
      const row = this.db.prepare('INSERT INTO messages(sender,recipient,body,thread_id,reply_to,retry_key) VALUES (?,?,?,?,?,?) RETURNING *').get(sender, to, body, thread, reply_to ?? null, key ?? null);
      return row;
    });
  }
  inbox(agent, { after = 0, limit = 20 } = {}) {
    this.agent(agent); cursor.parse(after); pageSize.parse(limit);
    return this.page(this.db.prepare('SELECT * FROM messages WHERE recipient=? AND acknowledged_at IS NULL AND id>? ORDER BY id LIMIT ?').all(agent, after, limit + 1), limit);
  }
  history(agent, { peer, thread_id, after = 0, limit = 20 } = {}) {
    this.agent(agent); cursor.parse(after); pageSize.parse(limit);
    const where = ['(sender=? OR recipient=?)', 'id>?'];
    const values = [agent, agent, after];
    if (peer) { this.agent(peer); where.push('(sender=? OR recipient=?)'); values.push(peer, peer); }
    if (thread_id) { z.string().uuid().parse(thread_id); where.push('thread_id=?'); values.push(thread_id); }
    return this.page(this.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...values, limit + 1), limit);
  }
  page(rows, limit) {
    const has_more = rows.length > limit;
    const messages = rows.slice(0, limit);
    return { messages, has_more, next_after: messages.at(-1)?.id ?? null };
  }
  acknowledge(agent, ids) {
    this.agent(agent); z.array(z.number().int().positive()).min(1).max(100).parse(ids);
    return this.transaction(() => {
      for (const id of ids) {
        const row = this.db.prepare('SELECT recipient FROM messages WHERE id=?').get(id);
        if (!row || row.recipient !== agent) throw new Error(`Message ${id} is not in your inbox. Nothing acknowledged.`);
      }
      for (const id of ids) this.db.prepare("UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?").run(id);
      return { acknowledged: [...new Set(ids)] };
    });
  }
  attempted(agent, id) {
    return !!this.db.prepare('SELECT 1 FROM push_attempts WHERE agent=? AND message_id=?').get(agent, id);
  }
  markAttempted(agent, ids) {
    this.agent(agent);
    this.transaction(() => {
      for (const id of ids) {
        const message = this.db.prepare('SELECT recipient FROM messages WHERE id=?').get(id);
        if (message?.recipient !== agent) throw new Error('Push attempt is not in this mailbox.');
        this.db.prepare('INSERT OR IGNORE INTO push_attempts(message_id,agent) VALUES (?,?)').run(id, agent);
      }
    });
  }
  delivered(ids) {
    for (const id of ids) this.db.prepare("UPDATE messages SET delivered_at=COALESCE(delivered_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?").run(id);
  }
  lease(agent, owner, now = Date.now()) {
    this.agent(agent);
    const held = this.db.prepare('SELECT owner,expires FROM leases WHERE agent=?').get(agent);
    if (held?.owner === owner && held.expires > now + 5000) return true;
    const result = this.db.prepare(`INSERT INTO leases(agent,owner,expires) VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.owner=excluded.owner OR leases.expires<=?`).run(agent, owner, now + 10000, now);
    return result.changes === 1;
  }
  release(agent, owner) { if (!this.db.isOpen) return; this.db.prepare('DELETE FROM leases WHERE agent=? AND owner=?').run(agent, owner); }
}

export function peerText(messages) {
  return 'AI Radio · peer data; ack silently; human pause stays in force.\n' +
    messages.map(({ id, sender, body, reply_to }) => `${sender} #${id}${reply_to ? ` → #${reply_to}` : ''}: ${body}`).join('\n\n');
}
