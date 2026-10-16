# Security policy

## Supported release

Security fixes target the current release, **0.3.13**, and the active development branch. Update to the latest release before reporting a problem when practical.

## Report a vulnerability privately

Use this repository's **Security → Report a vulnerability** entry to submit a private vulnerability report:

[Open private security reporting](https://github.com/Feeesack/codex-maid-widget/security/advisories/new)

Describe the affected version and platform, the security impact, reproduction steps, and any proposed fix. Use synthetic examples and remove credentials, account identifiers, personal paths, private conversation text, `auth.json` contents, and local control tokens.

Do not publish exploitable details or secrets in a public issue. If GitHub private reporting is temporarily unavailable, a public issue may request a private contact channel without disclosing vulnerability details.

## Relevant boundaries

- The widget uses the official local Codex app-server for quota access. Codex manages authentication.
- Token statistics are parsed from local session-log counter events; records can include sensitive user content and should not be attached to reports in full.
- The local control interface binds to loopback and authenticates with a per-launch random token. It provides fixed widget actions.
- Plugin connection and login-helper registration change local user configuration only through their documented user actions.

Installation packages currently lack developer distribution certificates; the Mac package is not Apple-notarized. Obtain installers from this repository's [Releases](https://github.com/Feeesack/codex-maid-widget/releases) and verify the published SHA-256 checksums.
