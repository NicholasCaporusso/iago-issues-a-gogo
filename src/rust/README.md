# Rust Workspace

This directory contains the Rust implementation of IAGO.

It is split into three crates:

- `iago-shared`: common Git and repository helpers
- `iago`: the CLI binary
- `iago-server`: the server binary

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

- `dist/rust/cli/iago.exe`
- `dist/rust/server/iago-server.exe`

To build the Windows installer, also install Inno Setup and run:

```powershell
powershell -File ./build/windows/installer/build-installer.ps1
```

## CLI Behavior

The Rust CLI implements the local workflow:

- `sync`
- `list`
- `show`
- `start-issue`
- `completed`
- `report`
- `create-issue`
- `set-port`
- `about`

The CLI talks to GitHub directly when you supply a token. It also reads and updates the shared relay port from `relay-config.json` in the shared app folder above the executable.

## Server Behavior

The Rust `iago-server` keeps the process alive in both `serve` and `repl` mode until you type `quit`, `exit`, or send EOF.

On Windows, the server hides the console when you click `X` and keeps running in the background.

The REPL accepts `list`, `add`, `set-port`, and `about`.
It also accepts `client help` to show the client command reference.

`iago-server` reads `relay-config.json` in the shared app folder above the executable. Use `set-port --port <number>` to update the shared config so both the client and the server use the new port.

Launching `iago-server.exe` without arguments opens the REPL.

Vault tokens are encrypted at rest in `src/rust/server/vault/repos.json` using the compiled master key in [`src/rust/server/src/config.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/config.rs).
Existing plaintext vault entries remain readable and are converted when the vault is saved again.

## Windows Icons

Both Windows executables embed [`assets/iago-icon.ico`](/workspace/tools-github-issues-resolver/assets/iago-icon.ico).

## Installer

The Windows installer:

- installs both executables
- adds the `iago` client directory to system `PATH`
- can register `iago-server` to start when the computer starts
- installs `relay-config.json` in the shared app folder so both apps share the same port setting

## Status

The workspace is functional for the CLI build, server loop, console hide-on-close behavior, and Windows packaging.
