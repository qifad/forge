#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aitools;
mod claude;
mod config;
mod git;
mod github;
mod pty;
mod sessions;
mod system;
mod updater;

use tauri::Manager;

struct WindowEffect(&'static str);

/// 前端据此决定是否让背景透明以透出系统材质。
#[tauri::command]
fn window_effect(state: tauri::State<WindowEffect>) -> &'static str {
    state.0
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // Win11 → Mica。Win10 不用 Acrylic：它在 1903+ 上拖动/缩放窗口时会严重卡顿
            // （window-vibrancy 文档注明的已知问题），改由前端绘制背景。
            #[cfg(target_os = "windows")]
            let effect = if window_vibrancy::apply_mica(&window, None).is_ok() { "mica" } else { "none" };
            #[cfg(not(target_os = "windows"))]
            let effect = "none";
            let _ = window;
            app.manage(WindowEffect(effect));
            app.manage(pty::Ptys::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_effect,
            updater::app_version,
            updater::app_quit,
            updater::update_check,
            updater::update_install,
            updater::release_repo_create,
            updater::release_list,
            updater::release_delete,
            updater::release_find_installers,
            updater::release_publish,
            aitools::checkpoint_list,
            aitools::checkpoint_create,
            aitools::checkpoint_delete,
            aitools::checkpoint_changes,
            aitools::checkpoint_file_diff,
            aitools::checkpoint_revert_file,
            aitools::checkpoint_restore,
            aitools::project_files,
            aitools::pack_context,
            aitools::save_to_downloads,
            aitools::project_map,
            aitools::ai_ask,
            aitools::ai_commit_message,
            aitools::ai_pr_description,
            aitools::git_default_branch,
            github::gh_pr_info,
            github::gh_create_pr,
            sessions::list_sessions,
            sessions::search_sessions,
            sessions::session_transcript,
            sessions::usage_report,
            config::memory_files,
            config::memory_read,
            config::memory_write,
            config::mcp_list,
            config::mcp_health,
            config::mcp_add,
            config::mcp_remove,
            config::claude_version,
            config::settings_overview,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            claude::list_claude_projects,
            claude::usage_summary,
            git::git_summary,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_apply_patch,
            git::git_commit,
            git::git_last_message,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_log,
            git::git_sync,
            git::git_stash,
            git::git_init,
            git::git_scan,
            github::gh_status,
            github::gh_set_token,
            github::gh_import_cli,
            github::gh_logout,
            github::gh_device_start,
            github::gh_device_poll,
            github::gh_repos,
            github::gh_publish,
            system::open_url,
            system::open_terminal_claude,
            system::open_in_editor,
            system::reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forge");
}
