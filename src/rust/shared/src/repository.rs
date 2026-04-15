use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const BACKLOG_DIR_NAME: &str = ".backlog";
pub const DEFAULT_RELAY_HOST: &str = "127.0.0.1";
pub const DEFAULT_RELAY_PORT: u16 = 4317;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Backlog {
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub issue_count: usize,
    #[serde(default)]
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_issue_state")]
    pub state: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RepositoryInfo {
    pub api_base_url: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone)]
pub struct RepositoryContext {
    pub remote_url: String,
    pub repository: RepositoryInfo,
}

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
    format!("{component} (Rust)")
}

pub fn normalize_repository_remote(remote_url: &str) -> String {
    parse_git_hub_remote(remote_url)
        .map(|repository| {
            format!(
                "https://{}/{}/{}",
                repository.host.to_lowercase(),
                repository.owner,
                repository.repo
            )
        })
        .unwrap_or_else(|_| remote_url.trim().trim_end_matches(".git").to_owned())
}

pub fn build_issue_fix_commit_message(
    issue_number: u64,
    title: Option<&str>,
    description: Option<&str>,
) -> String {
    let normalized_description = description.map(str::trim);
    let normalized_title = match title {
        Some(value) => value.trim().to_owned(),
        None => normalized_description
            .filter(|value| !value.is_empty())
            .map(normalize_commit_title)
            .unwrap_or_default(),
    };

    let header = if normalized_title.is_empty() {
        format!("fix(issue): close #{issue_number}")
    } else {
        format!("fix(issue): close #{issue_number} - {normalized_title}")
    };

    [header, String::new(), normalized_description.unwrap_or_default().to_owned()].join("\n")
}

