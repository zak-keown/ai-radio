import { z } from 'zod';

export const profileInput = z.object({
  role: z.string().trim().min(1).max(200).nullable().optional().describe('Self-advertised role; null clears it.'),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(32).optional().describe('Self-advertised skills, not verified permissions or readiness.'),
  current_task: z.string().trim().min(1).max(2000).nullable().optional().describe('Self-advertised current work; null clears it.'),
  sandbox: z.enum(['unknown', 'read-only', 'workspace-write', 'full-access']).optional().describe('Self-advertised filesystem access; does not grant permissions.'),
}).strict();

export function installDiscovery(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (
    agent TEXT PRIMARY KEY REFERENCES agents(name), role TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
    current_task TEXT, sandbox TEXT NOT NULL DEFAULT 'unknown',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
}

function profile(agent, row) {
  return {
    agent, source: 'self_advertised', role: row?.role ?? null,
    capabilities: row ? JSON.parse(row.capabilities) : [],
    current_task: row?.current_task ?? null, sandbox: row?.sandbox ?? 'unknown',
    updated_at: row?.updated_at ?? null,
  };
}

export function getProfile(store, agent) {
  store.agent(agent);
  return profile(agent, store.db.prepare('SELECT * FROM agent_profiles WHERE agent=?').get(agent));
}

export function updateProfile(store, agent, input) {
  const changes = Object.fromEntries(Object.entries(profileInput.parse(input)).filter(([, value]) => value !== undefined));
  store.agent(agent);
  if (Object.keys(changes).length === 0) return getProfile(store, agent);
  return store.transaction(() => {
    const previous = getProfile(store, agent);
    const next = { ...previous, ...changes };
    store.db.prepare(`INSERT INTO agent_profiles(agent,role,capabilities,current_task,sandbox) VALUES (?,?,?,?,?)
      ON CONFLICT(agent) DO UPDATE SET role=excluded.role,capabilities=excluded.capabilities,
      current_task=excluded.current_task,sandbox=excluded.sandbox,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(agent, next.role, JSON.stringify([...new Set(next.capabilities)]), next.current_task, next.sandbox);
    return getProfile(store, agent);
  });
}

export function listAgents(store) {
  const now = Date.now();
  const agents = store.db.prepare(`SELECT a.*,
    (SELECT COUNT(*) FROM messages m WHERE m.recipient=a.name AND m.acknowledged_at IS NULL) AS pending,
    COALESCE(d.mode,'active') AS delivery_mode,l.expires AS lease_expires,
    p.role,p.capabilities,p.current_task,p.sandbox,p.updated_at AS profile_updated_at
    FROM agents a LEFT JOIN delivery_modes d ON d.agent=a.name
    LEFT JOIN leases l ON l.agent=a.name LEFT JOIN agent_profiles p ON p.agent=a.name ORDER BY a.name`).all();
  return agents.map(row => {
    const connected = row.lease_expires !== null && row.lease_expires > now;
    return {
      name: row.name, provider: row.provider, created_at: row.created_at, pending: row.pending,
      delivery_mode: row.delivery_mode, push_connected: connected,
      advertised: profile(row.name, row.profile_updated_at === null ? undefined : { ...row, updated_at: row.profile_updated_at }),
      observed: {
        push_connected: connected,
        session_freshness: connected ? 'leased' : row.lease_expires === null ? 'disconnected' : 'expired',
        lease_expires_at: row.lease_expires === null ? null : new Date(row.lease_expires).toISOString(),
      },
    };
  });
}
