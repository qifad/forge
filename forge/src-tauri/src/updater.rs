//! 自动更新与版本发布。
//! - 发布：把安装包上传为 GitHub Release 的唯一附件；上传前统计仓库 Release 总大小，
//!   超过上限时从最旧的开始删除（连同标签）。
//! - 更新：读取设置里配置的仓库的最新 Release，下载安装包后以 `/S /UPDATE /R` 静默运行——
//!   与手动双击安装包走的是同一套「检测到已安装 → 原位更新」逻辑，只是去掉了界面，装完自动重启。
use crate::github::stored_token;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const API: &str = "https://api.github.com";

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    // 上传 / 下载安装包可能较慢，不设整体超时，只设连接超时
    C.get_or_init(|| reqwest::Client::builder().user_agent("Forge-Updater").connect_timeout(Duration::from_secs(20)).build().expect("http client"))
}

fn req(method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
    let mut r = client().request(method, url).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(t) = stored_token() {
        r = r.bearer_auth(t);
    }
    r
}

async fn call(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
    let mut r = req(method, &format!("{API}{path}"));
    if let Some(b) = body {
        r = r.json(&b);
    }
    let resp = r.send().await.map_err(|e| format!("网络错误：{e}"))?;
    let code = resp.status().as_u16();
    let v = resp.json().await.unwrap_or(Value::Null);
    Ok((code, v))
}

fn gh_err(code: u16, v: &Value) -> String {
    let msg = v["message"].as_str().unwrap_or("请求失败");
    match code {
        401 => "GitHub 令牌无效，请在 GitHub 页重新登录".into(),
        403 if msg.contains("rate limit") => "GitHub 接口调用次数已达上限，登录 GitHub 后可提高限额".into(),
        404 => "找不到仓库或 Release：仓库不存在，或者是私有仓库但尚未登录 GitHub".into(),
        _ => format!("GitHub {code}：{msg}"),
    }
}

fn check_repo(repo: &str) -> Result<(), String> {
    let ok = repo.split('/').count() == 2 && repo.split('/').all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)));
    if ok { Ok(()) } else { Err("仓库格式应为 owner/repo".into()) }
}

// ---------------------------------------------------------------- 版本比较

/// 比较语义化版本：1.2.10 > 1.2.9；正式版 > 同号预发布版（1.0.0 > 1.0.0-beta）。
pub fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let split = |s: &str| {
        let s = s.trim().trim_start_matches(['v', 'V']);
        let (core, pre) = s.split_once('-').map(|(c, p)| (c.to_string(), Some(p.to_string()))).unwrap_or((s.to_string(), None));
        let nums: Vec<u64> = core.split('.').map(|x| x.parse().unwrap_or(0)).collect();
        (nums, pre)
    };
    let (an, ap) = split(a);
    let (bn, bp) = split(b);
    for i in 0..an.len().max(bn.len()) {
        match an.get(i).unwrap_or(&0).cmp(bn.get(i).unwrap_or(&0)) {
            Equal => continue,
            o => return o,
        }
    }
    match (ap, bp) {
        (None, None) => Equal,
        (None, Some(_)) => Greater,
        (Some(_), None) => Less,
        (Some(x), Some(y)) => x.cmp(&y),
    }
}

/// 从安装包文件名里取版本号，例如 Forge_1.2.0_x64-setup.exe → 1.2.0
pub fn version_from_filename(name: &str) -> Option<String> {
    name.split(['_', ' ']).find(|p| {
        let p = p.trim_start_matches(['v', 'V']);
        p.split('-').next().is_some_and(|c| c.split('.').count() >= 2 && c.split('.').all(|n| !n.is_empty() && n.chars().all(|d| d.is_ascii_digit())))
    }).map(|p| p.trim_start_matches(['v', 'V']).to_string())
}

// ---------------------------------------------------------------- 检查更新

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    id: u64,
    tag: String,
    version: String,
    name: String,
    notes: String,
    published_at: String,
    prerelease: bool,
    html_url: String,
    asset_id: Option<u64>,
    asset_name: Option<String>,
    asset_size: u64,
    downloads: u64,
}

