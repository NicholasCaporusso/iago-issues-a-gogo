use github_issues_resolver_shared::{
    backlog_path,
    build_issue_fix_commit_message,
    filter_backlog_issues,
    find_git_root,
    read_backlog,
    read_relay_port,
    require_git_hub_token,
    resolve_repository_context,
    relay_url_for_port,
    relay_config_path,
    write_relay_port,
    write_backlog,
    Backlog,
    Issue,
};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

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
    let relay_port = read_relay_port()?;
    let options = parse_args(env::args().skip(1).collect(), relay_port)?;

    if options.help {
        print_help(relay_port)?;
        return Ok(());
    }

    let command = options.command.as_str();

    match command {
        "sync" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let backlog = sync_issues(&repo_root, &options)?;
            render_issue_collection(&filter_backlog_issues(&backlog, options.all), &options)?;
        }
        "list" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let backlog = ensure_backlog(&repo_root, &options)?;
            render_issue_collection(&filter_backlog_issues(&backlog, options.all), &options)?;
        }
        "show" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let backlog = ensure_backlog(&repo_root, &options)?;
            let issue_number = options
                .issue_number
                .ok_or_else(|| "The show command requires --issue <number>.".to_owned())?;
            let issue = find_issue_by_number(&backlog, issue_number)?;
            render_single_issue(issue, &options)?;
        }
        "start-issue" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let issue_number = options
                .issue_number
                .ok_or_else(|| "The start-issue command requires --issue <number>.".to_owned())?;
            let branch_name = start_issue_branch(&repo_root, issue_number)?;
            println!("{branch_name}");
        }
        "completed" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let result = commit_issue_fix(&repo_root, &options)?;

            if options.json {
                println!("{}", serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?);
            } else {
                println!("{}", result.commit_message.trim_end());
                if result.pushed {
                    println!(
                        "Pushed to {}{}",
                        result.remote,
                        result
                            .branch
                            .as_ref()
                            .map(|branch| format!(" ({branch})"))
                            .unwrap_or_default()
                    );
                }

                if let Some(error) = result.close_issue_error {
                    eprintln!("Warning: {error}");
                }
            }
        }
        "report" | "create-issue" => {
            let repo_root = find_git_root(options.cwd.clone().unwrap_or_else(current_dir_string))?;
            let created = create_remote_issue(&repo_root, &options)?;

            if options.json {
                println!("{}", serde_json::to_string_pretty(&created).map_err(|error| error.to_string())?);
            } else {
                println!("#{}: {}", created.number, created.title);
            }
        }
        "set-port" => {
            set_port_command(&options)?;
        }
        other => {
            return Err(format!("Unsupported command: {other}"));
        }
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct Options {
    all: bool,
    branch: Option<String>,
    command: String,
    cwd: Option<String>,
    description: Option<String>,
    files: Vec<String>,
    help: bool,
    issue_number: Option<u64>,
    json: bool,
    label: Option<String>,
    output: Option<String>,
    port: Option<u16>,
    push: bool,
    relay: bool,
    relay_url: String,
    remote: Option<String>,
    save: bool,
    title: Option<String>,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CompletedResult {
    branch: Option<String>,
    close_issue_error: Option<String>,
    closed_issue: Option<CloseIssueResult>,
    commit_message: String,
    files: Vec<String>,
    issue_number: u64,
    pushed: bool,
    remote: String,
}

#[derive(Debug, Clone, Serialize)]
struct CreatedIssue {
    number: u64,
    title: String,
    description: String,
    html_url: String,
    state: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubIssueApi {
    number: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    html_url: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    user: Option<GitHubUser>,
    #[serde(default)]
    labels: Vec<GitHubLabel>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubLabel {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubUser {
    #[serde(default)]
    login: Option<String>,
}

fn parse_args(argv: Vec<String>, default_relay_port: u16) -> Result<Options, String> {
    let mut options = Options {
        all: false,
        branch: None,
        command: "sync".to_owned(),
        cwd: None,
        description: None,
        files: Vec::new(),
        help: false,
        issue_number: None,
        json: false,
        label: None,
        output: None,
        port: None,
        push: false,
        relay: false,
        relay_url: relay_url_for_port(default_relay_port),
        remote: None,
        save: false,
        title: None,
        token: None,
    };

    let mut index = 0;

    if let Some(first) = argv.first() {
        if !first.starts_with('-') {
            options.command = first.clone();
            index = 1;
        }
    }

    while index < argv.len() {
        let current = &argv[index];

        match current.as_str() {
            "--help" | "-h" => {
                options.help = true;
            }
            "--json" => {
                options.json = true;
            }
            "--all" => {
                options.all = true;
            }
            "--cwd" => {
                index += 1;
                options.cwd = Some(require_value(&argv, index, "--cwd")?);
            }
            "--remote" => {
                index += 1;
                options.remote = Some(require_value(&argv, index, "--remote")?);
            }
            "--token" => {
                index += 1;
                options.token = Some(require_value(&argv, index, "--token")?);
            }
            "--output" => {
                index += 1;
                options.output = Some(require_value(&argv, index, "--output")?);
            }
            "--port" => {
                index += 1;
                options.port = Some(parse_port(&require_value(&argv, index, "--port")?)?);
            }
            "--relay" => {
                options.relay = true;
            }
            "--relay-url" => {
                index += 1;
                options.relay_url = require_value(&argv, index, "--relay-url")?;
            }
            "--issue" => {
                index += 1;
                options.issue_number = Some(parse_issue_number(&require_value(&argv, index, "--issue")?)?);
            }
            "--title" => {
                index += 1;
                options.title = Some(require_value(&argv, index, "--title")?);
            }
            "--description" => {
                index += 1;
                options.description = Some(require_value(&argv, index, "--description")?);
            }
            "--label" => {
                index += 1;
                options.label = Some(parse_issue_label(&require_value(&argv, index, "--label")?)?);
            }
            "--push" => {
                options.push = true;
            }
            "--save" => {
                options.save = true;
            }
            "--branch" => {
                index += 1;
                options.branch = Some(require_value(&argv, index, "--branch")?);
            }
            "--files" => {
                let files = read_files_list(&argv, index + 1);
                if files.is_empty() {
                    return Err("Missing value for --files.".to_owned());
                }
                options.files = files;
                index += options.files.len();
            }
            value => {
                return Err(format!("Unknown argument: {value}"));
            }
        }

        index += 1;
    }

    Ok(options)
}

fn set_port_command(options: &Options) -> Result<(), String> {
    let port = options
        .port
        .ok_or_else(|| "The set-port command requires --port <number>.".to_owned())?;
    let config_path = write_relay_port(port)?;
    println!("Relay port updated to {port} in {}", config_path.display());
    Ok(())
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

fn require_value(argv: &[String], index: usize, flag_name: &str) -> Result<String, String> {
    let value = argv.get(index).cloned();

    match value {
        Some(value) if !value.starts_with("--") => Ok(value),
        _ => Err(format!("Missing value for {flag_name}.")),
    }
}

fn parse_issue_number(value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("Invalid issue number: {value}"))
}

fn parse_issue_label(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "bug" | "improvement" | "feature" => Ok(normalized),
        _ => Err(format!(
            "Invalid label: {value}. Allowed labels are bug, improvement, feature."
        )),
    }
}

fn read_files_list(argv: &[String], start_index: usize) -> Vec<String> {
    let mut files = Vec::new();

    for value in argv.iter().skip(start_index) {
        if value.starts_with("--") {
            break;
        }
        files.push(value.clone());
    }

    files
}

fn current_dir_string() -> String {
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .into_owned()
}

fn ensure_backlog(repo_root: &Path, options: &Options) -> Result<Backlog, String> {
    let backlog = read_backlog(backlog_path(repo_root))?;

    if backlog.issues.is_empty() {
        sync_issues(repo_root, options)
    } else {
        Ok(backlog)
    }
}

fn find_issue_by_number(backlog: &Backlog, issue_number: u64) -> Result<&Issue, String> {
    backlog
        .issues
        .iter()
        .find(|issue| issue.number == issue_number)
        .ok_or_else(|| format!("Issue #{issue_number} was not found in .backlog/issues.json."))
}

fn render_issue_collection(result: &Backlog, options: &Options) -> Result<(), String> {
    if let Some(output) = &options.output {
        let output_path = Path::new(output);
        write_backlog(output_path, result)?;
        println!(
            "Saved {} open issues to {}",
            result.issue_count,
            output_path.display()
        );
        return Ok(());
    }

    if options.json {
        println!("{}", serde_json::to_string_pretty(result).map_err(|error| error.to_string())?);
        return Ok(());
    }

    println!("# Open issues: {}", result.issue_count);

    if result.issues.is_empty() {
        println!("No open issues found.");
        return Ok(());
    }

    for issue in &result.issues {
        let labels = if issue.labels.is_empty() {
            String::new()
        } else {
            format!(" [{}]", issue.labels.join(", "))
        };
        println!("- Issue {}: {}{}", issue.number, issue.title, labels);
    }

    Ok(())
}

fn render_single_issue(issue: &Issue, options: &Options) -> Result<(), String> {
    if options.json {
        println!("{}", serde_json::to_string_pretty(issue).map_err(|error| error.to_string())?);
        return Ok(());
    }

    println!("# Issue {}", issue.number);
    println!("{}", issue.title);
    println!();
    println!("{}", issue.description.clone().unwrap_or_else(|| "(no description)".to_owned()));
    Ok(())
}

fn start_issue_branch(repo_root: &Path, issue_number: u64) -> Result<String, String> {
    let branch_name = make_issue_branch_name(issue_number);

    if run_git_command(["rev-parse", "--verify", &branch_name], repo_root).is_ok() {
        run_git_command(["checkout", &branch_name], repo_root)?;
    } else {
        run_git_command(["checkout", "-b", &branch_name], repo_root)?;
    }

    Ok(branch_name)
}

fn make_issue_branch_name(issue_number: u64) -> String {
    format!("issue/{issue_number}")
}

fn commit_issue_fix(repo_root: &Path, options: &Options) -> Result<CompletedResult, String> {
    let issue_number = options
        .issue_number
        .ok_or_else(|| "completed requires --issue <number>.".to_owned())?;

    if options.title.as_deref().map(str::trim).unwrap_or("").is_empty()
        && options.description.as_deref().map(str::trim).unwrap_or("").is_empty()
    {
        return Err("completed requires --description or --title.".to_owned());
    }

    if options.files.is_empty() {
        run_git_command(["add", "."], repo_root)?;
    } else {
        let mut args = vec!["add".to_owned(), "--".to_owned()];
        args.extend(options.files.iter().cloned());
        run_git_command(args.iter().map(String::as_str), repo_root)?;
    }

    let commit_message = build_issue_fix_commit_message(
        issue_number,
        options.title.as_deref(),
        options.description.as_deref(),
    );
    run_git_command(build_commit_command_args(&commit_message), repo_root)?;

    let pushed = options.push || options.save;
    if pushed {
        let remote = options.remote.clone().unwrap_or_else(|| "origin".to_owned());
        let push_args = if let Some(branch) = &options.branch {
            vec!["push".to_owned(), remote.clone(), format!("HEAD:{branch}")]
        } else {
            vec!["push".to_owned(), remote.clone(), "HEAD".to_owned()]
        };
        run_git_command(push_args.iter().map(String::as_str), repo_root)?;
    }

    let remote = options.remote.clone().unwrap_or_else(|| "origin".to_owned());
    let mut closed_issue = None;
    let mut close_issue_error = None;

    match close_remote_issue(repo_root, options) {
        Ok(result) => {
            closed_issue = Some(result);
        }
        Err(error) => {
            close_issue_error = Some(error);
        }
    }

    Ok(CompletedResult {
        branch: options.branch.clone(),
        close_issue_error,
        closed_issue,
        commit_message,
        files: options.files.clone(),
        issue_number,
        pushed,
        remote,
    })
}

fn create_remote_issue(repo_root: &Path, options: &Options) -> Result<CreatedIssue, String> {
    let title = options
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The create-issue command requires --title <text>.".to_owned())?;

    let remote_name = options.remote.clone().unwrap_or_else(|| "origin".to_owned());
    let context = resolve_repository_context(repo_root, &remote_name)?;
    let token = require_git_hub_token(options.token.as_deref())?;
    let client = github_client(&token)?;
    let url = format!(
        "{}/repos/{}/issues",
        context.repository.api_base_url,
        format!("{}/{}", context.repository.owner, context.repository.repo)
    );

    let mut body = json!({
        "title": title,
        "body": options.description.as_deref().unwrap_or("").trim(),
    });

    if let Some(label) = &options.label {
        body["labels"] = json!([label]);
    }

    let response = client
        .post(url)
        .json(&body)
        .send()
        .map_err(|error| format!("Failed to create issue: {error}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().unwrap_or_default();
        return Err(build_repository_api_error("create issue", status, body));
    }

    let created: GitHubIssueApi = response
        .json()
        .map_err(|error| format!("Failed to decode GitHub response: {error}"))?;

    Ok(CreatedIssue {
        number: created.number,
        title: created.title,
        description: created.body.unwrap_or_default(),
        html_url: created.html_url,
        state: created.state,
    })
}

fn sync_issues(repo_root: &Path, options: &Options) -> Result<Backlog, String> {
    let remote_name = options.remote.clone().unwrap_or_else(|| "origin".to_owned());
    let context = resolve_repository_context(repo_root, &remote_name)?;
    if options.token.is_some() && !options.relay {
        let token = require_git_hub_token(options.token.as_deref())?;
        let client = github_client(&token)?;
        let existing_backlog = read_backlog(backlog_path(repo_root))?;
        let issues = fetch_open_issues(
            &client,
            &context,
            existing_backlog,
            &remote_name,
            repo_root,
        )?;
        let backlog = Backlog {
            repository: Some(format!("{}/{}", context.repository.owner, context.repository.repo)),
            host: Some(context.repository.host.clone()),
            remote: Some(remote_name.clone()),
            remote_url: Some(context.remote_url.clone()),
            issue_count: issues.len(),
            issues,
        };

        let output_path = backlog_path(repo_root);
        write_backlog(output_path, &backlog)?;

        if let Some(output) = &options.output {
            write_backlog(Path::new(output), &backlog)?;
        }

        return Ok(backlog);
    }

    relay_sync(repo_root, options, &context)
}

fn relay_sync(
    repo_root: &Path,
    options: &Options,
    context: &github_issues_resolver_shared::RepositoryContext,
) -> Result<Backlog, String> {
    let relay_target = new_relay_url(options.relay_url.as_str(), "/sync")?;
    let client = Client::new();
    let response = client
        .post(relay_target)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("User-Agent", "github-issues-resolver-relay-client")
        .json(&json!({
            "remote": options.remote.clone().unwrap_or_else(|| "origin".to_owned()),
            "repositoryFolder": repo_root.display().to_string(),
            "repositoryUrl": github_issues_resolver_shared::normalize_repository_remote(&context.remote_url)
        }))
        .send()
        .map_err(|error| format!("Failed to sync via relay: {error}"))?;

    let backlog: Backlog = response
        .json()
        .map_err(|error| format!("Failed to decode relay response: {error}"))?;

    if let Some(output) = &options.output {
        write_backlog(Path::new(output), &backlog)?;
    }

    let output_path = backlog_path(repo_root);
    write_backlog(output_path, &backlog)?;
    Ok(backlog)
}

fn new_relay_url(base: &str, path_suffix: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Relay URL cannot be empty.".to_owned());
    }

    Ok(format!("{trimmed}{path_suffix}"))
}

fn close_remote_issue(repo_root: &Path, options: &Options) -> Result<CloseIssueResult, String> {
    let issue_number = options
        .issue_number
        .ok_or_else(|| "close_remote_issue requires an issue_number.".to_owned())?;
    let remote_name = options.remote.clone().unwrap_or_else(|| "origin".to_owned());
    let context = resolve_repository_context(repo_root, &remote_name)?;
    let token = require_git_hub_token(options.token.as_deref())?;
    let client = github_client(&token)?;
    let url = format!(
        "{}/repos/{}/{}/issues/{}",
        context.repository.api_base_url,
        context.repository.owner,
        context.repository.repo,
        issue_number
    );

    let response = client
        .patch(url)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .json(&json!({ "state": "closed" }))
        .send()
        .map_err(|error| format!("Failed to close issue #{issue_number}: {error}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().unwrap_or_default();
        return Err(build_repository_api_error(
            &format!("close issue #{issue_number}"),
            status,
            body,
        ));
    }

    let closed: GitHubIssueApi = response
        .json()
        .map_err(|error| format!("Failed to decode GitHub response: {error}"))?;
    update_backlog_issue_state(repo_root, issue_number, "closed")?;

    Ok(CloseIssueResult {
        number: closed.number,
        state: closed.state,
        title: closed.title,
        html_url: closed.html_url,
        error: None,
    })
}

#[derive(Debug, Clone, Serialize)]
struct CloseIssueResult {
    number: u64,
    state: String,
    title: String,
    html_url: String,
    error: Option<String>,
}

fn update_backlog_issue_state(repo_root: &Path, issue_number: u64, state: &str) -> Result<(), String> {
    let backlog_path = backlog_path(repo_root);
    let mut backlog = read_backlog(&backlog_path)?;

    let mut changed = false;
    for issue in &mut backlog.issues {
        if issue.number == issue_number {
            if issue.state != state {
                issue.state = state.to_owned();
                changed = true;
            }
        }
    }

    if changed {
        write_backlog(backlog_path, &backlog)?;
    }

    Ok(())
}

fn fetch_open_issues(
    client: &Client,
    context: &github_issues_resolver_shared::RepositoryContext,
    existing_backlog: Backlog,
    remote_name: &str,
    repo_root: &Path,
) -> Result<Vec<Issue>, String> {
    let mut issues = Vec::new();
    let mut page = 1;
    let existing_issues = existing_backlog
        .issues
        .into_iter()
        .map(|issue| (issue.number, issue))
        .collect::<std::collections::BTreeMap<_, _>>();

    loop {
        let url = format!(
            "{}/repos/{}/{}/issues?state=open&per_page=100&page={page}",
            context.repository.api_base_url,
            context.repository.owner,
            context.repository.repo
        );

        let response = client
            .get(url)
            .send()
            .map_err(|error| build_repository_fetch_error("fetch issues", remote_name, &context.remote_url, error))?;

        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            let body = response.text().unwrap_or_default();
            return Err(format!("Authentication failed or rate limit exceeded: {body}"));
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            return Err(build_repository_api_error("fetch issues", status, body));
        }

        let page_items: Vec<GitHubIssueApi> = response
            .json()
            .map_err(|error| format!("Failed to decode GitHub response: {error}"))?;
        let has_more = page_items.len() >= 100;

        for item in page_items.into_iter().filter(|item| item.pull_request.is_none()) {
            if let Some(existing) = existing_issues.get(&item.number) {
                if existing.updated_at.as_deref() == Some(&item.updated_at) {
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
                html_url: Some(item.html_url),
                created_at: Some(item.created_at),
                updated_at: Some(item.updated_at),
                author: item.user.and_then(|user| user.login),
            });
        }

        if !has_more {
            break;
        }

        page += 1;
    }

    let _ = repo_root;
    Ok(issues)
}

fn github_client(token: &str) -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
    headers.insert(USER_AGENT, HeaderValue::from_static("github-issues-resolver"));
    let auth_value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|error| format!("Invalid GitHub token header: {error}"))?;
    headers.insert(AUTHORIZATION, auth_value);

    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))
}

