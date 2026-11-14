//! Git 工作台：通过系统 git 完成状态、diff、按块暂存、提交、分支、历史、同步。
//! 选择 CLI 而不是 gix：push/pull/apply 等写操作与用户已有的 git 配置、凭据、hooks 完全一致。
use crate::github;
use crate::system::hidden_command;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ---------------------------------------------------------------- 基础

pub fn git_cmd(repo: &str) -> Command {
    let mut c = hidden_command("git");
    c.arg("-C")
        .arg(repo)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .env("GIT_TERMINAL_PROMPT", "0");
    c
}

pub fn finish(out: std::process::Output) -> Result<String, String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(if msg.is_empty() { "git 命令失败".into() } else { msg })
    }
}

pub fn run(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(repo).args(args).output().map_err(|e| format!("无法运行 git：{e}"))?;
    finish(out)
}

pub fn run_stdin(repo: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut child = git_cmd(repo)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法运行 git：{e}"))?;
    child
        .stdin
        .take()
        .ok_or("stdin 不可用")?
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    finish(child.wait_with_output().map_err(|e| e.to_string())?)
}

/// 网络操作：若已登录 GitHub 且远程在 github.com，通过环境变量注入认证头（不会出现在命令行或 .git/config 里）。
pub fn run_net(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut c = git_cmd(repo);
    if let Some(tok) = github::stored_token() {
        let remote = run(repo, &["remote", "get-url", "origin"]).unwrap_or_default();
        if remote.contains("github.com") {
            use base64::Engine;
            let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{tok}"));
            c.env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
                .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}"));
        }
    }
    finish(c.args(args).output().map_err(|e| format!("无法运行 git：{e}"))?)
}

pub fn has_head(repo: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 概况（总览页用）

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    is_repo: bool,
    branch: String,
    ahead: i64,
    behind: i64,
    staged: u32,
    modified: u32,
    untracked: u32,
    conflicted: u32,
    remote: Option<String>,
    last_commit: Option<String>,
}

#[tauri::command]
pub async fn git_summary(path: String) -> Result<GitSummary, String> {
    blocking(move || {
        let st = match status_inner(&path) {
            Ok(s) => s,
            Err(_) => return Ok(GitSummary::default()),
        };
        let mut s = GitSummary { is_repo: true, branch: st.branch, ahead: st.ahead, behind: st.behind, ..Default::default() };
        for f in &st.files {
            match f.kind.as_str() {
                "untracked" => s.untracked += 1,
                "conflict" => s.conflicted += 1,
                _ => {
                    if f.staged { s.staged += 1 }
                    if f.unstaged { s.modified += 1 }
                }
            }
        }
        s.remote = run(&path, &["remote", "get-url", "origin"]).ok().map(|x| x.trim().to_string());
        s.last_commit = run(&path, &["log", "-1", "--format=%s · %cr"]).ok().map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        Ok(s)
    })
    .await
}

// ---------------------------------------------------------------- 状态

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    path: String,
    orig_path: Option<String>,
    /// 索引区状态字符（M/A/D/R/C/U/.）
    x: String,
    /// 工作区状态字符
    y: String,
    /// changed | renamed | untracked | conflict
    kind: String,
    staged: bool,
    unstaged: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    branch: String,
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
    has_commits: bool,
    files: Vec<FileEntry>,
    stash_count: u32,
}

