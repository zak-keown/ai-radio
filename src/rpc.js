import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// Codex app-server speaks newline-delimited JSON-RPC over a private child pipe.
export class Rpc extends EventEmitter {
  constructor(child, timeout = 30000) {
    super();
    this.child = child;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('diagnostic', `Invalid app-server JSON: ${line.slice(0, 200)}`); return; }
      if (message.method) {
        if (message.id !== undefined) this.emit('request', message);
        else this.emit('notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    child.on('error', error => this.shutdown(error));
    child.on('exit', (code, signal) => this.shutdown(new Error(`Codex app-server exited (${signal ?? code}). Pending mail stays in SQLite.`)));
    child.stdin.on('error', error => this.shutdown(error));
  }
  write(message) {
    if (this.closed) throw new Error('Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery may have been accepted. Pending mail is retained.`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  shutdown(error = new Error('Codex connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  close() { this.shutdown(); this.lines.close(); this.child.stdin.end(); this.child.kill(); }
}
