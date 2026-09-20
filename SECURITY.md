# Security policy

## Supported versions

Security fixes target the latest release and the current `main` branch.

## Report a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/socai-io/jev-social/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected version, reproduction steps, impact, and a minimal proof of concept when possible. Remove API keys, cookies, browser profiles, captured social data, and other personal information before submitting.

Jev Social starts a loopback-only local server and launches the socai CLI. Reports involving command construction, local file access, secret exposure, unsafe remote-browser routing, or untrusted media rendering are especially useful.
