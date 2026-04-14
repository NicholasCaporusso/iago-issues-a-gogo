# Rust Workspace

This directory contains the Rust implementation of the project.

It is split into three crates:
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

## CLI behavior

The Rust CLI now implements the main local workflow:
- `sync`
- `list`
- `show`
- `start-issue`
- `completed`
- `report`
- `create-issue`

The CLI talks to GitHub directly when you supply a token.

## Server behavior

The Rust relay server currently keeps the process alive in both `serve` and `repl` mode until you type `quit`, `exit`, or send EOF. The REPL accepts `list` and `add`.

## Status

The workspace is functional for the CLI build and server loop, and it is ready for the rest of the relay translation.
