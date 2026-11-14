//! AI 工具箱：检查点与改动审查、上下文打包、项目地图、通过 `claude -p` 生成文本。
use crate::git::{self, finish, git_cmd};
use crate::system::hidden_command;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ================================================================ 检查点
// 用临时索引给「当前工作区（含未跟踪、遵守 .gitignore）」拍快照，写成悬空提交挂在
// refs/forge/checkpoints/* 下：不改分支、不动暂存区、不产生任何可见提交。

const CK_PREFIX: &str = "refs/forge/checkpoints/";

/// 当前工作区的树对象。先复制真实索引，这样 add -A 只需重新哈希改动过的文件。
fn snapshot_tree(repo: &str) -> Result<String, String> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("forge-index-{}-{nanos}", std::process::id()));
    let real = git::run(repo, &["rev-parse", "--git-path", "index"])?;
    let real = Path::new(repo).join(real.trim());
    if real.exists() {
        let _ = std::fs::copy(&real, &tmp);
    }
    let r = (|| {
        finish(git_cmd(repo).env("GIT_INDEX_FILE", &tmp).args(["add", "-A"]).output().map_err(|e| e.to_string())?)?;
        Ok(finish(git_cmd(repo).env("GIT_INDEX_FILE", &tmp).arg("write-tree").output().map_err(|e| e.to_string())?)?.trim().to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    r
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    id: String,
    commit: String,
    tree: String,
    time: i64,
    label: String,
    /// 与当前工作区相比
    files: u32,
    added: u32,
    removed: u32,
}

fn shortstat(repo: &str, a: &str, b: &str) -> (u32, u32, u32) {
    let s = git::run(repo, &["diff", "--shortstat", a, b]).unwrap_or_default();
    let num = |kw: &str| {
        s.split(',').find(|p| p.contains(kw)).and_then(|p| p.split_whitespace().next()).and_then(|n| n.parse().ok()).unwrap_or(0)
    };
    (num("file"), num("insertion"), num("deletion"))
}

fn list_inner(repo: &str) -> Result<Vec<Checkpoint>, String> {
    let raw = git::run(repo, &["for-each-ref", CK_PREFIX, "--sort=-creatordate", "--count=60", "--format=%(refname)%00%(objectname)%00%(tree)%00%(creatordate:unix)%00%(subject)"])?;
    let cur = snapshot_tree(repo)?;
    Ok(raw
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 5 { return None }
            let (files, added, removed) = shortstat(repo, f[2], &cur);
            Some(Checkpoint {
                id: f[0].trim_start_matches(CK_PREFIX).into(),
                commit: f[1].into(),
                tree: f[2].into(),
                time: f[3].parse::<i64>().unwrap_or(0) * 1000,
                label: f[4].into(),
                files,
                added,
                removed,
            })
        })
        .collect())
}

pub fn create_inner(repo: &str, label: &str) -> Result<Option<Checkpoint>, String> {
    let tree = snapshot_tree(repo)?;
    // 与最近一个检查点完全相同则不重复创建
    let last = git::run(repo, &["for-each-ref", CK_PREFIX, "--sort=-creatordate", "--count=1", "--format=%(tree)"]).unwrap_or_default();
    if last.trim() == tree {
        return Ok(None);
    }
    let mut c = git_cmd(repo);
    c.env("GIT_AUTHOR_NAME", "Forge").env("GIT_AUTHOR_EMAIL", "forge@localhost").env("GIT_COMMITTER_NAME", "Forge").env("GIT_COMMITTER_EMAIL", "forge@localhost");
    c.args(["commit-tree", &tree, "-m", if label.trim().is_empty() { "检查点" } else { label.trim() }]);
    if git::has_head(repo) {
        c.args(["-p", "HEAD"]);
    }
    let commit = finish(c.output().map_err(|e| e.to_string())?)?.trim().to_string();
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    git::run(repo, &["update-ref", &format!("{CK_PREFIX}{ms}"), &commit])?;
    Ok(list_inner(repo)?.into_iter().next())
}

#[tauri::command]
pub async fn checkpoint_list(path: String) -> Result<Vec<Checkpoint>, String> {
    blocking(move || list_inner(&path)).await
}

