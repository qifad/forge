//! GitHub：登录（gh CLI 导入 / Device Flow / 个人令牌）、仓库列表、一键发布。
//! Token 只保存在 Windows 凭据管理器中，不写入任何文件。
use crate::git::{self, Finding};
use crate::system::hidden_command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

const SERVICE: &str = "dev.forge.app";
const ACCOUNT: &str = "github-token";
const API: &str = "https://api.github.com";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("凭据管理器不可用：{e}"))
}

pub fn stored_token() -> Option<String> {
    entry().ok()?.get_password().ok().filter(|t| !t.is_empty())
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Forge-Desktop")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

async fn api(method: reqwest::Method, path: &str, token: &str, body: Option<Value>) -> Result<Value, String> {
    let mut req = client()
        .request(method, format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(v)
    } else {
        let msg = v.get("message").and_then(Value::as_str).unwrap_or("请求失败");
        let detail = v
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|e| e.get("message").and_then(Value::as_str))
            .map(|m| format!("（{m}）"))
            .unwrap_or_default();
        Err(match status.as_u16() {
            401 => "GitHub 令牌无效或已过期，请重新登录".into(),
            _ => format!("GitHub {}：{msg}{detail}", status.as_u16()),
        })
    }
}

// ---------------------------------------------------------------- 账号

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhUser {
    id: u64,
    login: String,
    name: Option<String>,
    avatar_url: String,
    html_url: String,
    public_repos: u64,
    #[serde(default)]
    total_private_repos: u64,
}

async fn fetch_user(token: &str) -> Result<GhUser, String> {
    let v = api(reqwest::Method::GET, "/user", token, None).await?;
    Ok(GhUser {
        id: v["id"].as_u64().unwrap_or(0),
        login: v["login"].as_str().unwrap_or("").into(),
        name: v["name"].as_str().map(String::from),
        avatar_url: v["avatar_url"].as_str().unwrap_or("").into(),
        html_url: v["html_url"].as_str().unwrap_or("").into(),
        public_repos: v["public_repos"].as_u64().unwrap_or(0),
        total_private_repos: v["total_private_repos"].as_u64().unwrap_or(0),
    })
}

async fn save_and_fetch(token: String) -> Result<GhUser, String> {
    let token = token.trim().to_string();
    let user = fetch_user(&token).await?;
    entry()?.set_password(&token).map_err(|e| format!("保存令牌失败：{e}"))?;
    Ok(user)
}

#[tauri::command]
pub async fn gh_status() -> Result<Option<GhUser>, String> {
    let Some(tok) = stored_token() else { return Ok(None) };
    match fetch_user(&tok).await {
        Ok(u) => Ok(Some(u)),
        Err(e) if e.contains("无效或已过期") => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn gh_set_token(token: String) -> Result<GhUser, String> {
    save_and_fetch(token).await
}

/// 复用 GitHub CLI（gh）已有的登录。
#[tauri::command]
pub async fn gh_import_cli() -> Result<GhUser, String> {
    let out = tauri::async_runtime::spawn_blocking(|| hidden_command("gh").args(["auth", "token"]).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "没有找到 GitHub CLI（gh），请先安装或改用其他登录方式".to_string())?;
    if !out.status.success() {
        return Err("gh 尚未登录，请先在终端运行 gh auth login".into());
    }
    save_and_fetch(String::from_utf8_lossy(&out.stdout).into_owned()).await
}

#[tauri::command]
pub async fn gh_logout() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------- Device Flow

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[tauri::command]
pub async fn gh_device_start(client_id: String) -> Result<DeviceCode, String> {
    let v: Value = client()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.trim()), ("scope", "repo read:user workflow")])
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(err) = v["error_description"].as_str().or(v["error"].as_str()) {
        return Err(format!("GitHub 拒绝了请求：{err}（请确认 Client ID 正确且已启用 Device Flow）"));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or("").into(),
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    /// pending | slow_down | ok | expired | denied
    status: String,
    user: Option<GhUser>,
}

#[tauri::command]
pub async fn gh_device_poll(client_id: String, device_code: String) -> Result<PollResult, String> {
    let v: Value = client()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.trim()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(tok) = v["access_token"].as_str() {
        let user = save_and_fetch(tok.to_string()).await?;
        return Ok(PollResult { status: "ok".into(), user: Some(user) });
    }
    let status = match v["error"].as_str().unwrap_or("") {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" => "denied",
        other => return Err(format!("登录失败：{other}")),
    };
    Ok(PollResult { status: status.into(), user: None })
}

