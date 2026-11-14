//! Claude Code 会话：列表（带缓存）、全文搜索、对话回放、用量报表。
//! 每个 ~/.claude/projects/<项目>/<sessionId>.jsonl 是一个会话。
use crate::claude::claude_home;
use chrono::{DateTime, Datelike, Local, Timelike};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

fn ts_ms(v: &Value) -> Option<i64> {
    let s = v.get("timestamp")?.as_str()?;
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn projects_root() -> Result<PathBuf, String> {
    Ok(claude_home().ok_or("找不到用户目录")?.join("projects"))
}

/// 提取用户 / 助手消息中的纯文本（忽略工具调用与结果）。
fn message_text(v: &Value) -> String {
    match v.pointer("/message/content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|c| c["type"] == "text")
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 系统注入的伪用户消息（命令回显、提醒等）以 '<' 开头。
fn is_meta_text(t: &str) -> bool {
    let t = t.trim_start();
    t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:")
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim().replace(['\r', '\n'], " ");
    if s.chars().count() <= n { s } else { s.chars().take(n).collect::<String>() + "…" }
}

// ---------------------------------------------------------------- 会话列表

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    project_id: String,
    cwd: String,
    title: String,
    first_prompt: String,
    started: i64,
    updated: i64,
    user_turns: u32,
    assistant_msgs: u32,
    models: Vec<String>,
    tokens: u64,
    cost: Option<f64>,
    git_branch: Option<String>,
    size: u64,
}

fn summarize(project_id: &str, file: &Path) -> Option<SessionSummary> {
    let meta = fs::metadata(file).ok()?;
    let mut s = SessionSummary {
        id: file.file_stem()?.to_string_lossy().into(),
        project_id: project_id.into(),
        size: meta.len(),
        ..Default::default()
    };
    let (mut custom, mut agent) = (None::<String>, None::<String>);
    let mut models = Vec::<String>::new();
    let mut seen = HashSet::new();
    for line in BufReader::new(File::open(file).ok()?).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let t = v["type"].as_str().unwrap_or("");
        if let Some(ms) = ts_ms(&v) {
            if s.started == 0 || ms < s.started { s.started = ms }
            if ms > s.updated { s.updated = ms }
        }
        match t {
            "custom-title" => custom = v["customTitle"].as_str().map(String::from).filter(|x| !x.is_empty()),
            "agent-name" => agent = v["agentName"].as_str().map(String::from).filter(|x| !x.is_empty()),
            "cost-state" => s.cost = v["totalCostUSD"].as_f64().or(s.cost),
            "user" | "assistant" if v["isSidechain"] != true => {
                if s.cwd.is_empty() { s.cwd = v["cwd"].as_str().unwrap_or("").into() }
                if let Some(b) = v["gitBranch"].as_str().filter(|b| !b.is_empty()) { s.git_branch = Some(b.into()) }
                if t == "user" {
                    let text = message_text(&v);
                    if !is_meta_text(&text) {
                        s.user_turns += 1;
                        if s.first_prompt.is_empty() { s.first_prompt = truncate(&text, 140) }
                    }
                } else {
                    let msg = &v["message"];
                    if let Some(id) = msg["id"].as_str() {
                        if !seen.insert(id.to_string()) { continue }
                    }
                    s.assistant_msgs += 1;
                    if let Some(m) = msg["model"].as_str().filter(|m| !m.starts_with('<')) {
                        if !models.iter().any(|x| x == m) { models.push(m.into()) }
                    }
                    let u = &msg["usage"];
                    s.tokens += ["input_tokens", "output_tokens", "cache_creation_input_tokens"]
                        .iter()
                        .map(|k| u[*k].as_u64().unwrap_or(0))
                        .sum::<u64>();
                }
            }
            _ => {}
        }
    }
    if s.updated == 0 {
        s.updated = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    }
    s.title = custom.or(agent).unwrap_or_else(|| if s.first_prompt.is_empty() { "（空会话）".into() } else { truncate(&s.first_prompt, 60) });
    s.models = models;
    Some(s)
}

/// (路径) → (修改时间, 大小, 摘要)。会话文件只会追加，按 mtime+size 失效即可。
fn cache() -> &'static Mutex<HashMap<PathBuf, (u64, u64, SessionSummary)>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, (u64, u64, SessionSummary)>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn session_files(project_id: Option<&str>) -> Result<Vec<(String, PathBuf)>, String> {
    let root = projects_root()?;
    let dirs: Vec<PathBuf> = match project_id {
        Some(id) => vec![root.join(id)],
        None => fs::read_dir(&root).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect(),
    };
    let mut out = Vec::new();
    for d in dirs {
        let pid = d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "jsonl") {
                    out.push((pid.clone(), p));
                }
            }
        }
    }
    Ok(out)
}