#[tauri::command]
pub async fn checkpoint_create(path: String, label: String) -> Result<Option<Checkpoint>, String> {
    blocking(move || create_inner(&path, &label)).await
}

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) { Ok(()) } else { Err("无效的检查点".into()) }
}

#[tauri::command]
pub async fn checkpoint_delete(path: String, id: String) -> Result<(), String> {
    blocking(move || { valid_id(&id)?; git::run(&path, &["update-ref", "-d", &format!("{CK_PREFIX}{id}")]).map(|_| ()) }).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    /// A 新增 / M 修改 / D 删除
    status: String,
    added: Option<u32>,
    removed: Option<u32>,
}

fn changes_inner(repo: &str, tree: &str) -> Result<Vec<Change>, String> {
    let cur = snapshot_tree(repo)?;
    let ns = git::run(repo, &["diff", "--no-renames", "--name-status", tree, &cur])?;
    let num = git::run(repo, &["diff", "--no-renames", "--numstat", tree, &cur])?;
    let mut stats: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    for l in num.lines() {
        let f: Vec<&str> = l.splitn(3, '\t').collect();
        if f.len() == 3 { stats.insert(f[2].into(), (f[0].parse().ok(), f[1].parse().ok())); }
    }
    Ok(ns
        .lines()
        .filter_map(|l| {
            let (st, p) = l.split_once('\t')?;
            let (added, removed) = stats.get(p).cloned().unwrap_or((None, None));
            Some(Change { path: p.into(), status: st[..1].into(), added, removed })
        })
        .collect())
}

/// 自检查点以来工作区的所有改动（包含未跟踪文件）。
#[tauri::command]
pub async fn checkpoint_changes(path: String, tree: String) -> Result<Vec<Change>, String> {
    blocking(move || changes_inner(&path, &tree)).await
}

#[tauri::command]
pub async fn checkpoint_file_diff(path: String, tree: String, file: String) -> Result<String, String> {
    blocking(move || {
        let cur = snapshot_tree(&path)?;
        git::run(&path, &["diff", "--no-renames", "-U3", &tree, &cur, "--", &file])
    })
    .await
}

fn safe_join(repo: &str, file: &str) -> Result<PathBuf, String> {
    if file.split(['/', '\\']).any(|seg| seg == "..") || Path::new(file).is_absolute() {
        return Err(format!("非法路径：{file}"));
    }
    Ok(Path::new(repo).join(file))
}

/// 把单个文件恢复到检查点时的内容；检查点里不存在的文件会被删除。
fn revert_file(repo: &str, tree: &str, file: &str) -> Result<(), String> {
    let target = safe_join(repo, file)?;
    let spec = format!("{tree}:{file}");
    if git::run(repo, &["cat-file", "-e", &spec]).is_ok() {
        let out = git_cmd(repo).args(["cat-file", "blob", &spec]).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).into()) }
        if let Some(dir) = target.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
        std::fs::write(&target, out.stdout).map_err(|e| format!("{file}：{e}"))
    } else if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("{file}：{e}"))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn checkpoint_revert_file(path: String, tree: String, file: String) -> Result<(), String> {
    blocking(move || revert_file(&path, &tree, &file)).await
}

/// 整体恢复：先自动保存当前状态为新检查点（可反悔），再逐个文件恢复。
#[tauri::command]
pub async fn checkpoint_restore(path: String, tree: String) -> Result<u32, String> {
    blocking(move || {
        create_inner(&path, "恢复前自动备份")?;
        let changes = changes_inner(&path, &tree)?;
        for c in &changes {
            revert_file(&path, &tree, &c.path)?;
        }
        Ok(changes.len() as u32)
    })
    .await
}

// ================================================================ 文件列表 / 上下文打包

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".gradle", ".idea", ".vs", "bin", "obj", ".godot", ".import"];
const BINARY_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "psd", "ttf", "otf", "woff", "woff2", "eot", "mp3", "wav", "ogg", "flac", "mp4", "mov", "avi", "webm", "zip", "7z", "rar", "gz", "tar", "exe", "dll", "so", "dylib", "pdb", "lib", "a", "o", "obj", "class", "jar", "pdf", "docx", "xlsx", "pptx", "db", "sqlite", "bin", "dat", "pak", "unitypackage", "fbx", "blend", "glb", "gltf", "tmod", "xnb"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    path: String,
    size: u64,
    binary: bool,
    tokens: u64,
}

