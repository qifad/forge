//! 与 Windows 外部程序交互：终端、编辑器、资源管理器。
use std::path::Path;
use std::process::Command;

/// 创建一个不会闪出黑色控制台窗口的子进程。
pub fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn ensure_dir(path: &str) -> Result<(), String> {
    if Path::new(path).is_dir() {
        Ok(())
    } else {
        Err(format!("目录不存在：{path}"))
    }
}

/// 在 Windows Terminal（没有则用 cmd）里，于项目目录启动 claude。
#[tauri::command]
pub fn open_terminal_claude(path: String, resume: bool) -> Result<(), String> {
    ensure_dir(&path)?;
    let mut args = vec!["/k", "claude"];
    if resume {
        args.push("--continue");
    }
    let wt = Command::new("wt.exe").arg("-d").arg(&path).arg("cmd").args(&args).spawn();
    if wt.is_err() {
        Command::new("cmd")
            .args(["/c", "start", "Claude", "cmd"])
            .args(&args)
            .current_dir(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    hidden_command("cmd")
        .args(["/c", "code"])
        .arg(&path)
        .spawn()
        .map_err(|e| format!("无法启动 VS Code：{e}"))?;
    Ok(())
}

/// 用默认浏览器打开链接（只允许 https，防止被当作命令执行）。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.contains(['"', '\n', '\r']) {
        return Err("只允许打开 https 链接".into());
    }
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    ensure_dir(&path)?;
    Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
