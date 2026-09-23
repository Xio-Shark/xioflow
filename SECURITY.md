# Security Policy

## Supported versions

The latest `0.1.x` release receives fixes. Pre-1.0, older minors are not maintained.

## Reporting a vulnerability

Please use GitHub's private reporting: **Security → Report a vulnerability** on <https://github.com/Xio-Shark/xioflow>. Do not open a public issue for an unfixed vulnerability.

Include, when you can:

- kernel version, Node version, OS;
- the sequence that reaches the problem (a minimal script if possible);
- whether it involves process containment, lease release, crash recovery, or the store;
- what you expected versus what happened.

This is a spare-time project, so there is no guaranteed response time. Reports about the kernel's core claims get priority: an operation reported as stopped while a process survives, a lease released before a stop is confirmed, a committed fact lost across a crash, or `indeterminate` being silently retried.

## Verifying what you install

Releases are built and published only by `.github/workflows/release.yml`; no long-lived npm token exists for this package. From 0.1.5 on:

- the npm package carries an npm provenance attestation (`npm audit signatures`);
- each GitHub Release carries a tarball packed in CI from the same tagged commit, `SHA256SUMS`, and a GitHub build provenance attestation (`gh attestation verify xioflow-kernel-<version>.tgz --repo Xio-Shark/xioflow`). It is packed separately from the npm upload, so compare file contents rather than tarball bytes.

0.1.0 – 0.1.4 were uploaded from a local token and have no provenance.

## Scope notes

- Windows is not supported in 0.1 and containment there is reported as unsupported rather than emulated.
- Hard resource enforcement (cgroup v2 memory/CPU/PID limits) is not implemented yet; requesting `enforcement: 'hard'` for those on a driver without the capability is rejected at admission by design.
- The kernel executes the commands you give it. It is not a sandbox for hostile code: run untrusted input behind OS-level isolation of your own.
