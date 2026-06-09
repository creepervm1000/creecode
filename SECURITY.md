# Security Policy

## Supported Versions

CreeCode follows a rolling release model. Only the latest commit on `main` is supported with security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue.

instead, contact me via my email address: `creeper@creepernet.qzz.io`.

Please include:

- A description of the vulnerability
- Steps to reproduce
- The version / commit hash affected
- Any suggested mitigation

We aim to acknowledge reports within 72 hours and to publish a fix or mitigation within 14 days
where feasible.

## Security Hardening Notes

- CreeCode prompts for permission before running shell commands or accessing files outside the
  workspace, governed by the `trust` configuration.
- Provider API keys are stored in `~/.creecode/config.json` and should be kept readable only by
  the local user (`chmod 600`).
- The web UI binds to `localhost` by default. Do not expose it to a public network without
  adding authentication.