fn walk(root: &Path, limit: usize) -> Vec<FileInfo> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .add_custom_ignore_filename(".claudeignore")
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        .build();
    for e in walker.flatten() {
        if !e.file_type().is_some_and(|t| t.is_file()) { continue }
        let Ok(rel) = e.path().strip_prefix(root) else { continue };
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let ext = e.path().extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let binary = BINARY_EXT.contains(&ext.as_str());
        out.push(FileInfo { path: rel.to_string_lossy().replace('\\', "/"), size, binary, tokens: if binary { 0 } else { (size as f64 / 3.6) as u64 } });
        if out.len() >= limit { break }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[tauri::command]
pub async fn project_files(path: String) -> Result<Vec<FileInfo>, String> {
    blocking(move || {
        if !Path::new(&path).is_dir() { return Err(format!("目录不存在：{path}")) }
        Ok(walk(Path::new(&path), 20_000))
    })
    .await
}

/// 粗略 token 估算：ASCII 约 4 字符 1 token，中日韩约 0.7 token/字。
pub fn est_tokens(s: &str) -> u64 {
    let mut t = 0.0;
    for ch in s.chars() {
        t += if (ch as u32) < 0x2E80 { 0.26 } else { 0.7 };
    }
    t as u64
}

fn lang_of(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("") {
        "rs" => "rust", "ts" | "tsx" => "tsx", "js" | "jsx" | "mjs" | "cjs" => "js", "py" => "python", "cs" => "csharp",
        "go" => "go", "java" => "java", "kt" => "kotlin", "gd" => "gdscript", "json" => "json", "toml" => "toml",
        "yaml" | "yml" => "yaml", "md" => "markdown", "html" => "html", "css" | "scss" => "css", "sh" => "bash",
        "ps1" => "powershell", "sql" => "sql", "c" | "h" => "c", "cpp" | "hpp" | "cc" => "cpp", "lua" => "lua", "vue" => "vue", "svelte" => "svelte",
        _ => "",
    }
}

fn tree_of(files: &[String]) -> String {
    // 目录树：每层按名称排序，目录在前
    #[derive(Default)]
    struct Node(BTreeMap<String, Node>, bool);
    let mut root = Node::default();
    for f in files {
        let mut n = &mut root;
        let parts: Vec<&str> = f.split('/').collect();
        for (i, p) in parts.iter().enumerate() {
            n = n.0.entry((*p).to_string()).or_default();
            if i == parts.len() - 1 { n.1 = true }
        }
    }
    fn render(n: &Node, prefix: &str, out: &mut String) {
        let mut items: Vec<(&String, &Node)> = n.0.iter().collect();
        items.sort_by_key(|(k, v)| (v.1, (*k).clone()));
        for (i, (name, child)) in items.iter().enumerate() {
            let last = i == items.len() - 1;
            out.push_str(&format!("{prefix}{}{}{}\n", if last { "└── " } else { "├── " }, name, if child.1 { "" } else { "/" }));
            render(child, &format!("{prefix}{}", if last { "    " } else { "│   " }), out);
        }
    }
    let mut s = String::new();
    render(&root, "", &mut s);
    s
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Packed {
    text: String,
    tokens: u64,
    files: u32,
    skipped: Vec<String>,
}

#[tauri::command]
pub async fn pack_context(path: String, files: Vec<String>, format: String, include_tree: bool) -> Result<Packed, String> {
    blocking(move || {
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let xml = format == "xml";
        let mut out = String::new();
        let mut skipped = Vec::new();
        let mut count = 0;
        if xml {
            out.push_str(&format!("<project name=\"{name}\">\n"));
            if include_tree { out.push_str(&format!("<tree>\n{}</tree>\n", tree_of(&files))) }
        } else {
            out.push_str(&format!("# {name}\n\n"));
            if include_tree { out.push_str(&format!("## 目录结构\n\n```text\n{}```\n\n", tree_of(&files))) }
        }
        for f in &files {
            let p = safe_join(&path, f)?;
            let Ok(bytes) = std::fs::read(&p) else { skipped.push(format!("{f}（读取失败）")); continue };
            if bytes.len() > 400 * 1024 { skipped.push(format!("{f}（超过 400KB）")); continue }
            if bytes.contains(&0) { skipped.push(format!("{f}（二进制）")); continue }
            let text = String::from_utf8_lossy(&bytes);
            if xml {
                out.push_str(&format!("<file path=\"{f}\">\n{}\n</file>\n", text.trim_end()));
            } else {
                let fence = if text.contains("```") { "````" } else { "```" };
                out.push_str(&format!("## {f}\n\n{fence}{}\n{}\n{fence}\n\n", lang_of(f), text.trim_end()));
            }
            count += 1;
        }
        if xml { out.push_str("</project>\n") }
        Ok(Packed { tokens: est_tokens(&out), text: out, files: count, skipped })
    })
    .await
}

/// 保存到「下载」文件夹并返回完整路径。
#[tauri::command]
pub fn save_to_downloads(name: String, content: String) -> Result<String, String> {
    let clean: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let dir = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Downloads")).ok_or("找不到下载目录")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(clean);
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    Ok(p.to_string_lossy().into())
}

// ================================================================ 项目地图

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMap {
    markdown: String,
    /// 供 AI 生成模块说明用的原始材料
    context: String,
}

fn lang_name(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "Rust", "ts" | "tsx" => "TypeScript", "js" | "jsx" | "mjs" => "JavaScript", "py" => "Python", "cs" => "C#",
        "go" => "Go", "java" => "Java", "kt" => "Kotlin", "gd" => "GDScript", "cpp" | "cc" | "hpp" => "C++", "c" | "h" => "C",
        "lua" => "Lua", "vue" => "Vue", "svelte" => "Svelte", "css" | "scss" => "CSS", "html" => "HTML", "swift" => "Swift", "rb" => "Ruby", "php" => "PHP",
        _ => return None,
    })
}