fn status_inner(repo: &str) -> Result<RepoStatus, String> {
    let raw = run(repo, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"])?;
    let mut st = RepoStatus::default();
    let mut toks = raw.split('\0').filter(|t| !t.is_empty());
    while let Some(t) = toks.next() {
        if let Some(h) = t.strip_prefix("# branch.head ") {
            st.branch = h.to_string();
        } else if let Some(u) = t.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_string());
        } else if let Some(ab) = t.strip_prefix("# branch.ab ") {
            let mut it = ab.split_whitespace();
            st.ahead = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            st.behind = it.next().and_then(|x| x.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(oid) = t.strip_prefix("# branch.oid ") {
            st.has_commits = oid != "(initial)";
        } else if let Some(p) = t.strip_prefix("? ") {
            st.files.push(FileEntry { path: p.into(), orig_path: None, x: "?".into(), y: "?".into(), kind: "untracked".into(), staged: false, unstaged: true });
        } else if t.starts_with("1 ") || t.starts_with("2 ") || t.starts_with("u ") {
            let (n, kind) = match &t[..1] { "1" => (9, "changed"), "2" => (10, "renamed"), _ => (11, "conflict") };
            let parts: Vec<&str> = t.splitn(n, ' ').collect();
            let xy = parts.get(1).copied().unwrap_or("..");
            let path = parts.last().copied().unwrap_or("").to_string();
            let orig_path = if kind == "renamed" { toks.next().map(String::from) } else { None };
            let (x, y) = (&xy[..1], &xy[1..2]);
            st.files.push(FileEntry {
                path,
                orig_path,
                x: x.into(),
                y: y.into(),
                kind: kind.into(),
                staged: kind != "conflict" && x != ".",
                unstaged: kind == "conflict" || y != ".",
            });
        }
    }
    st.stash_count = run(repo, &["stash", "list"]).map(|s| s.lines().count() as u32).unwrap_or(0);
    Ok(st)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<RepoStatus, String> {
    blocking(move || status_inner(&path)).await
}

// ---------------------------------------------------------------- diff

fn synthetic_new_file_diff(repo: &str, file: &str) -> Result<String, String> {
    let full = Path::new(repo).join(file);
    let bytes = std::fs::read(&full).map_err(|e| format!("读取失败：{e}"))?;
    if bytes.len() > 2 * 1024 * 1024 || bytes.contains(&0) {
        return Ok(format!("diff --git a/{file} b/{file}\nnew file mode 100644\nBinary files /dev/null and b/{file} differ\n"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{} @@\n", lines.len());
    for l in lines {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool, untracked: bool) -> Result<String, String> {
    blocking(move || {
        if untracked {
            return synthetic_new_file_diff(&path, &file);
        }
        let mut args = vec!["diff", "--no-ext-diff", "-U3"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", file.as_str()]);
        run(&path, &args)
    })
    .await
}

// ---------------------------------------------------------------- 暂存 / 丢弃 / 按块

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["add", "-A", "--"];
        args.extend(files.iter().map(String::as_str));
        run(&path, &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args: Vec<&str> = if has_head(&path) { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-q", "-r", "--"] };
        args.extend(files.iter().map(String::as_str));
        run(&path, &args).map(|_| ())
    })
    .await
}

/// 丢弃工作区改动。已跟踪文件 → git restore；未跟踪文件 → 删除（前端会先二次确认）。
#[tauri::command]
pub async fn git_discard(path: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    blocking(move || {
        if !tracked.is_empty() {
            let mut args = vec!["restore", "--worktree", "--"];
            args.extend(tracked.iter().map(String::as_str));
            run(&path, &args)?;
        }
        let root = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
        for f in untracked {
            let p = root.join(&f).canonicalize().map_err(|e| e.to_string())?;
            if !p.starts_with(&root) {
                return Err(format!("拒绝删除仓库之外的路径：{f}"));
            }
            std::fs::remove_file(&p).map_err(|e| format!("{f}：{e}"))?;
        }
        Ok(())
    })
    .await
}

/// 把单个 hunk 组成的补丁应用到索引区（reverse = 取消暂存该块）。
#[tauri::command]
pub async fn git_apply_patch(path: String, patch: String, reverse: bool) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["apply", "--cached", "--whitespace=nowarn", "--recount"];
        if reverse {
            args.push("-R");
        }
        args.push("-");
        run_stdin(&path, &args, &patch).map(|_| ())
    })
    .await
}

// ---------------------------------------------------------------- 提交

#[tauri::command]
pub async fn git_commit(path: String, message: String, amend: bool) -> Result<String, String> {
    blocking(move || {
        if message.trim().is_empty() {
            return Err("提交信息不能为空".into());
        }
        let mut args = vec!["commit", "-F", "-"];
        if amend {
            args.push("--amend");
        }
        run_stdin(&path, &args, &message)?;
        Ok(run(&path, &["log", "-1", "--format=%h %s"])?.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_last_message(path: String) -> Result<String, String> {
    blocking(move || Ok(run(&path, &["log", "-1", "--format=%B"]).unwrap_or_default().trim_end().to_string())).await
}

// ---------------------------------------------------------------- 分支

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    remote: bool,
    current: bool,
    upstream: Option<String>,
    track: String,
    updated: i64,
    subject: String,
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<Branch>, String> {
    blocking(move || {
        let fmt = "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)";
        let raw = run(&path, &["for-each-ref", fmt, "--sort=-committerdate", "refs/heads", "refs/remotes"])?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 6 || f[0].ends_with("/HEAD") {
                continue;
            }
            let (name, remote) = if let Some(n) = f[0].strip_prefix("refs/heads/") {
                (n.to_string(), false)
            } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
                (n.to_string(), true)
            } else {
                continue;
            };
            out.push(Branch {
                name,
                remote,
                current: f[1] == "*",
                upstream: Some(f[2].to_string()).filter(|s| !s.is_empty()),
                track: f[3].to_string(),
                updated: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
            });
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    blocking(move || run(&path, &["switch", &branch]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String, checkout: bool) -> Result<(), String> {
    blocking(move || {
        run(&path, &["check-ref-format", "--branch", &name]).map_err(|_| format!("分支名不合法：{name}"))?;
        if checkout { run(&path, &["switch", "-c", &name]) } else { run(&path, &["branch", &name]) }.map(|_| ())
    })
    .await
}

// ---------------------------------------------------------------- 历史

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    time: i64,
    subject: String,
    refs: Vec<String>,
}

#[tauri::command]
pub async fn git_log(path: String, limit: u32) -> Result<Vec<Commit>, String> {
    blocking(move || {
        if !has_head(&path) {
            return Ok(vec![]);
        }
        let n = format!("-n{}", limit.clamp(1, 2000));
        let raw = run(&path, &["log", "--all", "--topo-order", &n, "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e"])?;
        Ok(raw
            .split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').split('\0').collect();
                if f.len() < 6 || f[0].is_empty() {
                    return None;
                }
                Some(Commit {
                    hash: f[0].into(),
                    parents: f[1].split_whitespace().map(String::from).collect(),
                    author: f[2].into(),
                    time: f[3].parse().unwrap_or(0),
                    subject: f[4].into(),
                    refs: f[5].split(", ").filter(|s| !s.is_empty()).map(String::from).collect(),
                })
            })
            .collect())
    })
    .await
}

// ---------------------------------------------------------------- 同步 / 杂项

#[tauri::command]
pub async fn git_sync(path: String, action: String) -> Result<String, String> {
    blocking(move || {
        let out = match action.as_str() {
            "fetch" => run_net(&path, &["fetch", "--all", "--prune"]),
            "pull" => run_net(&path, &["pull", "--ff-only"]),
            "push" => {
                if run(&path, &["rev-parse", "--abbrev-ref", "@{u}"]).is_ok() {
                    run_net(&path, &["push"])
                } else {
                    run_net(&path, &["push", "-u", "origin", "HEAD"])
                }
            }
            _ => Err(format!("未知操作：{action}")),
        }?;
        Ok(out.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_stash(path: String, pop: bool) -> Result<(), String> {
    blocking(move || {
        if pop { run(&path, &["stash", "pop"]) } else { run(&path, &["stash", "push", "-u", "-m", "Forge 暂存"]) }.map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    blocking(move || run(&path, &["init", "-b", "main"]).map(|_| ())).await
}

// ---------------------------------------------------------------- 提交前扫描

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    file: String,
    kind: String,
    line: Option<usize>,
    /// "block"：GitHub 会拒绝 / 高危；"warn"：建议检查
    pub level: String,
}

fn token_after(line: &str, prefix: &str, min: usize) -> bool {
    line.match_indices(prefix).any(|(i, _)| {
        line[i + prefix.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count() >= min
    })
}

fn aws_key(line: &str) -> bool {
    line.match_indices("AKIA").any(|(i, _)| {
        let rest = &line[i + 4..];
        rest.len() >= 16 && rest[..16].chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    })
}

// 特征串拆开书写，避免扫描器把自己的源码当成密钥
const PEM_BEGIN: &str = concat!("-----BEG", "IN");
const PEM_KEY: &str = concat!("PRIVATE ", "KEY-----");

fn scan_line(line: &str) -> Option<&'static str> {
    if line.contains(PEM_BEGIN) && line.contains(PEM_KEY) {
        Some("私钥")
    } else if token_after(line, "ghp_", 30) || token_after(line, "gho_", 30) || token_after(line, "github_pat_", 30) {
        Some("GitHub Token")
    } else if token_after(line, "sk-ant-", 20) {
        Some("Anthropic API Key")
    } else if token_after(line, "sk-proj-", 20) {
        Some("OpenAI API Key")
    } else if aws_key(line) {
        Some("AWS Access Key")
    } else if token_after(line, "xoxb-", 20) || token_after(line, "xoxp-", 20) {
        Some("Slack Token")
    } else {
        None
    }
}

fn sensitive_name(file: &str) -> Option<&'static str> {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file).to_ascii_lowercase();
    let is_example = [".example", ".sample", ".template", ".dist"].iter().any(|s| base.ends_with(s));
    if (base == ".env" || base.starts_with(".env.")) && !is_example {
        Some("环境变量文件 (.env)")
    } else if ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].contains(&base.as_str()) {
        Some("SSH 私钥文件")
    } else if [".pem", ".pfx", ".p12", ".keystore", ".jks"].iter().any(|s| base.ends_with(s)) {
        Some("证书 / 密钥库文件")
    } else {
        None
    }
}

pub fn scan_files(repo: &str, files: &[String]) -> Vec<Finding> {
    let mut out = Vec::new();
    for f in files {
        let full = Path::new(repo).join(f);
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if !meta.is_file() {
            continue;
        }
        let mb = meta.len() / (1024 * 1024);
        if mb >= 100 {
            out.push(Finding { file: f.clone(), kind: format!("超大文件 {mb}MB（GitHub 上限 100MB）"), line: None, level: "block".into() });
            continue;
        } else if mb >= 50 {
            out.push(Finding { file: f.clone(), kind: format!("大文件 {mb}MB，建议用 Git LFS"), line: None, level: "warn".into() });
        }
        if let Some(k) = sensitive_name(f) {
            out.push(Finding { file: f.clone(), kind: k.into(), line: None, level: "block".into() });
        }
        if meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&full) else { continue };
        if bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if let Some(k) = scan_line(line) {
                out.push(Finding { file: f.clone(), kind: k.into(), line: Some(i + 1), level: "block".into() });
                break;
            }
        }
    }
    out
}

pub fn list_z(repo: &str, args: &[&str]) -> Vec<String> {
    run(repo, args)
        .map(|s| s.split('\0').filter(|x| !x.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// mode = "staged"：只扫暂存区；"all"：所有将被跟踪的文件（遵守 .gitignore）。
#[tauri::command]
pub async fn git_scan(path: String, mode: String) -> Result<Vec<Finding>, String> {
    blocking(move || {
        let files = if mode == "staged" {
            list_z(&path, &["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
        } else {
            list_z(&path, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        };
        Ok(scan_files(&path, &files))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secrets() {
        // 测试样本同样拆开拼接，避免本文件被提交前扫描误报
        assert_eq!(scan_line(concat!("key = \"sk-", "ant-api03-abcdefghijklmnopqrstuvwxyz\"")), Some("Anthropic API Key"));
        assert_eq!(scan_line(concat!("AWS=AK", "IAIOSFODNN7EXAMPLE")), Some("AWS Access Key"));
        assert_eq!(scan_line(&format!("{PEM_BEGIN} OPENSSH {PEM_KEY}")), Some("私钥"));
        assert_eq!(scan_line(concat!("token: gh", "p_abcdefghijklmnopqrstuvwxyz0123456789")), Some("GitHub Token"));
        assert_eq!(scan_line("let ghp_ = 1; // short"), None);
        assert_eq!(scan_line("normal code line"), None);
    }

    #[test]
    fn sensitive_names() {
        assert!(sensitive_name("config/.env").is_some());
        assert!(sensitive_name(".env.local").is_some());
        assert!(sensitive_name(".env.example").is_none());
        assert!(sensitive_name("keys/id_rsa").is_some());
        assert!(sensitive_name("id_rsa.pub").is_none());
    }

    fn tmp_repo() -> String {
        let dir = std::env::temp_dir().join(format!("forge-test-{}", std::process::id() as u64 * 1000 + rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();
        run(&p, &["init", "-b", "main"]).unwrap();
        run(&p, &["config", "user.name", "Forge Test"]).unwrap();
        run(&p, &["config", "user.email", "test@example.invalid"]).unwrap();
        p
    }

    fn rand_suffix() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64 % 1000
    }

    #[test]
    fn status_stage_commit_flow() {
        let repo = tmp_repo();
        std::fs::write(Path::new(&repo).join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(Path::new(&repo).join("中文 文件.md"), "你好\n").unwrap();
        let st = status_inner(&repo).unwrap();
        assert!(!st.has_commits);
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().any(|f| f.path == "中文 文件.md" && f.kind == "untracked"));

        run(&repo, &["add", "-A"]).unwrap();
        run_stdin(&repo, &["commit", "-F", "-"], "init\n\nbody").unwrap();
        let st = status_inner(&repo).unwrap();
        assert!(st.has_commits && st.files.is_empty());
        assert_eq!(st.branch, "main");

        // 修改两处，只暂存第一个 hunk
        let mut lines: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
        std::fs::write(Path::new(&repo).join("b.txt"), lines.join("\n") + "\n").unwrap();
        run(&repo, &["add", "b.txt"]).unwrap();
        run_stdin(&repo, &["commit", "-F", "-"], "b").unwrap();
        lines[1] = "CHANGED 2".into();
        lines[35] = "CHANGED 36".into();
        std::fs::write(Path::new(&repo).join("b.txt"), lines.join("\n") + "\n").unwrap();
        let diff = run(&repo, &["diff", "-U3", "--", "b.txt"]).unwrap();
        let first_hunk_end = diff.match_indices("\n@@").nth(1).map(|(i, _)| i + 1).unwrap();
        let patch = diff[..first_hunk_end].to_string();
        run_stdin(&repo, &["apply", "--cached", "--whitespace=nowarn", "--recount", "-"], &patch).unwrap();
        let st = status_inner(&repo).unwrap();
        let b = st.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert!(b.staged && b.unstaged, "部分暂存后应同时有暂存和未暂存改动");
        let cached = run(&repo, &["diff", "--cached"]).unwrap();
        assert!(cached.contains("CHANGED 2") && !cached.contains("CHANGED 36"));

        let _ = std::fs::remove_dir_all(&repo);
    }
}
