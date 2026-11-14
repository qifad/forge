import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { pty } from "./claudeapi";
import { ai, notify, prefs } from "./aiapi";
import { Icon } from "./icons";

export type TermTab = { id: string; title: string; cwd: string; command: string | null; exited: boolean; attention: boolean };

// ---------------------------------------------------------------- 全局终端状态（跨页面保持）
const [tabs, setTabs] = createSignal<TermTab[]>([]);
const [active, setActiveRaw] = createSignal<string | null>(null);
const [panelVisible, setPanelVisible] = createSignal(false);
const terms = new Map<string, Terminal>();
let wired = false;

const setAttention = (id: string, v: boolean) => setTabs((ts) => ts.map((t) => (t.id === id && t.attention !== v ? { ...t, attention: v } : t)));
const setActive = (id: string | null) => { setActiveRaw(id); if (id) setAttention(id, false); };

// ---- 完成提醒：响铃，或「持续输出一段时间后安静下来」
const burstStart = new Map<string, number>();
const idleTimer = new Map<string, number>();
const lastNotified = new Map<string, number>();
function alert(id: string, why: "bell" | "idle") {
  const tab = tabs().find((t) => t.id === id);
  if (!tab || !tab.command?.startsWith("claude")) return;
  const watching = document.hasFocus() && panelVisible() && active() === id;
  if (watching) return;
  if (Date.now() - (lastNotified.get(id) ?? 0) < 15_000) return;
  lastNotified.set(id, Date.now());
  setAttention(id, true);
  notify(why === "bell" ? "Claude 需要你" : "Claude 停下来了", `${tab.title}：${why === "bell" ? "任务完成或正在等待你的确认" : "可能已完成，或在等待你的确认"}`).catch(() => {});
}
function onActivity(id: string) {
  if (!burstStart.has(id)) burstStart.set(id, Date.now());
  clearTimeout(idleTimer.get(id));
  const secs = +prefs.get("idleSecs", "8");
  idleTimer.set(id, window.setTimeout(() => {
    const started = burstStart.get(id) ?? Date.now();
    burstStart.delete(id);
    // 只有持续工作了一阵（排除敲一下键盘的回显）才算一次「完成」
    if (Date.now() - started - secs * 1000 >= 10_000 && prefs.bool("notifyIdle", true)) alert(id, "idle");
  }, secs * 1000));
}

function wire() {
  if (wired) return;
  wired = true;
  pty.onData((e) => { terms.get(e.id)?.write(e.data); onActivity(e.id); });
  pty.onBell((id) => { if (prefs.bool("notifyBell", true)) alert(id, "bell"); });
  pty.onExit((id) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, exited: true } : t)));
    terms.get(id)?.write("\r\n\x1b[2m[进程已结束，按任意键关闭此标签]\x1b[0m\r\n");
  });
}

export const terminals = {
  tabs,
  active,
  setActive,
  setPanelVisible,
  open(cwd: string, command: string | null, title?: string) {
    wire();
    const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const name = title ?? (command ? command.split(" ")[0] : cwd.split(/[\\/]/).pop() || "终端");
    // Claude 动手之前自动拍一个检查点（非 Git 项目会静默跳过）
    if (command?.startsWith("claude") && prefs.bool("autoCheckpoint", true)) {
      ai.createCheckpoint(cwd, `启动 Claude 前 · ${name}`).catch(() => {});
    }
    setTabs((ts) => [...ts, { id, title: name, cwd, command, exited: false, attention: false }]);
    setActive(id);
    return id;
  },
  close(id: string) {
    pty.kill(id);
    terms.get(id)?.dispose();
    terms.delete(id);
    const rest = tabs().filter((t) => t.id !== id);
    setTabs(rest);
    if (active() === id) setActive(rest[rest.length - 1]?.id ?? null);
  },
  /** 把文字输入当前终端（不自动回车，方便先检查再发送） */
  send(text: string) {
    const id = active();
    if (!id) return false;
    pty.write(id, text.replace(/\n/g, "\r"));
    terms.get(id)?.focus();
    return true;
  },
};