pub fn list_sessions_inner(project_id: Option<&str>) -> Result<Vec<SessionSummary>, String> {
    let files = session_files(project_id)?;
    let mut out = Vec::with_capacity(files.len());
    for (pid, f) in files {
        let Ok(meta) = fs::metadata(&f) else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        if let Some((m, sz, s)) = cache().lock().unwrap().get(&f) {
            if *m == mtime && *sz == meta.len() {
                out.push(s.clone());
                continue;
            }
        }
        if let Some(s) = summarize(&pid, &f) {
            cache().lock().unwrap().insert(f.clone(), (mtime, meta.len(), s.clone()));
            out.push(s);
        }
    }
    out.retain(|s| s.user_turns > 0 || s.assistant_msgs > 0);
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    Ok(out)
}

#[tauri::command]
pub async fn list_sessions(project_id: Option<String>) -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions_inner(project_id.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 全文搜索

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    project_id: String,
    session_id: String,
    role: String,
    snippet: String,
    /// snippet 中命中位置（按字符计）
    at: usize,
    len: usize,
    time: i64,
}

fn snippet(text: &str, lower: &str, q: &str) -> Option<(String, usize, usize)> {
    let byte = lower.find(q)?;
    // lower 与 text 的字节偏移可能不同（大小写转换改变长度时），按字符位置换算
    let ci = lower[..byte].chars().count();
    let qlen = q.chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = ci.saturating_sub(50);
    let end = (ci + qlen + 90).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>().replace(['\r', '\n'], " ");
    let mut at = ci - start;
    if start > 0 { s.insert(0, '…'); at += 1 }
    if end < chars.len() { s.push('…') }
    Some((s, at, qlen))
}

