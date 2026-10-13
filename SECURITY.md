# Security Policy

## Supported versions

The latest published minor receives fixes. Pre-1.0, older minors are not maintained.
Unreleased local changes are listed separately in `CHANGELOG.md`.

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

- Windows is not supported; containment there is reported as unsupported rather than emulated.
- The Linux cgroup v2 driver enforces memory and process limits when delegated controllers are available. Hard CPU limits are not implemented. A driver that cannot enforce a requested hard limit rejects it at admission.
- Operation IDs do not authorize filesystem paths. Artifact creation refuses existing files and symbolic links; cleanup requires evidence of ownership. Unknown legacy files are retained by garbage collection.
- The host owns the artifact parent directory. These checks do not provide an isolation boundary against another process with the same privileges that can concurrently rename parent directories.
- The kernel executes the commands you give it. It is not a sandbox for hostile code: run untrusted input behind OS-level isolation of your own.
