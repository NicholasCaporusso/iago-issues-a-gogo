use github_issues_resolver_shared::{
    build_issue_fix_commit_message,
    default_relay_url,
    normalize_repository_remote,
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
    let command = args.next().unwrap_or_else(|| "sync".to_owned());

    if matches!(command.as_str(), "--help" | "-h") {
        print_help();
        return Ok(());
    }

    match command.as_str() {
        "sync" => {
            println!("{}", workspace_banner("github-issues-resolver sync"));
            println!("Rust implementation scaffold is ready.");
            println!("Default relay URL: {}", default_relay_url());
        }
        "list" => {
            println!("Rust implementation scaffold: list");
        }
        "show" => {
            println!("Rust implementation scaffold: show");
        }
        "start-issue" => {
            println!("Rust implementation scaffold: start-issue");
        }
        "completed" => {
            let example = build_issue_fix_commit_message(0, Some("example"), Some("scaffold"));
            println!("{}", workspace_banner("github-issues-resolver completed"));
            println!("{example}");
        }
        "report" | "create-issue" => {
            println!("Rust implementation scaffold: {command}");
        }
        other => {
            return Err(format!("Unsupported command: {other}"));
        }
    }

    let _ = normalize_repository_remote("https://github.com/example/repo.git");
    Ok(())
}

fn print_help() {
    println!(
        "github-issues-resolver (Rust scaffold)\n\n\
Usage:\n\
  github-issues-resolver [command] [options]\n\n\
Commands:\n\
  sync                Download open issues and save .backlog/issues.json.\n\
  list                Read and print issues from .backlog/issues.json.\n\
  show                Print one issue from .backlog/issues.json.\n\
  start-issue         Create or switch to the branch for an issue.\n\
  completed           Stage files, commit progress for an issue, and close it.\n\
  report              Create a new issue on the remote repository.\n\
  create-issue        Create a new issue on the remote repository.\n"
    );
}