#[tauri::command]
pub async fn project_map(path: String) -> Result<ProjectMap, String> {
    blocking(move || {
        let root = Path::new(&path);
        let files = walk(root, 20_000);
        // 语言占比（按字节）
        let mut langs: HashMap<&str, u64> = HashMap::new();
        for f in &files {
            if let Some(l) = f.path.rsplit('.').next().and_then(lang_name) { *langs.entry(l).or_default() += f.size }
        }
        let total: u64 = langs.values().sum::<u64>().max(1);
        let mut langs: Vec<_> = langs.into_iter().collect();
        langs.sort_by_key(|x| std::cmp::Reverse(x.1));
        let lang_line = langs.iter().take(5).map(|(l, b)| format!("{l} {}%", b * 100 / total)).collect::<Vec<_>>().join(" · ");

        // 目录统计（最多 3 层）
        let mut dirs: BTreeMap<String, u32> = BTreeMap::new();
        for f in &files {
            let parts: Vec<&str> = f.path.split('/').collect();
            for depth in 1..parts.len().min(4) {
                *dirs.entry(parts[..depth].join("/")).or_default() += 1;
            }
        }
        let mut tree = String::new();
        for (d, n) in &dirs {
            let depth = d.matches('/').count();
            let name = d.rsplit('/').next().unwrap_or(d);
            tree.push_str(&format!("{}{}/ ({n})\n", "  ".repeat(depth), name));
        }
        let top_files: Vec<&str> = files.iter().filter(|f| !f.path.contains('/')).map(|f| f.path.as_str()).collect();
        for f in &top_files { tree.push_str(&format!("{f}\n")) }

        // 关键文件
        let mut keys = Vec::new();
        let mut context = String::new();
        let read = |n: &str| std::fs::read_to_string(root.join(n)).ok();
        if let Some(pj) = read("package.json").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            let scripts: Vec<String> = pj["scripts"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            keys.push(format!("`package.json`（脚本：{}）", if scripts.is_empty() { "无".into() } else { scripts.join("、") }));
            context.push_str(&format!("package.json scripts: {}\n", pj["scripts"]));
        }
        for (f, desc) in [("Cargo.toml", "Rust 包"), ("pyproject.toml", "Python 项目"), ("go.mod", "Go 模块"), ("project.godot", "Godot 项目"), ("build.gradle", "Gradle"), ("pom.xml", "Maven"), ("Makefile", "Make"), ("Dockerfile", "Docker")] {
            if let Some(s) = read(f) {
                keys.push(format!("`{f}`（{desc}）"));
                context.push_str(&format!("\n--- {f} ---\n{}\n", s.chars().take(1500).collect::<String>()));
            }
        }
        for f in files.iter().filter(|f| f.path.ends_with(".csproj") || f.path.ends_with(".sln")).take(3) {
            keys.push(format!("`{}`", f.path));
        }
        if let Some(r) = read("README.md").or_else(|| read("readme.md")) {
            context.push_str(&format!("\n--- README.md ---\n{}\n", r.chars().take(3000).collect::<String>()));
        }

        let mut md = String::from("<!-- forge:map:start -->\n## 项目地图\n\n");
        md.push_str(&format!("> 由 Forge 自动生成 · {} 个文件\n\n", files.len()));
        if !lang_line.is_empty() { md.push_str(&format!("- **语言**：{lang_line}\n")) }
        if !keys.is_empty() { md.push_str(&format!("- **关键文件**：{}\n", keys.join("，"))) }
        md.push_str(&format!("\n### 目录结构\n\n```text\n{tree}```\n<!-- forge:map:end -->\n"));
        context.insert_str(0, &format!("目录结构（括号内为文件数）：\n{tree}\n"));
        Ok(ProjectMap { markdown: md, context })
    })
    .await
}

