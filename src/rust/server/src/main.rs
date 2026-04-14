mod config;
#[cfg(target_os = "windows")]
mod windows_app;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use config::MASTER_ENCRYPTION_KEY;
use iago_shared::{
    backlog_path,
    default_relay_host,
    find_git_root,
    parse_git_hub_remote,
    normalize_repository_remote,
    read_relay_port,
    read_backlog,
    relay_config_path,
    write_relay_port,
    workspace_banner,
    Backlog,
    Issue,
    write_backlog,
};
use getrandom::fill as random_fill;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "serve".to_owned());
    let relay_port = read_relay_port()?;

    if matches!(command.as_str(), "--help" | "-h") {
        print_help(relay_port)?;
        return Ok(());
    }

    let remaining_args: Vec<String> = args.collect();

    match command.as_str() {
        "serve" => {
            let options = parse_server_options(&remaining_args, relay_port)?;
            #[cfg(target_os = "windows")]
            {
                run_windows_server_mode(options, relay_port, false)?;
            }
            #[cfg(not(target_os = "windows"))]
            {
                let server = start_http_server(&options.host, options.port, &options.vault_path)?;
                println!("{}", workspace_banner("iago-server serve"));
                println!(
                    "Listening on http://{}:{}",
                    options.host, options.port
                );
                run_repl_loop("iago-server> ", &options.vault_path, Some(&server), relay_port)?;
                server.stop();
            }
        }
        "repl" => {
            let options = parse_server_options(&remaining_args, relay_port)?;
            #[cfg(target_os = "windows")]
            {
                run_windows_server_mode(options, relay_port, true)?;
            }
            #[cfg(not(target_os = "windows"))]
            {
                println!("{}", workspace_banner("iago-server repl"));
                run_repl_loop("iago-server> ", &options.vault_path, None, relay_port)?;
            }
        }
        "list" => {
            let options = parse_server_options(&remaining_args, relay_port)?;
            print_vault_entries(&options.vault_path)?;
        }
        "add" => {
            let options = parse_add_repo_options(&remaining_args, default_vault_path(), false)?;
            add_repo_command(&options)?;
        }
            "set-port" => {
                let options = parse_server_options(&remaining_args, relay_port)?;
                set_port_command(&options)?;
            }
        other => {
            return Err(format!("Unsupported command: {other}"));
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn run_windows_server_mode(
    options: ServerOptions,
    relay_port: u16,
    open_repl: bool,
) -> Result<(), String> {
    let server = start_http_server(&options.host, options.port, &options.vault_path)?;
    println!(
        "{}",
        workspace_banner(if open_repl {
            "iago-server repl"
        } else {
            "iago-server serve"
        })
    );
    println!(
        "Listening on http://{}:{}",
        options.host, options.port
    );

    let state = Arc::new(windows_app::TrayState {
        vault_path: options.vault_path.clone(),
        default_port: relay_port,
        quit: Arc::new(AtomicBool::new(false)),
        repl_active: Arc::new(AtomicBool::new(false)),
    });

    let tray_thread = windows_app::start_tray_controller(Arc::clone(&state))?;

    if open_repl {
        let interactive_console = io::stdin().is_terminal() && io::stdout().is_terminal();
        if interactive_console {
            windows_app::show_console_and_spawn_repl(Arc::clone(&state), true, true)?;
        } else {
            run_repl_loop("iago-server> ", &options.vault_path, None, relay_port)?;
            state.quit.store(true, Ordering::SeqCst);
        }
    }

    wait_for_quit(&state.quit);
    server.stop();
    let _ = tray_thread.join();
    Ok(())
}

fn wait_for_quit(flag: &Arc<AtomicBool>) {
    while !flag.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }
}

#[derive(Debug, Clone)]
struct ServerOptions {
    host: String,
    port: u16,
    port_provided: bool,
    vault_path: PathBuf,
}

struct RelayServerHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug, Clone)]
struct AddRepoOptions {
    vault_path: PathBuf,
    repository_url: Option<String>,
    folder: Option<String>,
    token: Option<String>,
    interactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Vault {
    #[serde(default)]
    repos: Vec<VaultRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct VaultRepo {
    folder: String,
    repository_url: String,
    token: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

fn parse_server_options(argv: &[String], default_port: u16) -> Result<ServerOptions, String> {
    let mut host = default_relay_host().to_owned();
    let mut port = default_port;
    let mut port_provided = false;
    let mut vault_path = default_vault_path();
    let mut index = 0;

    while index < argv.len() {
        match argv[index].as_str() {
            "--host" => {
                index += 1;
                host = require_value(argv, index, "--host")?;
            }
            "--port" => {
                index += 1;
                port = parse_port(&require_value(argv, index, "--port")?)?;
                port_provided = true;
            }
            "--vault" => {
                index += 1;
                vault_path = PathBuf::from(require_value(argv, index, "--vault")?);
            }
            "--help" | "-h" => {
                return Ok(ServerOptions {
                    host,
                    port,
                    port_provided,
                    vault_path,
                });
            }
            value => {
                return Err(format!("Unknown argument: {value}"));
            }
        }

        index += 1;
    }

    Ok(ServerOptions {
        host,
        port,
        port_provided,
        vault_path,
    })
}

fn parse_add_repo_options(
    argv: &[String],
    default_vault_path: PathBuf,
    interactive: bool,
) -> Result<AddRepoOptions, String> {
    let mut options = AddRepoOptions {
        vault_path: default_vault_path,
        repository_url: None,
        folder: None,
        token: None,
        interactive,
    };
    let mut index = 0;

    while index < argv.len() {
        match argv[index].as_str() {
            "--vault" => {
                index += 1;
                options.vault_path = PathBuf::from(require_value(argv, index, "--vault")?);
            }
            "--url" => {
                index += 1;
                options.repository_url = Some(require_value(argv, index, "--url")?);
            }
            "--folder" => {
                index += 1;
                options.folder = Some(require_value(argv, index, "--folder")?);
            }
            "--token" => {
                index += 1;
                options.token = Some(require_value(argv, index, "--token")?);
            }
            "--help" | "-h" => {
                return Ok(options);
            }
            value => {
                return Err(format!("Unknown argument: {value}"));
            }
        }

        index += 1;
    }

    Ok(options)
}

fn require_value(argv: &[String], index: usize, flag_name: &str) -> Result<String, String> {
    let value = argv.get(index).cloned();

    match value {
        Some(value) if !value.starts_with("--") => Ok(value),
        _ => Err(format!("Missing value for {flag_name}.")),
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("Invalid port: {value}"))?;

    if port == 0 {
        return Err(format!("Invalid port: {value}"));
    }

    Ok(port)
}

fn default_vault_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vault")
        .join("repos.json")
}

impl RelayServerHandle {
    fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn start_http_server(host: &str, port: u16, vault_path: &Path) -> Result<RelayServerHandle, String> {
    let listener = TcpListener::bind((host, port))
        .map_err(|error| format!("Failed to bind http://{host}:{port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure listener: {error}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let vault_path = vault_path.to_path_buf();
    let thread = thread::spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let vault_path = vault_path.clone();
                    thread::spawn(move || {
                        if let Err(error) = handle_http_connection(stream, &vault_path) {
                            eprintln!("{error}");
                        }
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    eprintln!("Relay server accept error: {error}");
                    break;
                }
            }
        }
    });

    Ok(RelayServerHandle {
        stop,
        thread: Some(thread),
    })
}

fn handle_http_connection(mut stream: TcpStream, vault_path: &Path) -> Result<(), String> {
    let mut reader = io::BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("Failed to clone stream: {error}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| format!("Failed to read request line: {error}"))?;

    if request_line.trim().is_empty() {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut content_length = 0usize;

    loop {
        let mut header_line = String::new();
        reader
            .read_line(&mut header_line)
            .map_err(|error| format!("Failed to read request header: {error}"))?;
        let trimmed = header_line.trim_end_matches(['\r', '\n']);

        if trimmed.is_empty() {
            break;
        }

        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("Failed to read request body: {error}"))?;
    }

    let response = match (method, path) {
        ("GET", "/health") => http_json_response(200, serde_json::json!({ "ok": true })),
        ("POST", "/sync") => {
            match serde_json::from_slice::<SyncRelayRequest>(&body) {
                Ok(payload) => match handle_sync_relay(payload, vault_path) {
                    Ok(result) => http_json_response(
                        200,
                        serde_json::to_value(result).map_err(|error| error.to_string())?,
                    ),
                    Err(error) => http_json_response(400, serde_json::json!({ "error": error })),
                },
                Err(error) => http_json_response(400, serde_json::json!({
                    "error": format!("Request body must be valid JSON: {error}")
                })),
            }
        }
        _ => http_json_response(404, serde_json::json!({ "error": "Not found." })),
    };

    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("Failed to write response: {error}"))?;
    Ok(())
}

fn http_json_response(status: u16, body: serde_json::Value) -> String {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body_text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".to_owned());
    format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_text}",
        body_text.len()
    )
}

