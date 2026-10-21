# Contributing

Use Node.js 24 or later on macOS or Linux. Install dependencies and run the
checks from a checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

The automated tests use temporary projects and a fake Codex app-server; they do
not need model credentials or modify your normal agent configuration. Live
provider verification is described in [the installation guide](docs/INSTALL.md).

Keep messages, SQLite databases, local agent configuration, credentials, and
machine-specific paths out of commits. `.ai-radio/`, `.mcp.json`, `.claude/`,
`.codex/`, and environment files are ignored. Use invented examples when
reporting a bug; message history can contain private project information.

There is no automatic npm release. `private: true` prevents an accidental npm
publish while the GitHub source repository is being prepared.