// ================================================================ claude -p

/// 以无头模式调用本机 Claude Code：沿用用户自己的登录与配置，Forge 不接触任何密钥。
pub fn ask_claude(cwd: &str, instruction: &str, input: &str) -> Result<String, String> {
    let mut child = hidden_command("cmd")
        .args(["/c", "claude", "-p", "--output-format", "text", "--model", "sonnet", "Follow the instructions given via stdin exactly. Output only the requested result."])
        .current_dir(if Path::new(cwd).is_dir() { cwd } else { "." })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 claude：{e}"))?;
    let payload = format!("{instruction}\n\n========== 输入 ==========\n{input}");
    child.stdin.take().ok_or("stdin 不可用")?.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if stderr.is_empty() { stdout.clone() } else { stderr };
        return Err(explain_cli_error(&err));
    }
    Ok(strip_fence(&stdout))
}

/// 把 claude CLI 的常见失败翻译成可操作的提示。
fn explain_cli_error(err: &str) -> String {
    let low = err.to_lowercase();
    if err.contains("not recognized") || err.contains("不是内部或外部命令") {
        "没有找到 claude 命令：请先安装 Claude Code，并确认它在 PATH 中".into()
    } else if low.contains("not logged in") || low.contains("/login") {
        "Claude Code 还没有登录：在「终端」页打开一个 Claude 标签，输入 /login 完成登录后再试".into()
    } else if low.contains("rate limit") || low.contains("usage limit") {
        format!("已达到用量上限，请稍后再试（{}）", err.trim())
    } else if err.trim().is_empty() {
        "Claude 没有返回内容".into()
    } else {
        format!("Claude 出错：{}", err.trim())
    }
}

/// 去掉整段包裹的 ``` 代码块。
fn strip_fence(s: &str) -> String {
    let t = s.trim();
    if t.starts_with("```") && t.ends_with("```") && t.len() > 6 {
        let inner = &t[3..t.len() - 3];
        let inner = inner.split_once('\n').map(|(first, rest)| if first.trim().chars().all(|c| c.is_ascii_alphanumeric()) { rest } else { inner }).unwrap_or(inner);
        return inner.trim().to_string();
    }
    t.to_string()
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string() }
    let mut end = max;
    while !s.is_char_boundary(end) { end -= 1 }
    format!("{}\n…（已截断，共 {} 字节）", &s[..end], s.len())
}

#[tauri::command]
pub async fn ai_ask(cwd: String, instruction: String, input: String) -> Result<String, String> {
    blocking(move || ask_claude(&cwd, &instruction, &clip(&input, 120_000))).await
}