fn run_repl_loop(
    prompt: &str,
    vault_path: &Path,
    _server: Option<&RelayServerHandle>,
    default_port: u16,
) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut input = String::new();

    println!("Type 'help' for commands, or 'quit' to exit.");

    loop {
        input.clear();
        write!(stdout, "{prompt}").map_err(|error| error.to_string())?;
        stdout.flush().map_err(|error| error.to_string())?;

        let bytes_read = stdin
            .lock()
            .read_line(&mut input)
            .map_err(|error| error.to_string())?;

        if bytes_read == 0 {
            break;
        }

        let trimmed = input.trim();

        if trimmed.is_empty() {
            continue;
        }

        let tokens = split_command_line(trimmed);
        let command = tokens.first().cloned().unwrap_or_default();
        let command_args = tokens.into_iter().skip(1).collect::<Vec<_>>();

        match command.as_str() {
            "quit" | "exit" => break,
            "help" => print_repl_help(default_port),
            "list" => print_vault_entries(vault_path)?,
            "add" => {
                let options = parse_add_repo_options(&command_args, vault_path.to_path_buf(), true)?;
                add_repo_command(&options)?;
            }
            "set-port" => {
                let port = parse_repl_port(&command_args)?;
                set_port_command(&ServerOptions {
                    host: default_relay_host().to_owned(),
                    port,
                    port_provided: true,
                    vault_path: vault_path.to_path_buf(),
                })?;
            }
            other => println!("Unknown command: {other}"),
        }
    }

    Ok(())
}

