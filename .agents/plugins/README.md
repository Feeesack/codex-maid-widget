# Windows source marketplace

`marketplace.json` describes the repository-local source plugin for the Windows project. Its `source.path` is resolved from the **repository root**, so `./plugins/codex-maid-widget` points to the root plugin directory, not to this `.agents/plugins` directory.

For a packaged application, use the installed connector instead; it prepares a separate local plugin source using the bundled runtime.

- [Source plugin instructions](../../plugins/codex-maid-widget/README.md)
- [Installer and connection instructions](../../docs/INSTALLATION.md)

Do not commit generated absolute paths, personal Codex configuration, credentials, or local control tokens. The source marketplace is optional and does not imply publication in a hosted plugin catalog.
