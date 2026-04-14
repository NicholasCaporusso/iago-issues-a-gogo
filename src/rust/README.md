# Rust Workspace

This directory contains the Rust workspace that will replace the Node implementation.

It is currently scaffolded into three crates:
- `shared`: common Git and repository helpers
- `github-issues-resolver`: the CLI binary
- `issues-relay-server`: the relay server binary

## Layout

- `src/rust/shared`
- `src/rust/cli`
- `src/rust/server`

## Build

After installing Rust, build the Windows executables from the repository root:

```powershell
powershell -File ./build/rust/cli/build-windows-exe.ps1
powershell -File ./build/rust/server/build-windows-exe.ps1
```

The build scripts place the finished executables in:
- `dist/rust/cli/github-issues-resolver.exe`
- `dist/rust/server/issues-relay-server.exe`

## Status

The workspace is intentionally small and ready for the full Rust translation of the current Node behavior.
