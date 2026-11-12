# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the Security tab). Do not open a public issue. You should get a response within 7 days.

## Design notes

- WhatsApp sessions are stored only on the user's machine (`~/.whatsapp-bridge`) and never transmitted.
- Logs go to stderr and redact message text and phone numbers.
- Inbound messages are returned to the model as untrusted data to mitigate prompt injection.
- CI: the canary session is AES-256-GCM encrypted. The autonomous repair agent runs without push credentials, and a protected-path guard limits what it can change.