#[tauri::command]
pub async fn ai_commit_message(path: String) -> Result<String, String> {
    blocking(move || {
        let diff = git::run(&path, &["diff", "--cached", "--no-ext-diff", "-U2"])?;
        if diff.trim().is_empty() { return Err("暂存区是空的，先暂存要提交的改动".into()) }
        let stat = git::run(&path, &["diff", "--cached", "--stat"]).unwrap_or_default();
        let recent = git::run(&path, &["log", "-8", "--format=%s"]).unwrap_or_default();
        let instruction = "你是一位资深工程师。根据下面「暂存区改动」写一条 git 提交信息。\n\
要求：\n\
1. 第一行使用 Conventional Commits 格式：type(scope): 摘要，type 取 feat/fix/refactor/docs/test/chore/perf/style/build/ci 之一，scope 可省略，整行不超过 72 个字符。\n\
2. 摘要的语言与「最近的提交」保持一致；如果没有最近提交或其中有中文，就用中文。\n\
3. 空一行后用 2～5 条以「- 」开头的要点说明改了什么、为什么改；改动很小时可以只写第一行。\n\
4. 只输出提交信息本身，不要代码块、引号或任何解释。";
        let input = format!("最近的提交：\n{}\n\n改动统计：\n{}\n\n暂存区改动：\n{}", if recent.trim().is_empty() { "（无）" } else { recent.trim() }, stat.trim(), clip(&diff, 60_000));
        ask_claude(&path, instruction, &input)
    })
    .await
}

/// 远程默认分支（origin/HEAD），找不到时依次尝试 main、master。
pub fn default_branch(repo: &str) -> String {
    if let Ok(s) = git::run(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(b) = s.trim().strip_prefix("origin/") { return b.to_string() }
    }
    for b in ["main", "master"] {
        if git::run(repo, &["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{b}")]).is_ok()
            || git::run(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")]).is_ok() {
            return b.into();
        }
    }
    "main".into()
}

#[tauri::command]
pub async fn git_default_branch(path: String) -> Result<String, String> {
    blocking(move || Ok(default_branch(&path))).await
}

