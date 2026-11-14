//! Claude 配置：CLAUDE.md 记忆文件、MCP 服务器、settings.json 概览。
//! 原则：~/.claude.json 由 Claude Code 自己频繁改写，本程序只读它；MCP 增删一律走官方 `claude mcp` 命令。
use crate::claude::claude_home;
use crate::system::hidden_command;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn home() -> Result<PathBuf, String> {
    claude_home().and_then(|p| p.parent().map(Path::to_path_buf)).ok_or_else(|| "找不到用户目录".into())
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

// ---------------------------------------------------------------- 记忆文件

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemFile {
    scope: String,
    label: String,
    hint: String,
    path: String,
    exists: bool,
    size: u64,
    modified: i64,
}

fn mem_candidates(project_path: Option<&str>, project_id: Option<&str>) -> Result<Vec<(String, String, String, PathBuf)>, String> {
    let ch = claude_home().ok_or("找不到用户目录")?;
    let mut v = vec![("user".into(), "用户记忆".into(), "所有项目共享 · ~/.claude/CLAUDE.md".into(), ch.join("CLAUDE.md"))];
    if let Some(p) = project_path.filter(|p| Path::new(p).is_dir()) {
        let p = Path::new(p);
        v.push(("project".into(), "项目记忆".into(), "随仓库提交，团队共享 · CLAUDE.md".into(), p.join("CLAUDE.md")));
        v.push(("project".into(), "项目记忆（.claude 目录）".into(), "另一种放置位置 · .claude/CLAUDE.md".into(), p.join(".claude").join("CLAUDE.md")));
        v.push(("local".into(), "本地记忆".into(), "只在本机生效，不应提交 · CLAUDE.local.md".into(), p.join("CLAUDE.local.md")));
    }
    if let Some(id) = project_id.filter(|id| !id.contains(['/', '\\']) && !id.contains("..")) {
        let dir = ch.join("projects").join(id).join("memory");
        if let Ok(rd) = fs::read_dir(&dir) {
            let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect();
            files.sort();
            for f in files {
                let name = f.file_name().unwrap_or_default().to_string_lossy().to_string();
                v.push(("auto".into(), name, "Claude 自动记忆".into(), f));
            }
        }
    }
    Ok(v)
}

#[tauri::command]
pub fn memory_files(project_path: Option<String>, project_id: Option<String>) -> Result<Vec<MemFile>, String> {
    Ok(mem_candidates(project_path.as_deref(), project_id.as_deref())?
        .into_iter()
        .map(|(scope, label, hint, p)| {
            let meta = fs::metadata(&p).ok();
            MemFile {
                scope,
                label,
                hint,
                exists: meta.is_some(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
                path: p.to_string_lossy().into(),
            }
        })
        .collect())
}

/// 只允许读写 memory_files 列出的路径。
fn check_allowed(path: &str, project_path: Option<&str>, project_id: Option<&str>) -> Result<PathBuf, String> {
    let ok = mem_candidates(project_path, project_id)?.into_iter().find(|c| c.3 == Path::new(path));
    ok.map(|c| c.3).ok_or_else(|| "不允许访问该文件".into())
}

#[tauri::command]
pub fn memory_read(path: String, project_path: Option<String>, project_id: Option<String>) -> Result<String, String> {
    let p = check_allowed(&path, project_path.as_deref(), project_id.as_deref())?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn memory_write(path: String, content: String, project_path: Option<String>, project_id: Option<String>) -> Result<(), String> {
    let p = check_allowed(&path, project_path.as_deref(), project_id.as_deref())?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 先写临时文件再替换，避免写一半时被 Claude 读到
    let tmp = p.with_extension("md.forge-tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- MCP

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    name: String,
    /// user | local | project
    scope: String,
    /// stdio | http | sse
    transport: String,
    target: String,
    env_keys: Vec<String>,
    disabled: bool,
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn servers_from(obj: Option<&Value>, scope: &str, disabled: &[String], out: &mut Vec<McpServer>) {
    let Some(map) = obj.and_then(Value::as_object) else { return };
    for (name, s) in map {
        let url = s["url"].as_str();
        let transport = s["type"].as_str().unwrap_or(if url.is_some() { "http" } else { "stdio" }).to_string();
        let target = match url {
            Some(u) => u.to_string(),
            None => {
                let args: Vec<&str> = s["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                format!("{} {}", s["command"].as_str().unwrap_or(""), args.join(" ")).trim().to_string()
            }
        };
        out.push(McpServer {
            name: name.clone(),
            scope: scope.into(),
            transport,
            target,
            env_keys: s["env"].as_object().map(|e| e.keys().cloned().collect()).unwrap_or_default(),
            disabled: disabled.contains(name),
        });
    }
}

#[tauri::command]
pub fn mcp_list(project_path: Option<String>) -> Result<Vec<McpServer>, String> {
    let cj = read_json(&home()?.join(".claude.json")).unwrap_or(Value::Null);
    let mut out = Vec::new();
    servers_from(cj.get("mcpServers"), "user", &[], &mut out);
    if let Some(pp) = project_path {
        let key = norm(&pp);
        let proj = cj["projects"].as_object().and_then(|m| m.iter().find(|(k, _)| norm(k) == key).map(|(_, v)| v));
        let disabled: Vec<String> = proj
            .and_then(|p| p["disabledMcpjsonServers"].as_array())
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        servers_from(proj.and_then(|p| p.get("mcpServers")), "local", &[], &mut out);
        let mcpjson = read_json(&Path::new(&pp).join(".mcp.json"));
        servers_from(mcpjson.as_ref().and_then(|v| v.get("mcpServers")), "project", &disabled, &mut out);
    }
    Ok(out)
}

fn claude_cli(cwd: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut c = hidden_command("cmd");
    c.arg("/c").arg("claude").args(args);
    if let Some(d) = cwd.filter(|d| Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    let out = c.output().map_err(|e| format!("无法运行 claude：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(stdout)
    } else if stderr.contains("not recognized") || stderr.contains("不是内部或外部命令") {
        Err("没有找到 claude 命令，请确认已安装 Claude Code 并加入 PATH".into())
    } else {
        Err(format!("{}{}", stderr.trim(), stdout.trim()).trim().to_string())
    }
}

#[tauri::command]
pub async fn claude_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| claude_cli(None, &["--version"]).map(|s| s.trim().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Health {
    name: String,
    /// ok | fail | auth | unknown
    status: String,
    detail: String,
}

/// 解析 `claude mcp list` 的输出，例如：`github: https://… (HTTP) - ✓ Connected`
pub fn parse_health(out: &str) -> Vec<Health> {
    out.lines()
        .filter_map(|l| {
            let (name, rest) = l.split_once(": ")?;
            if name.contains(' ') || name.is_empty() { return None }
            let (_, st) = rest.rsplit_once(" - ")?;
            let st = st.trim();
            let status = if st.contains('✓') || st.to_lowercase().contains("connected") && !st.to_lowercase().contains("fail") {
                "ok"
            } else if st.to_lowercase().contains("auth") {
                "auth"
            } else if st.contains('✗') || st.to_lowercase().contains("fail") {
                "fail"
            } else {
                "unknown"
            };
            Some(Health { name: name.trim().into(), status: status.into(), detail: st.trim_start_matches(['✓', '✗', '⚠', ' ']).into() })
        })
        .collect()
}

#[tauri::command]
pub async fn mcp_health(project_path: Option<String>) -> Result<Vec<Health>, String> {
    tauri::async_runtime::spawn_blocking(move || claude_cli(project_path.as_deref(), &["mcp", "list"]).map(|s| parse_health(&s)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_add(project_path: Option<String>, scope: String, name: String, transport: String, target: String, args: Vec<String>, env: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !["user", "local", "project"].contains(&scope.as_str()) { return Err("无效的作用域".into()) }
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("名称只能包含字母、数字、- 和 _".into());
        }
        let mut a: Vec<String> = vec!["mcp".into(), "add".into(), "-s".into(), scope];
        if transport == "http" || transport == "sse" {
            a.extend(["-t".into(), transport, name, target]);
        } else {
            for e in env.iter().filter(|e| e.contains('=')) {
                a.extend(["-e".into(), e.clone()]);
            }
            a.extend([name, "--".into(), target]);
            a.extend(args);
        }
        let refs: Vec<&str> = a.iter().map(String::as_str).collect();
        claude_cli(project_path.as_deref(), &refs).map(|s| s.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_remove(project_path: Option<String>, name: String, scope: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || claude_cli(project_path.as_deref(), &["mcp", "remove", &name, "-s", &scope]).map(|s| s.trim().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- settings.json 概览（只读，敏感值打码）

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    scope: String,
    label: String,
    path: String,
    exists: bool,
    model: Option<String>,
    env: Vec<(String, String)>,
    allow: Vec<String>,
    deny: Vec<String>,
    hooks: Vec<(String, usize)>,
    other: Vec<String>,
    error: Option<String>,
}

fn is_secret(k: &str) -> bool {
    let k = k.to_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "AUTH", "CREDENTIAL"].iter().any(|s| k.contains(s))
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

#[tauri::command]
pub fn settings_overview(project_path: Option<String>) -> Result<Vec<SettingsFile>, String> {
    let ch = claude_home().ok_or("找不到用户目录")?;
    let mut files = vec![("user", "用户设置", ch.join("settings.json"))];
    if let Some(p) = project_path.as_deref().filter(|p| Path::new(p).is_dir()) {
        files.push(("project", "项目设置（共享）", Path::new(p).join(".claude").join("settings.json")));
        files.push(("local", "项目设置（本机）", Path::new(p).join(".claude").join("settings.local.json")));
    }
    Ok(files
        .into_iter()
        .map(|(scope, label, p)| {
            let mut s = SettingsFile { scope: scope.into(), label: label.into(), path: p.to_string_lossy().into(), exists: p.exists(), model: None, env: vec![], allow: vec![], deny: vec![], hooks: vec![], other: vec![], error: None };
            if !s.exists { return s }
            let v: Value = match fs::read_to_string(&p).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
                Ok(v) => v,
                Err(e) => { s.error = Some(format!("解析失败：{e}")); return s }
            };
            s.model = v["model"].as_str().map(String::from);
            if let Some(env) = v["env"].as_object() {
                s.env = env.iter().map(|(k, val)| {
                    let shown = if is_secret(k) { "已设置（已隐藏）".to_string() } else { val.as_str().map(String::from).unwrap_or_else(|| val.to_string()) };
                    (k.clone(), shown)
                }).collect();
            }
            s.allow = strings(&v["permissions"]["allow"]);
            s.deny = strings(&v["permissions"]["deny"]);
            if let Some(h) = v["hooks"].as_object() {
                s.hooks = h.iter().map(|(k, val)| (k.clone(), val.as_array().map(|a| a.len()).unwrap_or(1))).collect();
            }
            if let Some(o) = v.as_object() {
                s.other = o.keys().filter(|k| !["model", "env", "permissions", "hooks", "$schema"].contains(&k.as_str())).cloned().collect();
            }
            s
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mcp_list() {
        let out = "Checking MCP server health...\n\ngithub: https://api.githubcopilot.com/mcp (HTTP) - ✓ Connected\nfs: npx -y @modelcontextprotocol/server-filesystem C:/x - ✗ Failed to connect\nlinear: https://mcp.linear.app/sse (SSE) - ⚠ Needs authentication\n";
        let h = parse_health(out);
        assert_eq!(h.len(), 3);
        assert_eq!((h[0].name.as_str(), h[0].status.as_str()), ("github", "ok"));
        assert_eq!(h[1].status, "fail");
        assert_eq!(h[2].status, "auth");
    }

    #[test]
    fn secrets_are_detected() {
        assert!(is_secret("ANTHROPIC_AUTH_TOKEN"));
        assert!(is_secret("OPENAI_API_KEY"));
        assert!(!is_secret("ANTHROPIC_BASE_URL"));
    }
}