const THEME = {
  background: "#0e0f14",
  foreground: "#e6e7eb",
  cursor: "#ff7a6b",
  cursorAccent: "#0e0f14",
  selectionBackground: "rgba(255, 110, 140, 0.3)",
  black: "#1b1d24", red: "#ff6b6b", green: "#5cc48c", yellow: "#e6b65e", blue: "#6ea8f0", magenta: "#c08bff", cyan: "#46c9ff", white: "#d7d9de",
  brightBlack: "#5c6170", brightRed: "#ff8a8a", brightGreen: "#7ad8a5", brightYellow: "#f2cb7c", brightBlue: "#8fbcf5", brightMagenta: "#d4a8ff", brightCyan: "#7dd9ff", brightWhite: "#ffffff",
};

function TermView(p: { tab: TermTab; visible: boolean }) {
  let host!: HTMLDivElement;
  onMount(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 8000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terms.set(p.tab.id, term);
    const safeFit = () => { if (host.offsetWidth > 0 && host.offsetHeight > 0) { try { fit.fit(); } catch {} } };
    safeFit();
    pty.spawn(p.tab.id, p.tab.cwd, p.tab.command, term.cols, term.rows).catch((e) => term.write(`\x1b[31m${e}\x1b[0m\r\n`));
    term.onData((d) => {
      const t = tabs().find((x) => x.id === p.tab.id);
      if (t?.exited) return terminals.close(p.tab.id);
      pty.write(p.tab.id, d);
    });
    term.onResize(({ cols, rows }) => pty.resize(p.tab.id, cols, rows));
    // Ctrl+C 有选区时复制，Ctrl+V 粘贴
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      if (e.key === "c" && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
      if (e.key === "v") { navigator.clipboard.readText().then((t) => pty.write(p.tab.id, t)); return false; }
      return true;
    });
    const ro = new ResizeObserver(() => safeFit());
    ro.observe(host);
    if (p.visible) term.focus();
    onCleanup(() => ro.disconnect());
  });
  return <div class="term-view" ref={host} style={{ display: p.visible ? "block" : "none" }} />;
}

export function TerminalPanel(p: { cwd: string | undefined; projectName: string | undefined }) {
  const newShell = () => p.cwd && terminals.open(p.cwd, null, p.projectName);
  const newClaude = (cmd: string) => p.cwd && terminals.open(p.cwd, cmd, "Claude · " + (p.projectName ?? ""));
  return (
    <div class="term-panel">
      <div class="term-bar">
        <div class="term-tabs">
          <For each={tabs()}>
            {(t) => (
              <div class="term-tab" classList={{ on: active() === t.id, dead: t.exited, attn: t.attention }} onClick={() => setActive(t.id)}>
                <Icon name={t.command?.startsWith("claude") ? "spark" : "terminal"} size={13} />
                <span>{t.title}</span>
                <button class="x" onClick={(e) => { e.stopPropagation(); terminals.close(t.id); }} title="关闭"><Icon name="close" size={11} /></button>
              </div>
            )}
          </For>
        </div>
        <div class="row-gap">
          <button class="btn sm" disabled={!p.cwd} onClick={newShell}><Icon name="plus" size={13} />终端</button>
          <button class="btn sm" disabled={!p.cwd} onClick={() => newClaude("claude --continue")}><Icon name="history" size={13} />继续会话</button>
          <button class="btn sm primary" disabled={!p.cwd} onClick={() => newClaude("claude")}><Icon name="spark" size={13} />新 Claude</button>
        </div>
      </div>
      <div class="term-body">
        <Show when={tabs().length} fallback={
          <div class="empty">
            <div class="term-empty">
              <div class="gh-mark"><Icon name="terminal" size={28} /></div>
              <h2>内置终端</h2>
              <p class="muted">在当前项目目录打开终端，或直接启动 Claude。标签页在切换页面时会一直保留。</p>
              <div class="row-gap" style={{ "justify-content": "center" }}>
                <button class="btn" disabled={!p.cwd} onClick={newShell}><Icon name="terminal" size={15} />打开终端</button>
                <button class="btn primary" disabled={!p.cwd} onClick={() => newClaude("claude")}><Icon name="spark" size={15} />启动 Claude</button>
              </div>
            </div>
          </div>
        }>
          <For each={tabs()}>{(t) => <TermView tab={t} visible={active() === t.id} />}</For>
        </Show>
      </div>
    </div>
  );
}
