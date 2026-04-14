pub const BACKLOG_DIR_NAME: &str = ".backlog";
pub const DEFAULT_RELAY_HOST: &str = "127.0.0.1";
pub const DEFAULT_RELAY_PORT: u16 = 4317;

pub fn backlog_dir_name() -> &'static str {
    BACKLOG_DIR_NAME
}

pub fn default_relay_host() -> &'static str {
    DEFAULT_RELAY_HOST
}

pub fn default_relay_port() -> u16 {
    DEFAULT_RELAY_PORT
}

pub fn default_relay_url() -> &'static str {
    "http://127.0.0.1:4317"
}

pub fn workspace_banner(component: &str) -> String {
    format!("{component} (Rust scaffold)")
}

pub fn normalize_repository_remote(remote_url: &str) -> String {
    remote_url.trim().trim_end_matches(".git").to_owned()
}

pub fn build_issue_fix_commit_message(
    issue_number: u64,
    title: Option<&str>,
    description: Option<&str>,
) -> String {
    let title = title.map(str::trim).filter(|value| !value.is_empty());
    let description = description.map(str::trim).filter(|value| !value.is_empty());
    let header = title
        .map(|value| format!("fix(issue): close #{issue_number} - {value}"))
        .unwrap_or_else(|| format!("fix(issue): close #{issue_number}"));

    let body = description.unwrap_or("");

    if body.is_empty() {
        format!("{header}\n")
    } else {
        format!("{header}\n\n{body}\n")
    }
}
