//! 读取 ~/.claude/projects 下的会话日志：项目列表 + token 用量统计。
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProject {
    id: String,
    name: String,
    path: String,
    sessions: usize,
    last_active: u64,
    exists: bool,
    is_git: bool,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    date: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    messages: u64,
}

pub fn claude_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".claude"))
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
                .collect()
        })
        .unwrap_or_default()
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文件夹名的路径编码有歧义（短横线既是分隔符也可能是原字符），所以优先读日志里的 cwd 字段。
fn cwd_from_logs(files: &[PathBuf]) -> Option<String> {
    for f in files {
        let Ok(file) = File::open(f) else { continue };
        for line in BufReader::new(file).lines().take(60).map_while(Result::ok) {
            if !line.contains("\"cwd\"") {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn list_claude_projects() -> Result<Vec<ClaudeProject>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = claude_home().ok_or("找不到用户目录")?.join("projects");
        let mut out = Vec::new();
        let rd = fs::read_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?;
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let mut files = jsonl_files(&dir);
            if files.is_empty() {
                continue;
            }
            files.sort_by_key(|f| std::cmp::Reverse(mtime_ms(f)));
            let last_active = mtime_ms(&files[0]);
            let path = cwd_from_logs(&files).unwrap_or_else(|| id.clone());
            let p = Path::new(&path);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            out.push(ClaudeProject {
                exists: p.is_dir(),
                is_git: p.join(".git").exists(),
                sessions: files.len(),
                id,
                name,
                path,
                last_active,
            });
        }
        out.sort_by_key(|p| std::cmp::Reverse(p.last_active));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// 按天汇总 token 用量。`project_id` 为空则统计全部项目；只读取最近 `days` 天内修改过的日志。
#[tauri::command]
pub async fn usage_summary(project_id: Option<String>, days: u64) -> Result<Vec<DayUsage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = claude_home().ok_or("找不到用户目录")?.join("projects");
        let dirs: Vec<PathBuf> = match &project_id {
            Some(id) => vec![root.join(id)],
            None => fs::read_dir(&root)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
        };
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let cutoff = now.saturating_sub(days * 86_400_000);
        let mut map: BTreeMap<String, DayUsage> = BTreeMap::new();
        let mut seen = HashSet::new();
        for d in dirs {
            for f in jsonl_files(&d) {
                if mtime_ms(&f) < cutoff {
                    continue;
                }
                let Ok(file) = File::open(&f) else { continue };
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if !line.contains("\"usage\"") {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                    let Some(msg) = v.get("message") else { continue };
                    let Some(u) = msg.get("usage") else { continue };
                    // 同一条消息可能被写入多行，按 message.id 去重
                    if let Some(mid) = msg.get("id").and_then(Value::as_str) {
                        if !seen.insert(mid.to_string()) {
                            continue;
                        }
                    }
                    let Some(ts) = v.get("timestamp").and_then(Value::as_str) else { continue };
                    let date = ts.get(..10).unwrap_or(ts).to_string();
                    let e = map
                        .entry(date.clone())
                        .or_insert_with(|| DayUsage { date, ..Default::default() });
                    e.input += num(u, "input_tokens");
                    e.output += num(u, "output_tokens");
                    e.cache_read += num(u, "cache_read_input_tokens");
                    e.cache_write += num(u, "cache_creation_input_tokens");
                    e.messages += 1;
                }
            }
        }
        Ok(map.into_values().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