// ---------------------------------------------------------------- 仓库

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    full_name: String,
    name: String,
    private: bool,
    html_url: String,
    description: Option<String>,
    language: Option<String>,
    stars: u64,
    updated_at: String,
}

#[tauri::command]
pub async fn gh_repos() -> Result<Vec<Repo>, String> {
    let tok = stored_token().ok_or("尚未登录 GitHub")?;
    let v = api(reqwest::Method::GET, "/user/repos?sort=pushed&per_page=12&affiliation=owner", &tok, None).await?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .map(|r| Repo {
                    full_name: r["full_name"].as_str().unwrap_or("").into(),
                    name: r["name"].as_str().unwrap_or("").into(),
                    private: r["private"].as_bool().unwrap_or(false),
                    html_url: r["html_url"].as_str().unwrap_or("").into(),
                    description: r["description"].as_str().map(String::from),
                    language: r["language"].as_str().map(String::from),
                    stars: r["stargazers_count"].as_u64().unwrap_or(0),
                    updated_at: r["pushed_at"].as_str().unwrap_or("").into(),
                })
                .collect()
        })
        .unwrap_or_default())
}

// ---------------------------------------------------------------- Pull Request

/// 从远程地址解析 owner/repo：支持 https://github.com/o/r(.git) 与 git@github.com:o/r.git
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let (o, r) = rest.split_once('/')?;
    (!o.is_empty() && !r.is_empty() && !r.contains('/')).then(|| (o.to_string(), r.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    owner: String,
    repo: String,
    branch: String,
    base: String,
    existing: Option<String>,
}

/// PR 对话框需要的信息：仓库、当前分支、默认目标分支、是否已有打开的 PR。
#[tauri::command]
pub async fn gh_pr_info(path: String) -> Result<PrInfo, String> {
    let p = path.clone();
    let (remote, branch, base) = tauri::async_runtime::spawn_blocking(move || {
        (
            git::run(&p, &["remote", "get-url", "origin"]).unwrap_or_default(),
            git::run(&p, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default().trim().to_string(),
            crate::aitools::default_branch(&p),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let (owner, repo) = parse_github_remote(&remote).ok_or("origin 不是 GitHub 仓库")?;
    let mut existing = None;
    if let Some(tok) = stored_token() {
        let q = format!("/repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}");
        if let Ok(v) = api(reqwest::Method::GET, &q, &tok, None).await {
            existing = v.as_array().and_then(|a| a.first()).and_then(|pr| pr["html_url"].as_str()).map(String::from);
        }
    }
    Ok(PrInfo { owner, repo, branch, base, existing })
}

#[tauri::command]
pub async fn gh_create_pr(path: String, title: String, body: String, base: String, draft: bool) -> Result<String, String> {
    let token = stored_token().ok_or("请先登录 GitHub")?;
    let p = path.clone();
    let (remote, branch) = tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
        let branch = git::run(&p, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
        // 确保分支已推送且是最新的
        git::run_net(&p, &["push", "-u", "origin", "HEAD"])?;
        Ok((git::run(&p, &["remote", "get-url", "origin"])?, branch))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (owner, repo) = parse_github_remote(&remote).ok_or("origin 不是 GitHub 仓库")?;
    if branch == base {
        return Err(format!("当前分支就是目标分支 {base}，请先切换到功能分支"));
    }
    let v = api(
        reqwest::Method::POST,
        &format!("/repos/{owner}/{repo}/pulls"),
        &token,
        Some(json!({ "title": title.trim(), "body": body, "head": branch, "base": base, "draft": draft })),
    )
    .await?;
    Ok(v["html_url"].as_str().unwrap_or("").to_string())
}

// ---------------------------------------------------------------- 一键发布

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOpts {
    path: String,
    name: String,
    description: String,
    private: bool,
    readme: bool,
    gitignore: bool,
    /// 例如 "mit"、"apache-2.0"；None 表示不添加
    license: Option<String>,
    /// 忽略扫描发现的问题继续发布
    force: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutcome {
    ok: bool,
    url: Option<String>,
    findings: Vec<Finding>,
}

#[cfg(test)]
mod tests {
    use super::parse_github_remote;

    #[test]
    fn remotes() {
        let want = Some(("me".to_string(), "proj".to_string()));
        assert_eq!(parse_github_remote("https://github.com/me/proj.git"), want);
        assert_eq!(parse_github_remote("https://github.com/me/proj"), want);
        assert_eq!(parse_github_remote("git@github.com:me/proj.git"), want);
        assert_eq!(parse_github_remote("https://gitlab.com/me/proj.git"), None);
    }
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    id: &'a str,
    state: &'a str,
    detail: String,
}

fn emit(app: &AppHandle, id: &str, state: &str, detail: impl Into<String>) {
    let _ = app.emit("publish-progress", Progress { id, state, detail: detail.into() });
}

/// 根据项目特征选择 GitHub 官方 .gitignore 模板。
fn detect_template(dir: &Path) -> &'static str {
    let has = |f: &str| dir.join(f).exists();
    let any_ext = |ext: &str| {
        std::fs::read_dir(dir)
            .map(|rd| rd.flatten().any(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case(ext))))
            .unwrap_or(false)
    };
    if has("Cargo.toml") {
        "Rust"
    } else if has("project.godot") {
        "Godot"
    } else if has("package.json") {
        "Node"
    } else if has("go.mod") {
        "Go"
    } else if has("pyproject.toml") || has("requirements.txt") || any_ext("py") {
        "Python"
    } else if any_ext("csproj") || any_ext("sln") {
        "VisualStudio"
    } else if has("pom.xml") || has("build.gradle") || has("build.gradle.kts") {
        "Java"
    } else {
        ""
    }
}

const BASE_IGNORE: &str = "\n# 系统与编辑器\n.DS_Store\nThumbs.db\ndesktop.ini\n.vscode/*\n!.vscode/extensions.json\n.idea/\n\n# 环境变量与密钥\n.env\n.env.*\n!.env.example\n*.pem\n";

async fn prepare_files(o: &PublishOpts, token: &str, user: &GhUser) -> Result<Vec<String>, String> {
    let dir = Path::new(&o.path);
    let mut created = Vec::new();
    if o.readme && !dir.join("README.md").exists() {
        let desc = if o.description.trim().is_empty() { String::new() } else { format!("{}\n", o.description.trim()) };
        std::fs::write(dir.join("README.md"), format!("# {}\n\n{desc}", o.name)).map_err(|e| e.to_string())?;
        created.push("README.md".to_string());
    }
    if o.gitignore && !dir.join(".gitignore").exists() {
        let tpl = detect_template(dir);
        let mut body = String::new();
        if !tpl.is_empty() {
            if let Ok(v) = api(reqwest::Method::GET, &format!("/gitignore/templates/{tpl}"), token, None).await {
                body = v["source"].as_str().unwrap_or("").to_string();
            }
        }
        body.push_str(BASE_IGNORE);
        std::fs::write(dir.join(".gitignore"), body).map_err(|e| e.to_string())?;
        created.push(if tpl.is_empty() { ".gitignore".into() } else { format!(".gitignore（{tpl}）") });
    }
    if let Some(key) = &o.license {
        let exists = ["LICENSE", "LICENSE.md", "LICENSE.txt"].iter().any(|f| dir.join(f).exists());
        if !exists {
            let v = api(reqwest::Method::GET, &format!("/licenses/{key}"), token, None).await?;
            let year = chrono_year();
            let holder = user.name.clone().unwrap_or_else(|| user.login.clone());
            let body = v["body"].as_str().unwrap_or("").replace("[year]", &year).replace("[fullname]", &holder);
            std::fs::write(dir.join("LICENSE"), body).map_err(|e| e.to_string())?;
            created.push(format!("LICENSE（{}）", v["spdx_id"].as_str().unwrap_or(key)));
        }
    }
    Ok(created)
}

fn chrono_year() -> String {
    // 不引入 chrono：由 Unix 时间推算年份
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut days = (secs / 86_400) as i64;
    let mut year = 1970;
    loop {
        let len = if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { 366 } else { 365 };
        if days < len {
            return year.to_string();
        }
        days -= len;
        year += 1;
    }
}

fn commit_initial(repo: &str, user: &GhUser) -> Result<Option<String>, String> {
    git::run(repo, &["add", "-A"])?;
    let has_head = git::run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let staged = git::run(repo, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return if has_head { Ok(None) } else { Err("项目里没有可提交的文件".into()) };
    }
    let msg = if has_head { "Prepare for GitHub" } else { "Initial commit" };
    let first = git::run(repo, &["commit", "-m", msg]);
    if let Err(e) = first {
        // 没配置 user.name / user.email 时，使用 GitHub 的 noreply 身份
        if e.contains("tell me who you are") || e.contains("user.email") || e.contains("user.name") {
            let name = format!("user.name={}", user.name.clone().unwrap_or_else(|| user.login.clone()));
            let email = format!("user.email={}+{}@users.noreply.github.com", user.id, user.login);
            git::run(repo, &["-c", &name, "-c", &email, "commit", "-m", msg])?;
        } else {
            return Err(e);
        }
    }
    Ok(Some(git::run(repo, &["log", "-1", "--format=%h %s"])?.trim().to_string()))
}

#[tauri::command]
pub async fn gh_publish(app: AppHandle, opts: PublishOpts) -> Result<PublishOutcome, String> {
    let token = stored_token().ok_or("请先登录 GitHub")?;
    let user = fetch_user(&token).await?;
    let path = opts.path.clone();
    if !Path::new(&path).is_dir() {
        return Err(format!("目录不存在：{path}"));
    }
    let fail = |app: &AppHandle, id: &str, e: String| {
        emit(app, id, "err", e.clone());
        e
    };

    // 1. 初始化
    emit(&app, "init", "run", "");
    let is_repo = git::run(&path, &["rev-parse", "--show-toplevel"]).is_ok();
    if is_repo {
        emit(&app, "init", "skip", "已是 Git 仓库");
    } else {
        git::run(&path, &["init", "-b", "main"]).map_err(|e| fail(&app, "init", e))?;
        emit(&app, "init", "ok", "git init -b main");
    }
    if let Ok(url) = git::run(&path, &["remote", "get-url", "origin"]) {
        let e = format!("已经关联了远程仓库：{}", url.trim());
        return Err(fail(&app, "init", e));
    }

    // 2. 生成文件
    emit(&app, "files", "run", "");
    let created = prepare_files(&opts, &token, &user).await.map_err(|e| fail(&app, "files", e))?;
    if created.is_empty() {
        emit(&app, "files", "skip", "已有所需文件");
    } else {
        emit(&app, "files", "ok", created.join("、"));
    }

    // 3. 扫描
    emit(&app, "scan", "run", "");
    let p2 = path.clone();
    let findings = tauri::async_runtime::spawn_blocking(move || {
        let files = git::list_z(&p2, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
        git::scan_files(&p2, &files)
    })
    .await
    .map_err(|e| e.to_string())?;
    let blocking = findings.iter().any(|f| f.level == "block");
    if blocking && !opts.force {
        emit(&app, "scan", "err", format!("发现 {} 个问题", findings.len()));
        return Ok(PublishOutcome { ok: false, url: None, findings });
    }
    emit(&app, "scan", "ok", if findings.is_empty() { "未发现密钥或超大文件".to_string() } else { format!("已忽略 {} 个提醒", findings.len()) });

    // 4. 提交
    emit(&app, "commit", "run", "");
    let p3 = path.clone();
    let u2 = user.clone();
    let committed = tauri::async_runtime::spawn_blocking(move || commit_initial(&p3, &u2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| fail(&app, "commit", e))?;
    match committed {
        Some(c) => emit(&app, "commit", "ok", c),
        None => emit(&app, "commit", "skip", "没有新的改动"),
    }

    // 5. 创建远程仓库
    emit(&app, "create", "run", "");
    let body = json!({ "name": opts.name.trim(), "description": opts.description.trim(), "private": opts.private, "auto_init": false });
    let repo = api(reqwest::Method::POST, "/user/repos", &token, Some(body))
        .await
        .map_err(|e| fail(&app, "create", if e.contains("422") { format!("仓库名「{}」已存在或不合法", opts.name.trim()) } else { e }))?;
    let clone_url = repo["clone_url"].as_str().unwrap_or("").to_string();
    let html_url = repo["html_url"].as_str().unwrap_or("").to_string();
    emit(&app, "create", "ok", repo["full_name"].as_str().unwrap_or("").to_string());

    // 6. 推送
    emit(&app, "push", "run", "");
    let p4 = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        git::run(&p4, &["remote", "add", "origin", &clone_url])?;
        git::run_net(&p4, &["push", "-u", "origin", "HEAD"])
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| fail(&app, "push", e))?;
    emit(&app, "push", "ok", "已推送并设置上游分支");

    Ok(PublishOutcome { ok: true, url: Some(html_url), findings })
}
