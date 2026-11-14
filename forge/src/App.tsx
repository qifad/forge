import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import * as api from "./api";
import { ago, isTauri, type Project } from "./api";
import { Icon, type IconName } from "./icons";
import { CommandPalette, type Command } from "./palette";
import { Avatar, Overview, type Actions } from "./views";
import { SettingsView, startupCheck, updateState } from "./settings";
import { GitView } from "./git";
import { GitHubView } from "./github";
import { gh } from "./gitapi";
import { ClaudeView } from "./claude";
import { TerminalPanel, terminals } from "./terminal";
import { AiToolsView } from "./aitools";

type View = "overview" | "git" | "github" | "claude" | "terminal" | "ai" | "settings";

const NAV: { id: View; icon: IconName; label: string }[] = [
  { id: "overview", icon: "home", label: "项目概览" },
  { id: "git", icon: "git", label: "源代码管理" },
  { id: "github", icon: "github", label: "GitHub" },
  { id: "claude", icon: "spark", label: "Claude 中心" },
  { id: "terminal", icon: "terminal", label: "终端" },
  { id: "ai", icon: "wand", label: "AI 工具箱" },
];


export default function App() {
  const [projects, { refetch }] = createResource(api.listProjects);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [view, setView] = createSignal<View>("overview");
  const [filter, setFilter] = createSignal("");
  const [palette, setPalette] = createSignal(false);
  const [theme, setTheme] = createSignal<"dark" | "light">((localStorage.getItem("forge.theme") as "dark" | "light") || "dark");
  const [toasts, setToasts] = createSignal<{ id: number; msg: string; err?: boolean }[]>([]);
  const [ghUser, { mutate: setGhUser }] = createResource(() => gh.status().catch(() => null));

  const root = document.documentElement;
  root.dataset.theme = theme();
  const [lite, setLite] = createSignal((() => { try { return localStorage.getItem("forge.lite") === "1"; } catch { return false; } })());
  root.classList.toggle("lite", lite());
  const toggleLite = () => {
    const v = !lite();
    setLite(v);
    root.classList.toggle("lite", v);
    try { localStorage.setItem("forge.lite", v ? "1" : "0"); } catch {}
  };
  if (isTauri) invoke<string>("window_effect").then((e) => root.classList.toggle("vibrancy", e === "mica")).catch(() => {});

  const toggleTheme = () => {
    const t = theme() === "dark" ? "light" : "dark";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("forge.theme", t); } catch {}
  };

  const toast = (msg: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  };

  const selected = createMemo<Project | undefined>(() => {
    const list = projects() ?? [];
    return list.find((p) => p.id === selectedId()) ?? list[0];
  });
  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return (projects() ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  });

  const guard = async (label: string, fn: () => Promise<unknown> | undefined) => {
    try {
      await fn();
      toast(isTauri ? label : `${label}（浏览器预览中不会真正执行）`);
    } catch (e) {
      toast(String(e), true);
    }
  };

  const actions: Actions = {
    openClaude: (resume) => {
      const p = selected();
      if (!p) return;
      terminals.open(p.path, resume ? "claude --continue" : "claude", (resume ? "继续 · " : "Claude · ") + p.name);
      setView("terminal");
    },
    openEditor: () => { const p = selected(); if (p) guard("正在用 VS Code 打开", () => api.openEditor(p.path)); },
    reveal: () => { const p = selected(); if (p) guard("已在资源管理器中打开", () => api.reveal(p.path)); },
    goPublish: () => setView("github"),
    goGit: () => setView("git"),
    goAi: () => setView("ai"),
    goClaude: () => setView("claude"),
    toast,
  };

  const commands = createMemo<Command[]>(() => [
    { id: "claude", group: "操作", label: "在当前项目启动 Claude", hint: "终端", icon: "terminal", keywords: "run cli", run: () => actions.openClaude() },
    { id: "resume", group: "操作", label: "继续上次 Claude 会话", hint: "--continue", icon: "history", keywords: "resume", run: () => actions.openClaude(true) },
    { id: "ext", group: "操作", label: "在外部 Windows Terminal 启动 Claude", icon: "terminal", keywords: "wt external", run: () => { const p = selected(); if (p) guard("已在外部终端启动 Claude", () => api.openClaude(p.path, false)); } },
    { id: "shell", group: "操作", label: "在内置终端打开项目目录", icon: "terminal", keywords: "shell cmd", run: () => { const p = selected(); if (p) { terminals.open(p.path, null, p.name); setView("terminal"); } } },
    { id: "code", group: "操作", label: "用 VS Code 打开项目", icon: "code", keywords: "editor", run: actions.openEditor },
    { id: "reveal", group: "操作", label: "在资源管理器中显示", icon: "folder", keywords: "explorer", run: actions.reveal },
    { id: "refresh", group: "操作", label: "刷新项目列表", icon: "refresh", run: () => { refetch(); toast("已刷新"); } },
    { id: "lite", group: "外观", label: lite() ? "关闭低特效模式" : "开启低特效模式", hint: "更省电、更流畅", icon: "layers", keywords: "performance lite 性能 卡顿", run: toggleLite },
    { id: "theme", group: "外观", label: theme() === "dark" ? "切换到浅色主题" : "切换到深色主题", icon: theme() === "dark" ? "sun" : "moon", keywords: "theme dark light", run: toggleTheme },
    ...NAV.map((n): Command => ({ id: "nav-" + n.id, group: "导航", label: "前往 " + n.label, icon: n.icon, run: () => setView(n.id) })),
    ...(projects() ?? []).map((p): Command => ({
      id: "p-" + p.id, group: "项目", label: p.name, hint: ago(p.lastActive), icon: "folder", keywords: p.path,
      run: () => { setSelectedId(p.id); setView("overview"); },
    })),
  ]);

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((v) => !v); }
  };
  // 卡片聚光：把指针位置写进 CSS 变量，驱动 ::before / ::after 的径向渐变
  const onPointer = (e: PointerEvent) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".card, .qa, .hero-card");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  // 窗口移动 / 缩放时暂停背景动画，结束 250ms 后恢复
  let moveTimer = 0;
  const pulseMoving = () => {
    root.classList.add("moving");
    clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => root.classList.remove("moving"), 250);
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointermove", onPointer, { passive: true });
    startupCheck();
    if (win) {
      win.onMoved(pulseMoving).then((u) => unlisten.push(u));
      win.onResized(pulseMoving).then((u) => unlisten.push(u));
    }
  });
  const unlisten: (() => void)[] = [];
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointermove", onPointer);
    unlisten.forEach((u) => u());
  });
  const navIndex = () => NAV.findIndex((n) => n.id === view());
  createEffect(() => terminals.setPanelVisible(view() === "terminal"));
  const termAttention = () => terminals.tabs().some((t) => t.attention);

  const win = isTauri ? getCurrentWindow() : null;
  const current = () => NAV.find((n) => n.id === view()) ?? { label: "设置" };

  return (
    <div class="app">
      <div class="aurora" aria-hidden="true"><i /><i /><i /><i /></div>
      <nav class="rail">
        <div class="logo" title="Forge">
          <svg viewBox="0 0 512 512"><path d="M172 144h192a16 16 0 0 1 0 32H204v64h120a16 16 0 0 1 0 32H204v96a16 16 0 0 1-32 0V160a16 16 0 0 1 16-16z" fill="#E8875B" /><circle cx="356" cy="356" r="26" fill="#E8875B" /></svg>
        </div>
        <div class="rail-nav">
          <div class="rail-ind" style={{ transform: `translateY(${Math.max(navIndex(), 0) * 44}px)`, opacity: navIndex() < 0 ? 0 : 1 }} />
          <For each={NAV}>
            {(n) => (
              <button class="rail-btn tip" data-tip={n.label} classList={{ on: view() === n.id }} onClick={() => setView(n.id)}>
                <Icon name={n.icon} size={19} />
                <Show when={n.id === "terminal" && termAttention()}><span class="rail-dot" /></Show>
              </button>
            )}
          </For>
        </div>
        <div class="rail-spacer" />
        <button class="rail-btn tip" data-tip={theme() === "dark" ? "浅色主题" : "深色主题"} onClick={toggleTheme}>
          <Icon name={theme() === "dark" ? "sun" : "moon"} size={18} />
        </button>
        <button class="rail-btn tip" data-tip="设置" classList={{ on: view() === "settings" }} onClick={() => setView("settings")}>
          <Icon name="settings" size={18} />
        </button>
      </nav>

      <header class="titlebar" data-tauri-drag-region>
        <div class="crumbs" data-tauri-drag-region>
          <span>{selected()?.name ?? "Forge"}</span>
          <span>/</span>
          <b>{current().label}</b>
        </div>
        <button class="search-pill" onClick={() => setPalette(true)}>
          <Icon name="search" size={14} />
          <span>搜索命令、项目、功能…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <Show when={updateState().hasUpdate && updateState().latest}>
          <button class="update-pill" onClick={() => setView("settings")} title="点击前往设置安装">
            <Icon name="arrowDown" size={13} />新版本 {updateState().latest!.version}
          </button>
        </Show>
        <div class="win-ctrls">
          <button onClick={() => win?.minimize()} aria-label="最小化"><Icon name="min" size={14} stroke={1.4} /></button>
          <button onClick={() => win?.toggleMaximize()} aria-label="最大化"><Icon name="max" size={12} stroke={1.4} /></button>
          <button class="x" onClick={() => win?.close()} aria-label="关闭"><Icon name="close" size={14} stroke={1.4} /></button>
        </div>
      </header>

      <aside class="sidebar">
        <div class="side-head">
          <h2>项目 · {projects()?.length ?? 0}</h2>
          <button class="icon-btn" title="刷新" onClick={() => refetch()}><Icon name="refresh" size={14} /></button>
        </div>
        <label class="filter">
          <Icon name="search" size={13} />
          <input placeholder="筛选项目" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </label>
        <div class="plist">
          <Show when={!projects.loading} fallback={<For each={[1, 2, 3, 4, 5]}>{() => <div class="sk" style={{ height: "40px", margin: "4px 2px 8px" }} />}</For>}>
            <Show when={!projects.error} fallback={<div class="empty" style={{ padding: "30px 10px" }}>读取 ~/.claude/projects 失败<br />{String(projects.error)}</div>}>
              <For each={filtered()} fallback={<div class="empty" style={{ padding: "30px 10px" }}>没有找到项目</div>}>
                {(p, i) => (
                  <button class="pitem" classList={{ on: selected()?.id === p.id }} style={{ "animation-delay": `${Math.min(i(), 12) * 25}ms` }}
                    onClick={() => { setSelectedId(p.id); setView("overview"); }}>
                    <Avatar name={p.name} />
                    <div class="pmeta">
                      <div class="pname">{p.name}</div>
                      <div class="psub">
                        <span class="badge-dot" classList={{ off: !p.exists }} />
                        {p.sessions} 个会话 · {ago(p.lastActive)}
                      </div>
                    </div>
                    <Show when={p.isGit}><Icon name="git" size={13} class="psub" /></Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
        <button class="side-foot" onClick={() => setView("github")}>
          <Show when={ghUser()} fallback={<><Icon name="github" size={15} /><span>连接 GitHub</span><span class="tag accent" style={{ "margin-left": "auto" }}>登录</span></>}>
            {(u) => (
              <>
                <Show when={u().avatarUrl} fallback={<Icon name="github" size={15} />}><img src={u().avatarUrl} width="20" height="20" class="gh-avatar" alt="" /></Show>
                <span>{u().login}</span>
                <span class="badge-dot" style={{ "margin-left": "auto" }} />
              </>
            )}
          </Show>
        </button>
      </aside>

      <main class="main">
        <Switch>
          <Match when={view() === "overview" && selected()}>
            <Overview project={selected()!} actions={actions} />
          </Match>
          <Match when={view() === "overview" && projects.loading}>
            <div class="page"><div class="sk" style={{ height: "52px", width: "40%", "margin-bottom": "22px" }} /><div class="sk" style={{ height: "300px" }} /></div>
          </Match>
          <Match when={view() === "overview"}>
            <div class="empty"><div><Icon name="folder" size={30} /><p>还没有用 Claude Code 打开过任何项目</p></div></div>
          </Match>
          <Match when={view() === "git" && selected()}>
            {(p) => <GitView project={p()} toast={toast} goPublish={() => setView("github")} />}
          </Match>
          <Match when={view() === "github"}>
            <GitHubView project={selected()} user={ghUser()} loading={ghUser.loading} setUser={(u) => setGhUser(u)} toast={toast} />
          </Match>
          <Match when={view() === "claude"}>
            <ClaudeView project={selected()} projects={projects() ?? []} toast={toast} goTerminal={() => setView("terminal")} />
          </Match>
          <Match when={view() === "ai"}>
            <AiToolsView project={selected()} toast={toast} />
          </Match>
          <Match when={view() === "settings"}>
            <SettingsView toast={toast} user={ghUser()} project={selected()} theme={theme()} toggleTheme={toggleTheme} lite={lite()} toggleLite={toggleLite} goGitHub={() => setView("github")} />
          </Match>
        </Switch>
        {/* 终端始终挂载，切换页面不会丢失会话 */}
        <div class="term-host" style={{ display: view() === "terminal" ? "flex" : "none" }}>
          <TerminalPanel cwd={selected()?.path} projectName={selected()?.name} />
        </div>
      </main>

      <Show when={palette()}>
        <CommandPalette commands={commands()} onClose={() => setPalette(false)} />
      </Show>

      <div class="toasts">
        <For each={toasts()}>
          {(t) => (
            <div class="toast" classList={{ err: t.err }}>
              <span class="ico"><Icon name={t.err ? "close" : "check"} size={16} /></span>
              {t.msg}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