fn split_command_line(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = '\0';

    for ch in input.chars() {
        match ch {
            '"' | '\'' if !in_quotes => {
                in_quotes = true;
                quote_char = ch;
            }
            ch if in_quotes && ch == quote_char => {
                in_quotes = false;
            }
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn parse_repl_port(args: &[String]) -> Result<u16, String> {
    if args.first().map(|value| value.as_str()) == Some("--port") {
        let value = require_value(args, 1, "--port")?;
        return parse_port(&value);
    }

    let value = args
        .first()
        .ok_or_else(|| "The set-port command requires a port number.".to_owned())?;
    parse_port(value)
}

fn print_vault_entries(vault_path: &Path) -> Result<(), String> {
    let vault = read_vault(vault_path)?;

    if vault.repos.is_empty() {
        println!("No repositories are stored in the vault.");
        return Ok(());
    }

    for repo in vault.repos {
        let token_note = if repo.token.trim().is_empty() {
            " (no token)".to_owned()
        } else {
            " (token stored)".to_owned()
        };

        println!("- {} -> {}{}", repo.repository_url, repo.folder, token_note);
    }

    Ok(())
}

fn add_repo_command(options: &AddRepoOptions) -> Result<(), String> {
    let repository_url = match options.repository_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_owned(),
        None if options.interactive => prompt_value("Repository URL: ")?,
        None => {
            return Err("The add command requires --url <repository-url>.".to_owned());
        }
    };

    let folder = match options.folder.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_owned(),
        None if options.interactive => prompt_value("Repository folder: ")?,
        None => {
            return Err("The add command requires --folder <repository-folder>.".to_owned());
        }
    };

    let token = match options.token.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_owned(),
        None if options.interactive => prompt_value("GitHub token: ")?,
        None => {
            return Err("The add command requires --token <github-token>.".to_owned());
        }
    };

    store_repo(&options.vault_path, &repository_url, &folder, &token)?;
    println!(
        "Stored {} -> {}",
        normalize_repository_remote(&repository_url),
        find_git_root(Path::new(&folder))?.display()
    );
    Ok(())
}

fn set_port_command(options: &ServerOptions) -> Result<(), String> {
    if !options.port_provided {
        return Err("The set-port command requires --port <number>.".to_owned());
    }

    let config_path = write_relay_port(options.port)?;
    println!(
        "Relay port updated to {} in {}",
        options.port,
        config_path.display()
    );
    println!("Restart the relay server for the new port to take effect.");
    Ok(())
}

