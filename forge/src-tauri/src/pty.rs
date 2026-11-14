//! 内嵌终端：ConPTY（portable-pty）+ 前端 xterm.js。输出通过 "pty-data" 事件推送。
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Session>>);

#[derive(Serialize, Clone)]
struct Data {
    id: String,
    data: String,
}

/// 把字节流解码为 UTF-8，保留被截断在缓冲区末尾的多字节字符，留到下一次拼接。
fn decode(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let s = s.to_string();
            pending.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            s
        }
    }
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<Ptys>, id: String, cwd: String, command: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(5), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("cmd.exe");
    // 切到 UTF-8 代码页，否则中文 Windows 默认 GBK 输出会乱码
    let script = match command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => format!("chcp 65001 >nul && {c}"),
        None => "chcp 65001 >nul".into(),
    };
    cmd.args(["/k", &script]);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    cmd.env("FORCE_COLOR", "1");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("启动终端失败：{e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let rid = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let s = decode(&mut pending);
                    // 响铃字符：Claude Code 可配置在完成 / 等待确认时响铃
                    if s.contains('\x07') {
                        let _ = app.emit("pty-bell", rid.clone());
                    }
                    if !s.is_empty() {
                        let _ = app.emit("pty-data", Data { id: rid.clone(), data: s });
                    }
                }
            }
        }
        let _ = app.emit("pty-exit", rid);
    });

    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = map.insert(id, Session { master: pair.master, writer, child }) {
        let _ = old.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let s = map.get_mut(&id).ok_or("终端已关闭")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize { rows: rows.max(5), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<Ptys>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn keeps_split_utf8() {
        let bytes = "你好".as_bytes();
        let mut p = bytes[..4].to_vec(); // "你" + 半个 "好"
        assert_eq!(decode(&mut p), "你");
        assert_eq!(p.len(), 1);
        p.extend_from_slice(&bytes[4..]);
        assert_eq!(decode(&mut p), "好");
        assert!(p.is_empty());
    }
}