fn normalize_commit_title(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn backlog_path(repo_root: impl AsRef<Path>) -> PathBuf {
    repo_root.as_ref().join(BACKLOG_DIR_NAME).join("issues.json")
}

pub fn build_backlog_from_issues(issues: Vec<Issue>) -> Backlog {
    Backlog {
        issue_count: issues.len(),
        issues,
        ..Backlog::default()
    }
}

pub fn read_backlog(backlog_path: impl AsRef<Path>) -> Result<Backlog, String> {
    let path = backlog_path.as_ref();

    match fs::read_to_string(path) {
        Ok(contents) => {
            let mut backlog: Backlog = serde_json::from_str(&contents)
                .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
            backlog.issue_count = backlog.issues.len();
            Ok(backlog)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Backlog::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub fn write_backlog(backlog_path: impl AsRef<Path>, backlog: &Backlog) -> Result<(), String> {
    let path = backlog_path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let mut normalized = backlog.clone();
    normalized.issue_count = normalized.issues.len();
    let serialized = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Failed to serialize backlog: {error}"))?;
    fs::write(path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

pub fn filter_backlog_issues(backlog: &Backlog, include_all: bool) -> Backlog {
    let issues = backlog
        .issues
        .iter()
        .filter(|issue| {
            issue.state == "open"
                && (include_all
                    || issue.labels.is_empty()
                    || issue.labels.iter().any(|label| label == "bug"))
        })
        .cloned()
        .collect::<Vec<_>>();

    Backlog {
        issue_count: issues.len(),
        issues,
        ..backlog.clone()
    }
}

pub fn find_git_root(start_dir: impl AsRef<Path>) -> Result<PathBuf, String> {
    let mut current_dir = start_dir.as_ref().to_path_buf();

    loop {
        let dot_git = current_dir.join(".git");
        if dot_git.exists() {
            return Ok(current_dir);
        }

        match current_dir.parent() {
            Some(parent) if parent != current_dir => current_dir = parent.to_path_buf(),
            _ => {
                return Err(format!(
                    "Could not find a git repository root starting from {}.",
                    start_dir.as_ref().display()
                ))
            }
        }
    }
}

pub fn parse_git_hub_remote(remote_url: &str) -> Result<RepositoryInfo, String> {
    let ssh_match = remote_url
        .trim()
        .trim_end_matches(".git")
        .strip_prefix("git@")
        .and_then(|value| value.split_once(':'));

    if let Some((host, path_part)) = ssh_match {
        return build_repository_info(host, path_part);
    }

    if let Some(stripped) = remote_url.trim().strip_prefix("ssh://git@") {
        if let Some((host, path_part)) = stripped.split_once('/') {
            return build_repository_info(host, path_part);
        }
    }

    let normalized = remote_url.trim().trim_end_matches(".git");
    let parsed = normalized
        .strip_prefix("https://")
        .or_else(|| normalized.strip_prefix("http://"))
        .ok_or_else(|| format!("Unsupported remote URL format: {remote_url}"))?;

    let (host, path_part) = parsed
        .split_once('/')
        .ok_or_else(|| format!("Could not determine owner/repo from remote URL: {remote_url}"))?;

    build_repository_info(host, path_part)
}

pub fn resolve_repository_context(
    repo_root: impl AsRef<Path>,
    remote_name: &str,
) -> Result<RepositoryContext, String> {
    let repo_root = repo_root.as_ref();
    let git_dir = resolve_git_dir(repo_root)?;
    let remotes = read_git_remotes(&git_dir)?;
    let remote_url = remotes
        .get(remote_name)
        .cloned()
        .ok_or_else(|| format!("Remote \"{remote_name}\" was not found in {}.", git_dir.join("config").display()))?;
    let repository = parse_git_hub_remote(&remote_url)?;

    Ok(RepositoryContext {
        remote_url,
        repository,
    })
}

pub fn resolve_git_dir(repo_root: impl AsRef<Path>) -> Result<PathBuf, String> {
    let repo_root = repo_root.as_ref();
    let dot_git_path = repo_root.join(".git");
    let stats = fs::metadata(&dot_git_path)
        .map_err(|error| format!("Failed to read {}: {error}", dot_git_path.display()))?;

    if stats.is_dir() {
        return Ok(dot_git_path);
    }

    if !stats.is_file() {
        return Err(format!("Unsupported .git entry at {}.", dot_git_path.display()));
    }

    let contents = fs::read_to_string(&dot_git_path)
        .map_err(|error| format!("Failed to read {}: {error}", dot_git_path.display()))?;
    let gitdir_line = contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .ok_or_else(|| format!("Could not resolve gitdir from {}.", dot_git_path.display()))?;

    Ok(repo_root.join(gitdir_line))
}

pub fn read_git_remotes(git_dir: impl AsRef<Path>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let config_path = git_dir.as_ref().join("config");
    let config_content = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let mut remotes = std::collections::BTreeMap::new();
    let mut current_remote: Option<String> = None;

    for raw_line in config_content.lines() {
        let line = raw_line.trim();

        if line.starts_with("[remote ") {
            current_remote = line
                .strip_prefix("[remote \"")
                .and_then(|value| value.strip_suffix("\"]"))
                .map(str::to_owned);
            continue;
        }

        if let Some(remote_name) = &current_remote {
            if let Some(url) = line.strip_prefix("url =") {
                remotes.insert(remote_name.clone(), url.trim().to_owned());
            }
        }

        if line.starts_with('[') && !line.starts_with("[remote ") {
            current_remote = None;
        }
    }

    Ok(remotes)
}

pub fn build_repository_info(host: &str, path_part: &str) -> Result<RepositoryInfo, String> {
    let trimmed_path = path_part.trim().trim_start_matches('/');
    let mut segments = trimmed_path.split('/').filter(|segment| !segment.is_empty());
    let owner = segments
        .next()
        .ok_or_else(|| format!("Could not determine owner/repo from remote URL path: {path_part}"))?;
    let repo = segments
        .next()
        .ok_or_else(|| format!("Could not determine owner/repo from remote URL path: {path_part}"))?
        .trim_end_matches(".git");
    let normalized_host = host.trim().to_lowercase();
    let api_base_url = if normalized_host == "github.com" {
        "https://api.github.com".to_owned()
    } else {
        format!("https://{host}/api/v3")
    };

    Ok(RepositoryInfo {
        api_base_url,
        host: host.trim().to_owned(),
        owner: owner.trim().to_owned(),
        repo: repo.trim().to_owned(),
    })
}

pub fn require_git_hub_token(token: Option<&str>) -> Result<String, String> {
    let token = token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| std::env::var("GITHUB_TOKEN").ok())
        .or_else(|| std::env::var("GH_TOKEN").ok())
        .ok_or_else(|| {
            "GitHub token not found. Provide --token, GITHUB_TOKEN, or GH_TOKEN.".to_owned()
        })?;

    Ok(token)
}

fn default_issue_state() -> String {
    "open".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{build_issue_fix_commit_message, normalize_repository_remote};

    #[test]
    fn normalizes_https_remote_to_canonical_url() {
        assert_eq!(
            normalize_repository_remote("https://github.com/owner/repo.git"),
            "https://github.com/owner/repo"
        );
    }

    #[test]
    fn normalizes_ssh_remote_to_canonical_url() {
        assert_eq!(
            normalize_repository_remote("git@github.com:owner/repo.git"),
            "https://github.com/owner/repo"
        );
    }

    #[test]
    fn preserves_unknown_remote_format_when_it_cannot_be_parsed() {
        assert_eq!(
            normalize_repository_remote("custom-remote-value.git"),
            "custom-remote-value"
        );
    }

    #[test]
    fn build_issue_fix_commit_message_uses_title_when_provided() {
        assert_eq!(
            build_issue_fix_commit_message(42, Some("Fix thing"), Some("Detailed notes")),
            "fix(issue): close #42 - Fix thing\n\nDetailed notes"
        );
    }

    #[test]
    fn build_issue_fix_commit_message_uses_description_as_fallback_title() {
        assert_eq!(
            build_issue_fix_commit_message(42, None, Some("Fix thing\nwith details")),
            "fix(issue): close #42 - Fix thing with details\n\nFix thing\nwith details"
        );
    }

    #[test]
    fn build_issue_fix_commit_message_keeps_blank_body_when_no_description_exists() {
        assert_eq!(
            build_issue_fix_commit_message(42, Some("Fix thing"), None),
            "fix(issue): close #42 - Fix thing\n\n"
        );
    }
}