#[tauri::command]
pub async fn ai_pr_description(path: String, base: String) -> Result<String, String> {
    blocking(move || {
        let base_ref = if git::run(&path, &["rev-parse", "--verify", "-q", &format!("origin/{base}")]).is_ok() { format!("origin/{base}") } else { base.clone() };
        let range = format!("{base_ref}...HEAD");
        let log = git::run(&path, &["log", "--format=- %s%n%b", &range])?;
        if log.trim().is_empty() { return Err(format!("当前分支相对 {base} 没有新的提交")) }
        let stat = git::run(&path, &["diff", "--stat", &range]).unwrap_or_default();
        let diff = git::run(&path, &["diff", "-U2", &range]).unwrap_or_default();
        let instruction = "根据下面的提交记录和代码改动，写一个 GitHub Pull Request。\n\
输出格式：第一行是 PR 标题（不超过 70 个字符，不要带 # 号），空一行后是 Markdown 正文，正文包含「## 改动内容」（要点列表）和「## 如何测试」两个小节；如有破坏性变更再加「## 注意事项」。\n\
语言与提交记录保持一致，没有把握时用中文。只输出标题和正文，不要额外解释。";
        let input = format!("提交记录：\n{}\n\n改动统计：\n{}\n\n代码改动：\n{}", log.trim(), stat.trim(), clip(&diff, 50_000));
        ask_claude(&path, instruction, &input)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> String {
        let dir = std::env::temp_dir().join(format!("forge-ck-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();
        git::run(&p, &["init", "-b", "main"]).unwrap();
        git::run(&p, &["config", "user.name", "T"]).unwrap();
        git::run(&p, &["config", "user.email", "t@example.invalid"]).unwrap();
        p
    }

    #[test]
    fn checkpoint_roundtrip() {
        let r = repo();
        let f = |n: &str| Path::new(&r).join(n);
        std::fs::write(f("a.txt"), "v1\n").unwrap();
        std::fs::write(f(".gitignore"), "ignored.log\n").unwrap();
        git::run(&r, &["add", "-A"]).unwrap();
        git::run(&r, &["commit", "-m", "init"]).unwrap();
        // 暂存一个改动，确认检查点不影响暂存区
        std::fs::write(f("staged.txt"), "s\n").unwrap();
        git::run(&r, &["add", "staged.txt"]).unwrap();
        std::fs::write(f("untracked.txt"), "u\n").unwrap();
        std::fs::write(f("ignored.log"), "x\n").unwrap();

        let ck = create_inner(&r, "测试检查点").unwrap().expect("应创建检查点");
        assert!(create_inner(&r, "重复").unwrap().is_none(), "内容未变时不应重复创建");
        let staged = git::run(&r, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "staged.txt", "暂存区不应被改动");
        assert_eq!(git::run(&r, &["log", "--oneline"]).unwrap().lines().count(), 1, "不应产生可见提交");

        // 模拟 Claude 的改动：修改、删除、新增
        std::fs::write(f("a.txt"), "v2\n").unwrap();
        std::fs::remove_file(f("untracked.txt")).unwrap();
        std::fs::create_dir_all(f("new")).unwrap();
        std::fs::write(f("new/b.rs"), "fn main() {}\n").unwrap();

        let ch = changes_inner(&r, &ck.tree).unwrap();
        let mut got: Vec<(String, String)> = ch.iter().map(|c| (c.status.clone(), c.path.clone())).collect();
        got.sort();
        assert_eq!(got, vec![("A".into(), "new/b.rs".into()), ("D".into(), "untracked.txt".into()), ("M".into(), "a.txt".into())]);

        // 单文件恢复
        revert_file(&r, &ck.tree, "a.txt").unwrap();
        assert_eq!(std::fs::read_to_string(f("a.txt")).unwrap().replace('\r', ""), "v1\n");
        // 整体恢复
        create_inner(&r, "恢复前自动备份").unwrap();
        for c in changes_inner(&r, &ck.tree).unwrap() { revert_file(&r, &ck.tree, &c.path).unwrap() }
        assert!(f("untracked.txt").exists() && !f("new/b.rs").exists());
        assert!(f("ignored.log").exists(), "被忽略的文件不受影响");
        assert!(changes_inner(&r, &ck.tree).unwrap().is_empty());
        assert!(list_inner(&r).unwrap().len() >= 2);
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn walk_respects_ignores() {
        let dir = std::env::temp_dir().join(format!("forge-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (p, c) in [("src/main.rs", "fn main(){}"), ("secret.env", "X=1"), (".gitignore", "*.log\n"), (".claudeignore", "secret.env\n"), ("debug.log", "x"), ("node_modules/a/index.js", "x"), ("img.png", "x"), ("package.json", r#"{"scripts":{"dev":"vite"}}"#)] {
            let f = dir.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, c).unwrap();
        }
        let paths: Vec<String> = walk(&dir, 100).into_iter().map(|f| f.path).collect();
        assert!(paths.contains(&"src/main.rs".to_string()));
        assert!(!paths.iter().any(|p| p == "debug.log" || p == "secret.env" || p.starts_with("node_modules")), "{paths:?}");
        assert!(walk(&dir, 100).iter().any(|f| f.path == "img.png" && f.binary));
        let map = tauri::async_runtime::block_on(project_map(dir.to_string_lossy().into())).unwrap();
        assert!(map.markdown.contains("forge:map:start") && map.markdown.contains("src/") && map.markdown.contains("dev"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_and_tokens() {
        let t = tree_of(&["src/main.rs".into(), "src/ui/app.tsx".into(), "README.md".into()]);
        assert!(t.contains("src/") && t.contains("└── ") && t.contains("app.tsx"));
        assert!(est_tokens("hello world") < est_tokens("你好世界你好世界你好"));
        assert_eq!(strip_fence("```text\nfeat: x\n```"), "feat: x");
        assert_eq!(strip_fence("feat: y"), "feat: y");
        assert!(clip("你好世界", 4).starts_with("你"));
        assert!(explain_cli_error("Not logged in · Please run /login").contains("/login"));
        assert!(explain_cli_error("'claude' is not recognized as an internal").contains("PATH"));
    }
}