#[tauri::command]
pub async fn search_sessions(query: String, project_id: Option<String>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.chars().count() < 2 {
            return Ok(vec![]);
        }
        let mut files = session_files(project_id.as_deref())?;
        files.sort_by_key(|(_, f)| std::cmp::Reverse(fs::metadata(f).and_then(|m| m.modified()).ok()));
        let mut hits = Vec::new();
        'files: for (pid, f) in files {
            let sid = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let Ok(file) = File::open(&f) else { continue };
            let mut per = 0;
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if !line.to_lowercase().contains(&q) { continue }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let role = v["type"].as_str().unwrap_or("");
                if (role != "user" && role != "assistant") || v["isSidechain"] == true { continue }
                let text = message_text(&v);
                if role == "user" && is_meta_text(&text) { continue }
                let lower = text.to_lowercase();
                if let Some((snip, at, len)) = snippet(&text, &lower, &q) {
                    hits.push(SearchHit { project_id: pid.clone(), session_id: sid.clone(), role: role.into(), snippet: snip, at, len, time: ts_ms(&v).unwrap_or(0) });
                    per += 1;
                    if hits.len() >= 150 { break 'files }
                    if per >= 3 { continue 'files }
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 对话回放

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    role: String,
    /// text | thinking | tool_use | tool_result
    kind: String,
    text: String,
    tool: Option<String>,
    is_error: bool,
    meta: bool,
    sidechain: bool,
    time: i64,
    model: Option<String>,
}

fn compact_json(v: &Value, n: usize) -> String {
    let s = match v {
        Value::Object(m) if m.len() == 1 => m.values().next().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).unwrap_or_default(),
        _ => v.to_string(),
    };
    truncate(&s, n)
}

fn tool_result_text(c: &Value) -> String {
    match &c["content"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn session_transcript(project_id: String, session_id: String) -> Result<Vec<Item>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if session_id.contains(['/', '\\', '.']) || project_id.contains(['/', '\\']) || project_id.contains("..") {
            return Err("非法的会话标识".into());
        }
        let f = projects_root()?.join(&project_id).join(format!("{session_id}.jsonl"));
        let file = File::open(&f).map_err(|e| format!("打开会话失败：{e}"))?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let role = v["type"].as_str().unwrap_or("");
            if role != "user" && role != "assistant" { continue }
            if let Some(u) = v["uuid"].as_str() {
                if !seen.insert(u.to_string()) { continue }
            }
            let time = ts_ms(&v).unwrap_or(0);
            let sidechain = v["isSidechain"] == true;
            let model = v.pointer("/message/model").and_then(Value::as_str).filter(|m| !m.starts_with('<')).map(String::from);
            let push = |out: &mut Vec<Item>, kind: &str, text: String, tool: Option<String>, is_error: bool, meta: bool| {
                out.push(Item { role: role.into(), kind: kind.into(), text, tool, is_error, meta, sidechain, time, model: model.clone() });
            };
            match v.pointer("/message/content") {
                Some(Value::String(s)) => push(&mut out, "text", s.clone(), None, false, role == "user" && is_meta_text(s)),
                Some(Value::Array(a)) => {
                    for c in a {
                        match c["type"].as_str().unwrap_or("") {
                            "text" => {
                                let t = c["text"].as_str().unwrap_or("").to_string();
                                let meta = role == "user" && is_meta_text(&t);
                                push(&mut out, "text", t, None, false, meta)
                            }
                            "thinking" => {
                                let t = c["thinking"].as_str().unwrap_or("");
                                if !t.is_empty() { push(&mut out, "thinking", truncate(t, 2000), None, false, false) }
                            }
                            "tool_use" => push(&mut out, "tool_use", compact_json(&c["input"], 300), c["name"].as_str().map(String::from), false, false),
                            "tool_result" => push(&mut out, "tool_result", truncate(&tool_result_text(c), 600), None, c["is_error"] == true, false),
                            "image" => push(&mut out, "text", "［图片］".into(), None, false, false),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            if out.len() > 4000 { break }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 用量报表

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    key: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    messages: u64,
}

impl Bucket {
    fn add(&mut self, u: &Value) {
        self.input += u["input_tokens"].as_u64().unwrap_or(0);
        self.output += u["output_tokens"].as_u64().unwrap_or(0);
        self.cache_read += u["cache_read_input_tokens"].as_u64().unwrap_or(0);
        self.cache_write += u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        self.messages += 1;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    start: i64,
    reset_at: i64,
    tokens: u64,
    messages: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    daily: Vec<Bucket>,
    by_model: Vec<Bucket>,
    by_project: Vec<Bucket>,
    /// 7×24：周一..周日 × 0..23 点的消息数（本地时间）
    heatmap: Vec<Vec<u32>>,
    window: Option<WindowInfo>,
    sessions: usize,
    cost: f64,
}

const FIVE_H: i64 = 5 * 3600 * 1000;

#[tauri::command]
pub async fn usage_report(days: i64) -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = chrono::Utc::now().timestamp_millis();
        let cutoff = now - days.max(1) * 86_400_000;
        let mut daily: BTreeMap<String, Bucket> = BTreeMap::new();
        let mut models: HashMap<String, Bucket> = HashMap::new();
        let mut projects: HashMap<String, Bucket> = HashMap::new();
        let mut heat = vec![vec![0u32; 24]; 7];
        let mut recent: Vec<(i64, u64)> = Vec::new();
        let mut seen = HashSet::new();
        let mut sessions = 0;
        let mut cost = 0.0;
        for (pid, f) in session_files(None)? {
            let recent_file = fs::metadata(&f).and_then(|m| m.modified()).ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64 >= cutoff).unwrap_or(true);
            if !recent_file { continue }
            let Ok(file) = File::open(&f) else { continue };
            let mut counted = false;
            let mut last_cost = None;
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if line.contains("\"cost-state\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) { last_cost = v["totalCostUSD"].as_f64().or(last_cost) }
                    continue;
                }
                if !line.contains("\"usage\"") { continue }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] != "assistant" { continue }
                let msg = &v["message"];
                if let Some(id) = msg["id"].as_str() {
                    if !seen.insert(id.to_string()) { continue }
                }
                let Some(ms) = ts_ms(&v) else { continue };
                if ms < cutoff { continue }
                let u = &msg["usage"];
                let local = DateTime::from_timestamp_millis(ms).unwrap_or_default().with_timezone(&Local);
                let day = local.format("%Y-%m-%d").to_string();
                daily.entry(day.clone()).or_insert_with(|| Bucket { key: day, ..Default::default() }).add(u);
                let model = msg["model"].as_str().unwrap_or("unknown");
                if !model.starts_with('<') {
                    models.entry(model.into()).or_insert_with(|| Bucket { key: model.into(), ..Default::default() }).add(u);
                }
                projects.entry(pid.clone()).or_insert_with(|| Bucket { key: pid.clone(), ..Default::default() }).add(u);
                heat[local.weekday().num_days_from_monday() as usize][local.hour() as usize] += 1;
                if ms >= now - 24 * 3600 * 1000 {
                    let t = u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0) + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                    recent.push((ms, t));
                }
                counted = true;
            }
            if counted { sessions += 1 }
            cost += last_cost.unwrap_or(0.0);
        }
        // 5 小时滚动窗口：从窗口外的第一条消息开始计时（估算）
        recent.sort_by_key(|x| x.0);
        let mut start: Option<i64> = None;
        let (mut wt, mut wm) = (0u64, 0u64);
        for (ms, t) in &recent {
            if start.map_or(true, |s| *ms >= s + FIVE_H) {
                start = Some(*ms);
                wt = 0;
                wm = 0;
            }
            wt += t;
            wm += 1;
        }
        let window = start.filter(|s| now < s + FIVE_H).map(|s| WindowInfo { start: s, reset_at: s + FIVE_H, tokens: wt, messages: wm });
        let sort = |m: HashMap<String, Bucket>| {
            let mut v: Vec<Bucket> = m.into_values().collect();
            v.sort_by_key(|b| std::cmp::Reverse(b.input + b.output + b.cache_write));
            v
        };
        Ok(UsageReport { daily: daily.into_values().collect(), by_model: sort(models), by_project: sort(projects), heatmap: heat, window, sessions, cost })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_handles_cjk() {
        let text = "前面有很多很多的文字内容，然后这里出现了关键词 Forge 以及后面更多的中文字符";
        let lower = text.to_lowercase();
        let (s, at, len) = snippet(text, &lower, "forge").unwrap();
        assert_eq!(s.chars().skip(at).take(len).collect::<String>(), "Forge");
    }

    /// 用本机真实数据做冒烟测试（只打印数量）：cargo test real_data -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_data_smoke() {
        let s = list_sessions_inner(None).unwrap();
        let with_prompt = s.iter().filter(|x| !x.first_prompt.is_empty()).count();
        let with_model = s.iter().filter(|x| !x.models.is_empty()).count();
        let first = s.first().map(|x| (x.project_id.clone(), x.id.clone()));
        let t0 = std::time::Instant::now();
        let again = list_sessions_inner(None).unwrap().len();
        println!("sessions={} with_prompt={} with_model={} cached_relist={}ms ({again})", s.len(), with_prompt, with_model, t0.elapsed().as_millis());
        if let Some((p, id)) = first {
            let items = tauri::async_runtime::block_on(session_transcript(p, id)).unwrap();
            println!("first transcript items={}", items.len());
        }
        let r = tauri::async_runtime::block_on(usage_report(30)).unwrap();
        println!("usage days={} models={} projects={} window={}", r.daily.len(), r.by_model.len(), r.by_project.len(), r.window.is_some());
        let hits = tauri::async_runtime::block_on(search_sessions("the".into(), None)).unwrap();
        println!("search hits={}", hits.len());
    }

    #[test]
    fn meta_detection() {
        assert!(is_meta_text("<command-name>/clear</command-name>"));
        assert!(!is_meta_text("帮我写个函数"));
    }

    #[test]
    fn summarize_sample() {
        let dir = std::env::temp_dir().join(format!("forge-sess-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("abc.jsonl");
        let lines = [
            r#"{"type":"user","isSidechain":false,"cwd":"C:\\p","gitBranch":"main","timestamp":"2026-11-14T01:00:00Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
            r#"{"type":"user","isSidechain":false,"cwd":"C:\\p","timestamp":"2026-11-14T01:00:01Z","message":{"role":"user","content":[{"type":"text","text":"重构登录模块"}]}}"#,
            r#"{"type":"assistant","isSidechain":false,"timestamp":"2026-11-14T01:00:05Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5}}}"#,
            r#"{"type":"assistant","isSidechain":false,"timestamp":"2026-11-14T01:00:06Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5}}}"#,
            r#"{"type":"custom-title","customTitle":"登录重构","sessionId":"abc"}"#,
        ];
        fs::write(&f, lines.join("\n")).unwrap();
        let s = summarize("p", &f).unwrap();
        assert_eq!(s.title, "登录重构");
        assert_eq!(s.first_prompt, "重构登录模块");
        assert_eq!(s.user_turns, 1);
        assert_eq!(s.assistant_msgs, 1, "同一 message.id 只算一次");
        assert_eq!(s.tokens, 35);
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        let _ = fs::remove_dir_all(&dir);
    }
}