fn build_repository_api_error(action: &str, status: u16, body: String) -> String {
    let reason = if body.trim().is_empty() {
        format!("GitHub API returned {status}.")
    } else {
        body
    };

    format!("Failed to {action}: {reason}")
}

fn build_repository_fetch_error(
    action: &str,
    remote_name: &str,
    remote_url: &str,
    error: reqwest::Error,
) -> String {
    let remote_label = format!("{remote_name} ({remote_url})");
    format!(
        "Failed to {action} from {remote_label}: {error}. Check network connectivity, authentication, and repository configuration."
    )
}

fn build_commit_command_args(commit_message: &str) -> Vec<String> {
    let mut args = vec!["commit".to_owned()];

    for part in commit_message.split("\n\n") {
        args.push("-m".to_owned());
        args.push(part.to_owned());
    }

    args
}

fn run_git_command<I, S>(args: I, cwd: &Path) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let args_vec = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect::<Vec<_>>();

    let output = Command::new("git")
        .args(&args_vec)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("Failed to run git command: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let reason = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git exited with code {:?}", output.status.code())
        };
        Err(format!("Git command failed: git {}\n{reason}", args_vec_to_string(&args_vec)))
    }
}

fn args_vec_to_string(args: &[std::ffi::OsString]) -> String {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn print_help(relay_port: u16) -> Result<(), String> {
    let config_path = relay_config_path()?;
    println!(
        "github-issues-resolver\n\n\
Usage:\n\
  github-issues-resolver [command] [options]\n\n\
Commands:\n\
  sync                sync [--cwd <path>] [--remote <name>] [--token <token>] [--all] [--json] [--output <path>]\n\
                      Download open issues and save .backlog/issues.json.\n\
  list                list [--cwd <path>] [--all] [--json] [--output <path>]\n\
                      Read and print issues from .backlog/issues.json.\n\
  show                show --issue <number> [--cwd <path>] [--json]\n\
                      Print one issue from .backlog/issues.json.\n\
  start-issue         start-issue --issue <number> [--cwd <path>]\n\
                      Create or switch to the branch for an issue.\n\
  completed           completed --issue <number> --files <path> [<path> ...] [--title <text>] [--description <text>] [--push] [--branch <name>]\n\
                      Stage files, commit progress for an issue, and close it.\n\
  report              report --title <text> [--description <text>] [--label bug|improvement|feature] [--cwd <path>] [--remote <name>] [--token <token>]\n\
                      Create a new issue on the remote repository.\n\
  create-issue        create-issue --title <text> [--description <text>] [--label bug|improvement|feature] [--cwd <path>] [--remote <name>] [--token <token>]\n\
                      Same as report.\n\
  set-port            set-port --port <number>\n\
                      Update the shared relay config with a new server port.\n\n\
Options:\n\
  --cwd <path>       Start searching for the git repository from this directory.\n\
  --remote <name>    Git remote to inspect. Defaults to \"origin\".\n\
  --token <token>    GitHub token. Falls back to GITHUB_TOKEN or GH_TOKEN.\n\
  --all              Include improvement and feature issues in list output.\n\
  --issue <number>   Issue number for show, start-issue, or completed.\n\
  --title <text>     Issue title for report/create-issue or commit title for completed.\n\
  --description <t>  Issue description for report/create-issue or commit text for completed.\n\
  --label <name>     Issue label for report/create-issue. One of: bug, improvement, feature.\n\
  --files <paths>    Files to stage for completed.\n\
  --push             Push after completed.\n\
  --save             Ask the relay flow to push after completed.\n\
  --branch <name>    Push target branch for completed.\n\
  --relay            Send completed to the local relay server instead of committing directly.\n\
  --relay-url <url>  Relay server base URL. Defaults to the shared relay config.\n\
  --port <number>    Update the shared relay config when using set-port.\n\
  --json             Print the full result as JSON.\n\
  --output <path>    Save the full result as JSON to a file.\n\
  --help, -h         Show this help message.\n\n\
Shared relay config:\n\
  {}\n\
  Default port: {}\n",
        config_path.display(),
        relay_port
    );
    Ok(())
}