fn prompt_value(prompt: &str) -> Result<String, String> {
    let mut stdout = io::stdout();
    let mut input = String::new();

    write!(stdout, "{prompt}").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())?;
    io::stdin()
        .read_line(&mut input)
        .map_err(|error| error.to_string())?;

    let value = input.trim().to_owned();
    if value.is_empty() {
        return Err("Input cannot be empty.".to_owned());
    }

    Ok(value)
}

fn store_repo(
    vault_path: &Path,
    repository_url: &str,
    folder: &str,
    token: &str,
) -> Result<(), String> {
    let repo_root = find_git_root(Path::new(folder))?;
    let normalized_url = normalize_repository_remote(repository_url);
    let mut vault = read_vault(vault_path)?;
    let now = Some(iso_timestamp());
    let next_record = VaultRepo {
        folder: repo_root.display().to_string(),
        repository_url: normalized_url,
        token: token.to_owned(),
        created_at: now.clone(),
        updated_at: now,
    };

    if let Some(index) = vault.repos.iter().position(|repo| {
        repo.repository_url == next_record.repository_url || Path::new(&repo.folder) == repo_root
    }) {
        let created_at = vault.repos[index].created_at.clone();
        vault.repos[index] = VaultRepo {
            created_at,
            ..next_record
        };
    } else {
        vault.repos.push(next_record);
    }

    write_vault(vault_path, &vault)
}

fn iso_timestamp() -> String {
    let now = std::time::SystemTime::now();
    let datetime = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{datetime}")
}

