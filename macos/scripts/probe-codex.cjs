'use strict';

// Safe diagnostics: prints only the sanitized quota snapshot, never raw RPC payloads,
// account email/IDs, configuration, auth.json or session message contents.
const { CodexDataSource } = require('../src/codex-data.cjs');

(async () => {
  const source = new CodexDataSource({ codexPath: process.env.CODEX_WIDGET_CLI || undefined });
  try {
    const snapshot = await source.read();
    console.log(JSON.stringify(snapshot, null, 2));
    if (snapshot.status === 'offline') process.exitCode = 1;
  } finally { source.close(); }
})().catch(() => { console.error('额度探测失败。请确认 Codex CLI 可用。'); process.exitCode = 1; });
