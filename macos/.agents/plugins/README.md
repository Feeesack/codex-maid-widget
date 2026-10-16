# macOS source marketplace

`marketplace.json` describes the repository-local source plugin for the Mac project. Its `source.path` is resolved from the **`macos` project root**, so `./plugins/codex-maid-widget` points to `macos/plugins/codex-maid-widget`, not to this `.agents/plugins` directory.

Register the Mac project directory when using this source marketplace. For a packaged application, use the installed connector instead; it prepares a separate local plugin source using the bundled runtime.

- [Mac source plugin instructions](../../plugins/codex-maid-widget/README.md)
- [Installer and connection instructions](../../../docs/INSTALLATION.md)

Do not commit generated absolute paths, personal Codex configuration, credentials, or local control tokens. The source marketplace is optional and does not imply publication in a hosted plugin catalog.
