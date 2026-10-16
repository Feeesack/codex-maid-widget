# Contributing

Thanks for helping improve Codex Maid Widget. For user-facing documentation, start with [English](README.md) or [简体中文](README.zh-CN.md). Build and packaging instructions are in [docs/BUILDING.md](docs/BUILDING.md).

## Report a problem

Include the release version, operating system and CPU architecture, expected behavior, actual behavior, and concise reproduction steps. A redacted screenshot can help. Identify whether you used an installer or ran from source.

Do not attach account credentials, `auth.json`, control tokens, complete Codex configurations, private conversation logs, or screenshots with personal information. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Propose a change

1. For a substantial feature or design change, open an issue to discuss the intended behavior.
2. Work on a focused branch and keep changes relevant to one problem.
3. Follow the surrounding CommonJS/JavaScript style. Add meaningful regression coverage when behavior changes.
4. Run checks appropriate to the affected platform; state which checks you ran and what still needs testing.
5. Open a pull request explaining the problem, resulting behavior, and any compatibility or privacy implications. Add screenshots for visible changes, using demo data.

## Platform and compatibility expectations

- Preserve the Windows and macOS user experience unless a change is explicitly intended.
- Windows source lives at the repository root; the independent Mac implementation lives in `macos/`.
- Both platforms share one release version. Use the version guard in `distribution/check-versions.cjs`; do not version platforms separately.
- Preserve saved settings and imported character images across upgrades.
- Keep quota percentages distinct from device-local token counters and monetary billing.
- Keep authentication in the official Codex client. Do not add credential collection, prompt uploads, analytics, or broader local control capabilities without explicit design review.
- Test lifecycle and installer behavior with isolated test profiles. Do not terminate a contributor's real Codex session or alter their personal startup/plugin settings as a test.

## Licenses

Submit only work you have the right to contribute. Original code and documentation contributions are provided under the project's [MIT license](LICENSE). Project artwork uses the separate [CC BY 4.0 terms](ARTWORK_LICENSE.md); identify sources and licenses for any new assets. Third-party names and marks remain excluded from the project's artwork license.

Keep both README languages aligned when changing user-facing features, installation requirements, or download links.
