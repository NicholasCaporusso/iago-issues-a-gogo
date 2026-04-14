use github_issues_resolver_shared::{
    default_relay_host,
    default_relay_port,
    default_relay_url,
    workspace_banner,
};
use std::env;
use std::process::ExitCode;

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

    if matches!(command.as_str(), "--help" | "-h") {
        print_help();
        return Ok(());
    }

    match command.as_str() {
        "serve" => {
            println!("{}", workspace_banner("issues-relay-server serve"));
            println!(
                "Listening on http://{}:{} (scaffold only)",
                default_relay_host(),
                default_relay_port()
            );
        }
        "repl" => {
            println!("Rust implementation scaffold: repl");
        }
        "add-repo" => {
            println!("Rust implementation scaffold: add-repo");
        }
        other => {
            return Err(format!("Unsupported command: {other}"));
        }
    }

    let _ = default_relay_url();
    Ok(())
}

fn print_help() {
    println!(
        "issues-relay-server (Rust scaffold)\n\n\
Usage:\n\
  issues-relay-server serve [--host 127.0.0.1] [--port 4317]\n\
  issues-relay-server repl\n\
  issues-relay-server add-repo --url <repository-url> --folder <repository-folder> --token <github-token>\n"
    );
}