fn read_vault(vault_path: &Path) -> Result<Vault, String> {
    match fs::read_to_string(vault_path) {
        Ok(contents) => {
            let vault: Vault = serde_json::from_str(&contents)
                .map_err(|error| format!("Failed to parse {}: {error}", vault_path.display()))?;
            decrypt_vault(vault)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vault::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", vault_path.display())),
    }
}

fn write_vault(vault_path: &Path, vault: &Vault) -> Result<(), String> {
    if let Some(parent) = vault_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let encrypted_vault = encrypt_vault(vault)?;
    let contents = serde_json::to_string_pretty(&encrypted_vault)
        .map_err(|error| format!("Failed to serialize vault: {error}"))?;
    fs::write(vault_path, format!("{contents}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", vault_path.display()))
}

fn decrypt_vault(vault: Vault) -> Result<Vault, String> {
    let mut repos = Vec::with_capacity(vault.repos.len());

    for repo in vault.repos {
        repos.push(decrypt_vault_repo(repo)?);
    }

    Ok(Vault { repos })
}

fn encrypt_vault(vault: &Vault) -> Result<Vault, String> {
    let mut repos = Vec::with_capacity(vault.repos.len());

    for repo in &vault.repos {
        repos.push(encrypt_vault_repo(repo)?);
    }

    Ok(Vault { repos })
}

fn decrypt_vault_repo(mut repo: VaultRepo) -> Result<VaultRepo, String> {
    repo.token = decrypt_vault_token(&repo.token)?;
    Ok(repo)
}

fn encrypt_vault_repo(repo: &VaultRepo) -> Result<VaultRepo, String> {
    let mut repo = repo.clone();
    repo.token = encrypt_vault_token(&repo.token)?;
    Ok(repo)
}

fn encrypt_vault_token(token: &str) -> Result<String, String> {
    if token.trim().is_empty() {
        return Ok(String::new());
    }

    let mut nonce_bytes = [0u8; 12];
    random_fill(&mut nonce_bytes).map_err(|error| format!("Failed to generate vault nonce: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&MASTER_ENCRYPTION_KEY)
        .map_err(|error| format!("Failed to initialize vault encryption: {error}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, token.as_bytes())
        .map_err(|error| format!("Failed to encrypt vault token: {error}"))?;

    Ok(format!(
        "enc:v1:{}:{}",
        hex_encode(&nonce_bytes),
        hex_encode(&ciphertext)
    ))
}

fn decrypt_vault_token(token: &str) -> Result<String, String> {
    let Some(payload) = token.strip_prefix("enc:v1:") else {
        return Ok(token.to_owned());
    };

    let mut parts = payload.splitn(2, ':');
    let nonce_hex = parts
        .next()
        .ok_or_else(|| "Encrypted vault token is missing the nonce.".to_owned())?;
    let ciphertext_hex = parts
        .next()
        .ok_or_else(|| "Encrypted vault token is missing the ciphertext.".to_owned())?;
    let nonce_bytes = hex_decode(nonce_hex)
        .map_err(|error| format!("Invalid encrypted vault nonce: {error}"))?;
    if nonce_bytes.len() != 12 {
        return Err(format!(
            "Invalid encrypted vault nonce length: expected 12 bytes, found {}.",
            nonce_bytes.len()
        ));
    }

    let ciphertext = hex_decode(ciphertext_hex)
        .map_err(|error| format!("Invalid encrypted vault ciphertext: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(&MASTER_ENCRYPTION_KEY)
        .map_err(|error| format!("Failed to initialize vault encryption: {error}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|error| format!("Failed to decrypt vault token: {error}"))?;

    String::from_utf8(plaintext).map_err(|error| format!("Vault token is not valid UTF-8: {error}"))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);

    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }

    output
}

fn hex_decode(input: &str) -> Result<Vec<u8>, String> {
    if input.len() % 2 != 0 {
        return Err("hex string length must be even".to_owned());
    }

    let mut bytes = Vec::with_capacity(input.len() / 2);
    let chars: Vec<char> = input.chars().collect();

    for index in (0..chars.len()).step_by(2) {
        let hex = [chars[index], chars[index + 1]];
        let value = u8::from_str_radix(&hex.iter().collect::<String>(), 16)
            .map_err(|error| format!("invalid hex byte '{}{}': {error}", hex[0], hex[1]))?;
        bytes.push(value);
    }

    Ok(bytes)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRelayRequest {
    #[serde(default)]
    remote: Option<String>,
    repository_folder: String,
    repository_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubIssueApi {
    number: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    user: Option<GitHubUser>,
    #[serde(default)]
    labels: Vec<GitHubLabel>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct GitHubLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelaySyncResponse {
    #[serde(flatten)]
    backlog: Backlog,
    ok: bool,
    repository_folder: String,
    repository_url: String,
}

fn handle_sync_relay(payload: SyncRelayRequest, vault_path: &Path) -> Result<RelaySyncResponse, String> {
    let repository_folder = find_git_root(Path::new(&payload.repository_folder))?;
    let repository_url = normalize_repository_remote(&payload.repository_url);
    let vault = read_vault(vault_path)?;
    let repo = vault
        .repos
        .into_iter()
        .find(|entry| normalize_repository_remote(&entry.repository_url) == repository_url && Path::new(&entry.folder) == repository_folder)
        .ok_or_else(|| {
            format!(
                "Repository is not registered in the relay vault: {repository_url} ({})",
                repository_folder.display()
            )
        })?;

    let remote_name = payload.remote.unwrap_or_else(|| "origin".to_owned());
    let repository = parse_git_hub_remote(&repo.repository_url)?;
    let backlog = sync_issues_from_repository(
        &repository,
        &repo.token,
        &remote_name,
        &repository_url,
        &repository_folder,
    )?;

    Ok(RelaySyncResponse {
        backlog,
        ok: true,
        repository_folder: repo.folder,
        repository_url: repo.repository_url,
    })
}

fn sync_issues_from_repository(
    repository: &iago_shared::RepositoryInfo,
    token: &str,
    remote_name: &str,
    remote_url: &str,
    repo_root: &Path,
) -> Result<Backlog, String> {
    let client = github_client(token)?;
    let existing_backlog = read_backlog(backlog_path(repo_root))?;
    let issues = fetch_open_issues(&client, repository, token, existing_backlog, remote_name, remote_url)?;
    let backlog = Backlog {
        repository: Some(format!("{}/{}", repository.owner, repository.repo)),
        host: Some(repository.host.clone()),
        remote: Some(remote_name.to_owned()),
        remote_url: Some(remote_url.to_owned()),
        issue_count: issues.len(),
        issues,
    };

    write_backlog(backlog_path(repo_root), &backlog)?;
    Ok(backlog)
}

fn github_client(token: &str) -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
    headers.insert(USER_AGENT, HeaderValue::from_static("iago"));
    let auth_value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|error| format!("Invalid GitHub token header: {error}"))?;
    headers.insert(AUTHORIZATION, auth_value);

    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))
}

fn fetch_open_issues(
    client: &Client,
    repository: &iago_shared::RepositoryInfo,
    token: &str,
    existing_backlog: Backlog,
    remote_name: &str,
    remote_url: &str,
) -> Result<Vec<Issue>, String> {
    let mut issues = Vec::new();
    let mut page = 1usize;
    let existing_issues = existing_backlog
        .issues
        .into_iter()
        .map(|issue| (issue.number, issue))
        .collect::<std::collections::BTreeMap<_, _>>();

    loop {
        let url = format!(
            "{}/repos/{}/{}/issues?state=open&per_page=100&page={page}",
            repository.api_base_url, repository.owner, repository.repo
        );

        let response = client
            .get(url)
            .send()
            .map_err(|error| build_repository_fetch_error("fetch issues", error, repository, remote_name, remote_url))?;

        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            let body = response.text().unwrap_or_default();
            return Err(format!("Authentication failed or rate limit exceeded: {body}"));
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            return Err(build_repository_api_error(
                "fetch issues",
                repository,
                remote_name,
                remote_url,
                !token.trim().is_empty(),
                status,
                body,
            ));
        }

        let page_items: Vec<GitHubIssueApi> = response
            .json()
            .map_err(|error| format!("Failed to decode GitHub response: {error}"))?;
        let has_more = page_items.len() >= 100;

        for item in page_items.into_iter().filter(|item| item.pull_request.is_none()) {
            if let Some(existing) = existing_issues.get(&item.number) {
                if existing.updated_at == item.updated_at {
                    issues.push(existing.clone());
                    continue;
                }
            }

            issues.push(Issue {
                number: item.number,
                title: item.title,
                description: item.body,
                state: item.state,
                labels: item.labels.into_iter().map(|label| label.name).collect(),
                html_url: item.html_url,
                created_at: item.created_at,
                updated_at: item.updated_at,
                author: item.user.and_then(|user| user.login),
            });
        }

        if !has_more {
            break;
        }

        page += 1;
    }

    Ok(issues)
}

fn build_repository_api_error(
    action: &str,
    repository: &iago_shared::RepositoryInfo,
    remote_name: &str,
    remote_url: &str,
    token_present: bool,
    status: u16,
    body: String,
) -> String {
    let remote_label = format!("{remote_name} ({remote_url})");
    let repo_name = format!("{}/{}", repository.owner, repository.repo);
    let reason = if body.trim().is_empty() {
        format!("GitHub API returned {status}.")
    } else {
        body
    };

    if status == 404 {
        let auth_hint = if token_present {
            "The remote may be wrong, the repository may not exist, or issues may be disabled."
        } else {
            "If this repository is private, GitHub returns 404 unless you provide a token."
        };

        return format!(
            "Failed to {action} from {remote_label} for {repo_name}: {reason}. {auth_hint}"
        );
    }

    format!("Failed to {action} from {remote_label}: {reason}")
}

fn build_repository_fetch_error(
    action: &str,
    error: reqwest::Error,
    repository: &iago_shared::RepositoryInfo,
    remote_name: &str,
    remote_url: &str,
) -> String {
    let remote_label = format!("{remote_name} ({remote_url})");
    let repo_name = format!("{}/{}", repository.owner, repository.repo);
    let cause_message = error.to_string();
    format!(
        "Failed to {action} from {remote_label} for {repo_name}: {cause_message}. Check network connectivity, authentication, and repository configuration."
    )
}

fn print_repl_help(default_port: u16) {
    let vault_path = default_vault_path();
    let config_path = relay_config_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "relay-config.json".to_owned());
    println!(
        "Commands:\n\
  help      Show this help.\n\
  list      list [--vault <path>]\n\
            Show repositories currently stored in the vault.\n\
  add       add --url <repository-url> --folder <repository-folder> --token <github-token> [--vault <path>]\n\
            Add or update a repository in the vault.\n\
  set-port  set-port <port>\n\
            Update the shared relay config with a new server port.\n\
  quit      Leave the REPL.\n\
  exit      Same as quit.\n\n\
Shared relay config:"
    );
    println!("  {}", config_path);
    println!("  Default port: {}", default_port);
    println!("Default vault:");
    println!("  {}", vault_path.display());
}

fn print_help(default_port: u16) -> Result<(), String> {
    let vault_path = default_vault_path();
    let config_path = relay_config_path()?;
    println!(
        "iago-server\n\n\
Usage:\n\
  iago-server serve [--host 127.0.0.1] [--port <port>] [--vault <path>]\n\
  iago-server repl [--vault <path>]\n\
  iago-server list [--vault <path>]\n\
  iago-server add --url <repository-url> --folder <repository-folder> --token <github-token> [--vault <path>]\n\
  iago-server set-port --port <port>\n\n\
Shared relay config:"
    );
    println!("  {}", config_path.display());
    println!("  Default port: {}", default_port);
    println!("Default vault:");
    println!("  {}", vault_path.display());
    Ok(())
}