fn parse_release(r: &Value) -> ReleaseInfo {
    let assets = r["assets"].as_array().cloned().unwrap_or_default();
    let installer = assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.to_lowercase().ends_with(".exe"))).or_else(|| assets.first());
    let tag = r["tag_name"].as_str().unwrap_or("").to_string();
    ReleaseInfo {
        id: r["id"].as_u64().unwrap_or(0),
        version: tag.trim_start_matches(['v', 'V']).to_string(),
        tag,
        name: r["name"].as_str().unwrap_or("").into(),
        notes: r["body"].as_str().unwrap_or("").into(),
        published_at: r["published_at"].as_str().or(r["created_at"].as_str()).unwrap_or("").into(),
        prerelease: r["prerelease"].as_bool().unwrap_or(false),
        html_url: r["html_url"].as_str().unwrap_or("").into(),
        asset_id: installer.and_then(|a| a["id"].as_u64()),
        asset_name: installer.and_then(|a| a["name"].as_str()).map(String::from),
        asset_size: installer.and_then(|a| a["size"].as_u64()).unwrap_or(0),
        downloads: assets.iter().map(|a| a["download_count"].as_u64().unwrap_or(0)).sum(),
    }
}

async fn all_releases(repo: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for page in 1..=5 {
        let (code, v) = call(reqwest::Method::GET, &format!("/repos/{repo}/releases?per_page=100&page={page}"), None).await?;
        if code != 200 { return Err(gh_err(code, &v)) }
        let arr = v.as_array().cloned().unwrap_or_default();
        let n = arr.len();
        out.extend(arr);
        if n < 100 { break }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current: String,
    latest: Option<ReleaseInfo>,
    has_update: bool,
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn update_check(app: AppHandle, repo: String, include_prerelease: bool) -> Result<UpdateCheck, String> {
    check_repo(&repo)?;
    let current = app.package_info().version.to_string();
    let latest = all_releases(&repo)
        .await?
        .iter()
        .filter(|r| r["draft"] != true && (include_prerelease || r["prerelease"] != true))
        .map(parse_release)
        .filter(|r| r.asset_id.is_some())
        .max_by(|a, b| cmp_version(&a.version, &b.version));
    let has_update = latest.as_ref().is_some_and(|l| cmp_version(&l.version, &current).is_gt());
    Ok(UpdateCheck { current, latest, has_update })
}

#[derive(Serialize, Clone)]
struct DlProgress {
    downloaded: u64,
    total: u64,
}

/// 下载安装包并启动静默更新。成功返回后前端应立即退出程序，安装完成后安装包会自动重新启动 Forge。
#[tauri::command]
pub async fn update_install(app: AppHandle, repo: String, asset_id: u64, asset_name: String, expected_size: u64) -> Result<(), String> {
    check_repo(&repo)?;
    if asset_name.contains(['/', '\\']) || !asset_name.to_lowercase().ends_with(".exe") {
        return Err("安装包文件名不合法".into());
    }
    let dir = std::env::temp_dir().join("forge-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&asset_name);
    let resp = req(reqwest::Method::GET, &format!("{API}/repos/{repo}/releases/assets/{asset_id}"))
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(expected_size);
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut resp = resp;
    let mut got = 0u64;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(120) {
            let _ = app.emit("update-progress", DlProgress { downloaded: got, total });
            last = std::time::Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let _ = app.emit("update-progress", DlProgress { downloaded: got, total });
    if expected_size > 0 && got != expected_size {
        let _ = std::fs::remove_file(&path);
        return Err(format!("下载不完整（{got} / {expected_size} 字节），请重试"));
    }
    // 与手动运行安装包同一套逻辑：/S 静默、/UPDATE 原位更新且拒绝降级、/R 装完重新启动
    std::process::Command::new(&path).args(["/S", "/UPDATE", "/R"]).spawn().map_err(|e| format!("启动安装程序失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    app.exit(0);
}

// ---------------------------------------------------------------- 发布仓库管理

#[tauri::command]
pub async fn release_repo_create(name: String, private: bool) -> Result<String, String> {
    stored_token().ok_or("请先在 GitHub 页登录")?;
    // auto_init：创建一个初始提交，否则空仓库无法打标签和创建 Release
    let (code, v) = call(reqwest::Method::POST, "/user/repos", Some(json!({ "name": name.trim(), "private": private, "auto_init": true, "description": "Forge 安装包发布仓库（由 Forge 自动管理）" }))).await?;
    if code == 201 { Ok(v["full_name"].as_str().unwrap_or("").to_string()) } else if code == 422 { Err(format!("仓库「{}」已存在或名称不合法", name.trim())) } else { Err(gh_err(code, &v)) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoReleases {
    exists: bool,
    private: bool,
    releases: Vec<ReleaseInfo>,
    total_size: u64,
}

#[tauri::command]
pub async fn release_list(repo: String) -> Result<RepoReleases, String> {
    check_repo(&repo)?;
    let (code, v) = call(reqwest::Method::GET, &format!("/repos/{repo}"), None).await?;
    if code == 404 {
        return Ok(RepoReleases { exists: false, private: false, releases: vec![], total_size: 0 });
    }
    if code != 200 { return Err(gh_err(code, &v)) }
    let raw = all_releases(&repo).await?;
    let total_size = raw.iter().map(release_bytes).sum();
    let mut releases: Vec<ReleaseInfo> = raw.iter().map(parse_release).collect();
    releases.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    Ok(RepoReleases { exists: true, private: v["private"].as_bool().unwrap_or(false), releases, total_size })
}

fn release_bytes(r: &Value) -> u64 {
    r["assets"].as_array().map(|a| a.iter().map(|x| x["size"].as_u64().unwrap_or(0)).sum()).unwrap_or(0)
}

async fn delete_release(repo: &str, id: u64, tag: &str) -> Result<(), String> {
    let (code, v) = call(reqwest::Method::DELETE, &format!("/repos/{repo}/releases/{id}"), None).await?;
    if code != 204 && code != 404 { return Err(gh_err(code, &v)) }
    if !tag.is_empty() {
        // 标签删除失败不影响结果（可能本就不存在）
        let _ = call(reqwest::Method::DELETE, &format!("/repos/{repo}/git/refs/tags/{tag}"), None).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn release_delete(repo: String, id: u64, tag: String) -> Result<(), String> {
    check_repo(&repo)?;
    stored_token().ok_or("请先在 GitHub 页登录")?;
    delete_release(&repo, id, &tag).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstaller {
    path: String,
    name: String,
    size: u64,
    modified: i64,
    version: Option<String>,
}

/// 列出文件夹里的安装包（*.exe 且文件名含 setup），按修改时间倒序。
#[tauri::command]
pub fn release_find_installers(dir: String) -> Result<Vec<LocalInstaller>, String> {
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{dir}：{e}"))?;
    let mut out: Vec<LocalInstaller> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().to_string();
            let low = name.to_lowercase();
            if !(low.ends_with(".exe") && low.contains("setup")) { return None }
            let meta = e.metadata().ok()?;
            Some(LocalInstaller {
                version: version_from_filename(&name),
                path: p.to_string_lossy().into(),
                size: meta.len(),
                modified: meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64,
                name,
            })
        })
        .collect();
    out.sort_by_key(|i| std::cmp::Reverse(i.modified));
    Ok(out)
}

// ---------------------------------------------------------------- 发布

#[derive(Serialize, Clone)]
struct Step<'a> {
    id: &'a str,
    state: &'a str,
    detail: String,
}

fn step(app: &AppHandle, id: &str, state: &str, detail: impl Into<String>) {
    let _ = app.emit("release-progress", Step { id, state, detail: detail.into() });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    url: String,
    deleted: Vec<String>,
    total_after: u64,
}

fn mb(b: u64) -> String {
    format!("{:.1} MB", b as f64 / 1024.0 / 1024.0)
}

/// 发布一个版本：只上传安装包。上传前若「现有总大小 + 新安装包」超过上限，从最旧的 Release 开始删除。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn release_publish(app: AppHandle, repo: String, installer: String, version: String, notes: String, prerelease: bool, overwrite: bool, limit_mb: u64) -> Result<PublishResult, String> {
    check_repo(&repo)?;
    stored_token().ok_or("请先在 GitHub 页登录")?;
    let path = PathBuf::from(&installer);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("安装包路径不合法")?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取安装包失败：{e}"))?;
    let size = bytes.len() as u64;
    let version = version.trim().trim_start_matches(['v', 'V']).to_string();
    if version.is_empty() { return Err("请填写版本号".into()) }
    let tag = format!("v{version}");
    let limit = limit_mb.max(1) * 1024 * 1024;
    let fail = |app: &AppHandle, id: &str, e: String| { step(app, id, "err", e.clone()); e };

    // 1. 检查仓库与现有 Release
    step(&app, "check", "run", "");
    let (code, v) = call(reqwest::Method::GET, &format!("/repos/{repo}"), None).await?;
    if code != 200 { return Err(fail(&app, "check", gh_err(code, &v))) }
    let default_branch = v["default_branch"].as_str().unwrap_or("main").to_string();
    let mut releases = all_releases(&repo).await.map_err(|e| fail(&app, "check", e))?;
    if let Some(same) = releases.iter().find(|r| r["tag_name"] == tag.as_str()).cloned() {
        if !overwrite {
            return Err(fail(&app, "check", format!("{tag} 已经发布过；如需替换请勾选「覆盖同版本」")));
        }
        delete_release(&repo, same["id"].as_u64().unwrap_or(0), &tag).await.map_err(|e| fail(&app, "check", e))?;
        releases.retain(|r| r["tag_name"] != tag.as_str());
    }
    if let Some(newer) = releases.iter().map(parse_release).filter(|r| cmp_version(&r.version, &version).is_gt()).max_by(|a, b| cmp_version(&a.version, &b.version)) {
        step(&app, "check", "ok", format!("注意：仓库里已有更高的版本 {}，用户不会收到这个版本的更新", newer.tag));
    } else {
        step(&app, "check", "ok", format!("{} 个 Release，共 {}", releases.len(), mb(releases.iter().map(release_bytes).sum())));
    }

    // 2. 容量检查与清理
    step(&app, "prune", "run", "");
    if size > limit {
        return Err(fail(&app, "prune", format!("安装包 {} 本身就超过了上限 {}", mb(size), mb(limit))));
    }
    releases.sort_by(|a, b| a["created_at"].as_str().unwrap_or("").cmp(b["created_at"].as_str().unwrap_or("")));
    let mut total: u64 = releases.iter().map(release_bytes).sum();
    let mut deleted = Vec::new();
    for r in &releases {
        if total + size <= limit { break }
        let t = r["tag_name"].as_str().unwrap_or("").to_string();
        delete_release(&repo, r["id"].as_u64().unwrap_or(0), &t).await.map_err(|e| fail(&app, "prune", e))?;
        total -= release_bytes(r);
        deleted.push(t);
    }
    step(&app, "prune", if deleted.is_empty() { "skip" } else { "ok" }, if deleted.is_empty() {
        format!("容量充足：{} + {} ≤ {}", mb(total), mb(size), mb(limit))
    } else {
        format!("已删除最旧的 {} 个版本：{}", deleted.len(), deleted.join("、"))
    });

    // 3. 创建 Release
    step(&app, "create", "run", "");
    let (code, rel) = call(reqwest::Method::POST, &format!("/repos/{repo}/releases"), Some(json!({
        "tag_name": tag, "target_commitish": default_branch, "name": format!("Forge {version}"), "body": notes, "prerelease": prerelease, "draft": false
    }))).await?;
    if code != 201 { return Err(fail(&app, "create", gh_err(code, &rel))) }
    let rel_id = rel["id"].as_u64().unwrap_or(0);
    let html = rel["html_url"].as_str().unwrap_or("").to_string();
    step(&app, "create", "ok", tag.clone());

    // 4. 上传安装包（唯一的附件）
    step(&app, "upload", "run", format!("{name} · {}", mb(size)));
    let up = req(reqwest::Method::POST, &format!("https://uploads.github.com/repos/{repo}/releases/{rel_id}/assets?name={}", urlencode(&name)))
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("上传失败：{e}"));
    let up = match up {
        Ok(r) => r,
        Err(e) => {
            let _ = delete_release(&repo, rel_id, &tag).await;
            return Err(fail(&app, "upload", e));
        }
    };
    if !up.status().is_success() {
        let code = up.status().as_u16();
        let v: Value = up.json().await.unwrap_or(Value::Null);
        // 上传失败就撤掉这个空 Release，避免用户检查到一个没有安装包的版本
        let _ = delete_release(&repo, rel_id, &tag).await;
        return Err(fail(&app, "upload", gh_err(code, &v)));
    }
    step(&app, "upload", "ok", format!("{name} · {}", mb(size)));
    Ok(PublishResult { url: html, deleted, total_after: total + size })
}

fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn versions() {
        assert_eq!(cmp_version("0.2.0", "0.1.9"), Greater);
        assert_eq!(cmp_version("v1.2.10", "1.2.9"), Greater);
        assert_eq!(cmp_version("1.0.0", "1.0.0-beta.1"), Greater);
        assert_eq!(cmp_version("1.0", "1.0.0"), Equal);
        assert_eq!(cmp_version("0.1.0", "0.1.1"), Less);
        assert_eq!(version_from_filename("Forge_0.3.1_x64-setup.exe").as_deref(), Some("0.3.1"));
        assert_eq!(version_from_filename("Forge_1.0.0-beta.2_x64-setup.exe").as_deref(), Some("1.0.0-beta.2"));
        assert_eq!(version_from_filename("setup.exe"), None);
        assert_eq!(urlencode("Forge_0.1.0 x.exe"), "Forge_0.1.0%20x.exe");
    }

    #[test]
    fn picks_installer_asset() {
        let r = json!({"id": 1, "tag_name": "v0.2.0", "assets": [{"id": 7, "name": "notes.txt", "size": 3}, {"id": 9, "name": "Forge_0.2.0_x64-setup.exe", "size": 100, "download_count": 4}]});
        let p = parse_release(&r);
        assert_eq!((p.version.as_str(), p.asset_id, p.asset_size), ("0.2.0", Some(9), 100));
        assert_eq!(release_bytes(&r), 103);
    }
}
