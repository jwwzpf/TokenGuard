# Security Policy

## Supported versions

Token Guard is currently pre-1.0. Security fixes will be released in the latest published version.

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.


Please include:

- affected version
- operating system
- reproduction steps
- potential impact
- whether code or prompt data could be exposed

## Security model

Token Guard is designed to be:

- local-first
- no daemon
- no cloud backend
- no telemetry
- no code upload
- project-scoped by default

Token Guard stores its working files in the visible `TokenGuard/` folder inside each project.