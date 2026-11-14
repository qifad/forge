import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { ago, compact, openEditor, type Project } from "./api";
import { claude, type Bucket, type Hit, type Item, type McpServer, type MemFile, type Session } from "./claudeapi";
import { ConfirmDialog } from "./git";
import { Icon, type IconName } from "./icons";
import { terminals } from "./terminal";
import { HUES, hueVars } from "./views";

type Toast = (m: string, e?: boolean) => void;
type Tab = "sessions" | "usage" | "memory" | "mcp" | "settings" | "prompts";
type Ctx = { project?: Project; projects: Project[]; toast: Toast; goTerminal: () => void };

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "sessions", label: "会话", icon: "history" },
  { id: "usage", label: "用量", icon: "spark" },
  { id: "memory", label: "记忆", icon: "file" },
  { id: "mcp", label: "MCP", icon: "plug" },
  { id: "settings", label: "配置", icon: "settings" },
  { id: "prompts", label: "提示词", icon: "command" },
];

const shortModel = (m: string) => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
const modelHue = (m: string) => (m.includes("opus") ? 1 : m.includes("sonnet") ? 2 : m.includes("haiku") ? 3 : 4);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

/** 极简 Markdown：``` 代码块、`行内代码`、**粗体**，其余保留换行。 */
function Md(p: { text: string }) {
  const parts = createMemo(() => p.text.split(/```[\w-]*\n?/));
  const inline = (s: string): JSX.Element[] =>
    s.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((seg) =>
      seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? <code>{seg.slice(1, -1)}</code>
      : seg.startsWith("**") && seg.endsWith("**") && seg.length > 4 ? <b>{seg.slice(2, -2)}</b>
      : <>{seg}</>);
  return <div class="md"><For each={parts()}>{(seg, i) => (i() % 2 ? <pre>{seg.replace(/\n$/, "")}</pre> : <span>{inline(seg)}</span>)}</For></div>;
}

// ================================================================ 会话
function Sessions(c: Ctx) {
  const [scope, setScope] = createSignal<"project" | "all">(c.project ? "project" : "all");
  const pid = () => (scope() === "project" ? c.project?.id ?? null : null);
  const [list] = createResource(pid, (id) => claude.sessions(id), { initialValue: [] });
  const [q, setQ] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  let t = 0;
  createEffect(on(q, (v) => { clearTimeout(t); t = window.setTimeout(() => setDebounced(v.trim()), 280); }));
  const [hits] = createResource(() => (debounced().length >= 2 ? { q: debounced(), p: pid() } : null), ({ q, p }) => claude.search(q, p));
  const [sel, setSel] = createSignal<{ projectId: string; id: string } | null>(null);
  const [showTools, setShowTools] = createSignal(store.get("forge.showTools") !== "0");
  const [showThinking, setShowThinking] = createSignal(false);
  const [transcript] = createResource(sel, (s) => claude.transcript(s.projectId, s.id));

  createEffect(on(() => list(), (l) => { if (!sel() && l?.length) setSel({ projectId: l[0].projectId, id: l[0].id }); }));
  createEffect(on(() => c.project?.id, () => setSel(null), { defer: true }));

  const byId = createMemo(() => new Map((list() ?? []).map((s) => [s.id, s])));
  const projName = (id: string) => c.projects.find((p) => p.id === id)?.name ?? id.split("-").pop();
  const current = () => (sel() ? byId().get(sel()!.id) : undefined);
  const items = createMemo(() => (transcript() ?? []).filter((i) => !i.meta && !i.sidechain && (showTools() || (i.kind !== "tool_use" && i.kind !== "tool_result")) && (showThinking() || i.kind !== "thinking")));

  const resume = (s: Session) => {
    const cwd = s.cwd || c.project?.path;
    if (!cwd) return c.toast("找不到会话的工作目录", true);
    terminals.open(cwd, `claude --resume ${s.id}`, "继续 · " + s.title.slice(0, 16));
    c.goTerminal();
  };

  const SessionRow = (s: Session) => (
    <button class="srow" classList={{ on: sel()?.id === s.id }} onClick={() => setSel({ projectId: s.projectId, id: s.id })}>
      <div class="st">{s.title}</div>
      <div class="sm">
        <span>{ago(s.updated)}</span><span>{s.userTurns} 轮</span><span>{compact(s.tokens)} tokens</span>
        <Show when={scope() === "all"}><span class="sproj">{projName(s.projectId)}</span></Show>
      </div>
      <div class="sm">
        <For each={s.models}>{(m) => <span class="mchip" style={hueVars(modelHue(m))}>{shortModel(m)}</span>}</For>
        <Show when={s.gitBranch}><span class="muted"><Icon name="branch" size={11} /> {s.gitBranch}</span></Show>
      </div>
    </button>
  );
  const HitRow = (h: Hit) => (
    <button class="srow" classList={{ on: sel()?.id === h.sessionId }} onClick={() => setSel({ projectId: h.projectId, id: h.sessionId })}>
      <div class="st">{byId().get(h.sessionId)?.title ?? projName(h.projectId)}</div>
      <div class="snip">
        <span class="role">{h.role === "user" ? "你" : "Claude"}</span>
        {[...h.snippet].slice(0, h.at).join("")}<mark>{[...h.snippet].slice(h.at, h.at + h.len).join("")}</mark>{[...h.snippet].slice(h.at + h.len).join("")}
      </div>
      <div class="sm"><span>{ago(h.time)}</span><Show when={scope() === "all"}><span class="sproj">{projName(h.projectId)}</span></Show></div>
    </button>
  );

  return (
    <div class="split">
      <div class="card slist">
        <div class="slist-head">
          <div class="seg">
            <button classList={{ on: scope() === "project" }} disabled={!c.project} onClick={() => setScope("project")}>当前项目</button>
            <button classList={{ on: scope() === "all" }} onClick={() => setScope("all")}>全部</button>
          </div>
          <label class="filter grow1"><Icon name="search" size={13} /><input placeholder="搜索全部对话内容…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        </div>
        <div class="slist-body">
          <Show when={debounced().length >= 2} fallback={
            <Show when={!list.loading} fallback={<For each={[1, 2, 3, 4]}>{() => <div class="sk" style={{ height: "62px", margin: "6px" }} />}</For>}>
              <For each={list()} fallback={<div class="empty pad">还没有会话</div>}>{SessionRow}</For>
            </Show>
          }>
            <div class="fsec"><span>搜索结果</span><span class="cnt">{hits()?.length ?? "…"}</span></div>
            <For each={hits() ?? []} fallback={<Show when={!hits.loading}><div class="empty pad">没有找到「{debounced()}」</div></Show>}>{HitRow}</For>
          </Show>
        </div>
      </div>

      <div class="card sview">
        <Show when={current() || sel()} fallback={<div class="empty"><div><Icon name="history" size={30} /><p>选择一个会话查看完整对话</p></div></div>}>
          <div class="sview-head">
            <div style={{ "min-width": 0 }}>
              <div class="svt">{current()?.title ?? "会话"}</div>
              <div class="sm">
                <Show when={current()}>{(s) => <>
                  <span>{new Date(s().started).toLocaleString("zh-CN")}</span><span>{s().userTurns} 轮对话</span><span>{compact(s().tokens)} tokens</span>
                  <Show when={s().cost}><span>${s().cost!.toFixed(2)}</span></Show>
                </>}</Show>
                <span class="mono muted">{sel()!.id.slice(0, 8)}</span>
              </div>
            </div>
            <div class="row-gap">
              <label class="check"><input type="checkbox" checked={showTools()} onChange={(e) => { setShowTools(e.currentTarget.checked); store.set("forge.showTools", e.currentTarget.checked ? "1" : "0"); }} />工具调用</label>
              <label class="check"><input type="checkbox" checked={showThinking()} onChange={(e) => setShowThinking(e.currentTarget.checked)} />思考过程</label>
              <button class="btn sm" onClick={() => { navigator.clipboard.writeText(sel()!.id); c.toast("已复制会话 ID"); }}><Icon name="copy" size={13} />ID</button>
              <Show when={current()}><button class="btn sm primary" onClick={() => resume(current()!)}><Icon name="terminal" size={13} />在终端继续</button></Show>
            </div>
          </div>
          <div class="chat">
            <Show when={!transcript.loading} fallback={<For each={[1, 2, 3]}>{() => <div class="sk" style={{ height: "70px", margin: "14px 0" }} />}</For>}>
              <For each={items()}>{(i) => <Msg i={i} />}</For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

function Msg(p: { i: Item }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Switch>
      <Match when={p.i.kind === "text" && p.i.role === "user"}>
        <div class="msg user"><div class="bubble"><Md text={p.i.text} /></div></div>
      </Match>
      <Match when={p.i.kind === "text"}>
        <div class="msg ai">
          <div class="ai-dot"><Icon name="spark" size={13} /></div>
          <div class="ai-body"><Md text={p.i.text} /></div>
        </div>
      </Match>
      <Match when={p.i.kind === "thinking"}>
        <div class="msg think"><Icon name="spark" size={12} /><span>{p.i.text}</span></div>
      </Match>
      <Match when={p.i.kind === "tool_use"}>
        <div class="msg tool"><span class="tname">{p.i.tool}</span><span class="targ mono">{p.i.text}</span></div>
      </Match>
      <Match when={p.i.kind === "tool_result"}>
        <div class="msg result" classList={{ err: p.i.isError, open: open() }} onClick={() => setOpen(!open())}>
          <span class="mono">{p.i.text || "（空）"}</span>
        </div>
      </Match>
    </Switch>
  );
}

// ================================================================ 用量
function Usage(c: Ctx) {
  const [days, setDays] = createSignal(14);
  const [r] = createResource(days, claude.usage);
  const [nowT, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  const filled = createMemo(() => {
    const map = new Map((r()?.daily ?? []).map((d) => [d.key, d]));
    return Array.from({ length: days() }, (_, i) => {
      const d = new Date(Date.now() - (days() - 1 - i) * 86400e3);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return map.get(key) ?? { key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    });
  });
  const fresh = (b: Bucket) => b.input + b.output + b.cacheWrite;
  const tot = createMemo(() => {
    const ds = r()?.daily ?? [];
    const s = (f: (b: Bucket) => number) => ds.reduce((a, b) => a + f(b), 0);
    const inp = s((b) => b.input), cr = s((b) => b.cacheRead), cw = s((b) => b.cacheWrite);
    return { fresh: s(fresh), all: s((b) => fresh(b) + b.cacheRead), msgs: s((b) => b.messages), hit: inp + cr + cw ? cr / (inp + cr + cw) : 0 };
  });
  const max = createMemo(() => Math.max(1, ...filled().map(fresh)));
  const heatMax = createMemo(() => Math.max(1, ...(r()?.heatmap ?? [[0]]).flat()));
  const win = () => r()?.window;
  const winPct = () => (win() ? Math.min(1, (nowT() - win()!.start) / (win()!.resetAt - win()!.start)) : 0);
  const left = () => { const ms = Math.max(0, (win()?.resetAt ?? 0) - nowT()); return `${Math.floor(ms / 3600e3)} 小时 ${Math.floor((ms % 3600e3) / 60e3)} 分`; };
  const projName = (id: string) => c.projects.find((p) => p.id === id)?.name ?? id.split("-").slice(-1)[0];

  const Bars = (p: { rows: Bucket[]; label: (k: string) => string }) => {
    const total = () => p.rows.reduce((a, b) => a + fresh(b), 0) || 1;
    return (
      <div class="hbars">
        <For each={p.rows.slice(0, 8)}>
          {(b, i) => (
            <div class="hbar" style={hueVars(i())}>
              <div class="hl"><span>{p.label(b.key)}</span><span class="muted">{compact(fresh(b))} · {((fresh(b) / total()) * 100).toFixed(0)}%</span></div>
              <div class="track"><i style={{ width: `${(fresh(b) / total()) * 100}%`, "animation-delay": `${i() * 60}ms` }} /></div>
            </div>
          )}
        </For>
      </div>
    );
  };

  return (
    <Show when={!r.loading || r()} fallback={<div class="sk" style={{ height: "300px" }} />}>
      <div class="grid usage-top">
        <div class="card window-card">
          <h3><Icon name="history" size={15} />5 小时窗口<span class="r tag soon">估算</span></h3>
          <Show when={win()} fallback={<div class="empty pad"><Icon name="check" size={24} />当前没有活跃窗口，下一条消息开始计时</div>}>
            <div class="ring-wrap">
              <svg viewBox="0 0 120 120" class="ring">
                <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a5b" /><stop offset=".5" stop-color="#ff5fa2" /><stop offset="1" stop-color="#8b7bff" /></linearGradient></defs>
                <circle cx="60" cy="60" r="50" class="ring-bg" />
                <circle cx="60" cy="60" r="50" class="ring-fg" stroke="url(#rg)" stroke-dasharray={`${winPct() * 314} 314`} />
              </svg>
              <div class="ring-text"><b>{left()}</b><span>后重置</span></div>
            </div>
            <div class="win-meta">
              <div><span class="muted">本窗口</span><b>{compact(win()!.tokens)}</b><span class="muted">tokens</span></div>
              <div><span class="muted">消息</span><b>{win()!.messages}</b></div>
              <div><span class="muted">开始于</span><b>{new Date(win()!.start).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</b></div>
            </div>
          </Show>
        </div>
        <div class="grid stat4">
          <div class="card stat" style={hueVars(0)}><div class="label"><span class="ib"><Icon name="spark" size={14} /></span>新增 Tokens</div><div class="value"><span class="gt">{compact(tot().fresh)}</span></div><div class="delta">输入 + 输出 + 缓存写入</div></div>
          <div class="card stat" style={hueVars(1)}><div class="label"><span class="ib"><Icon name="layers" size={14} /></span>含缓存读取</div><div class="value"><span class="gt">{compact(tot().all)}</span></div><div class="delta">{tot().msgs} 条回复 · {r()?.sessions ?? 0} 个会话</div></div>
          <div class="card stat" style={hueVars(2)}><div class="label"><span class="ib"><Icon name="bell" size={14} /></span>缓存命中率</div><div class="value"><span class="gt">{(tot().hit * 100).toFixed(1)}</span><small>%</small></div><div class="delta">越高越省</div></div>
          <div class="card stat" style={hueVars(4)}><div class="label"><span class="ib"><Icon name="box" size={14} /></span>记录的费用</div><div class="value"><span class="gt">${(r()?.cost ?? 0).toFixed(2)}</span></div><div class="delta">来自 Claude Code 会话记录</div></div>
        </div>
      </div>

      <div class="card" style={{ "margin-top": "14px" }}>
        <h3><Icon name="spark" size={15} />每日用量
          <span class="r seg">
            <For each={[7, 14, 30, 90]}>{(d) => <button classList={{ on: days() === d }} onClick={() => setDays(d)}>{d} 天</button>}</For>
          </span>
        </h3>
        <div class="chart" style={{ height: "180px" }}>
          <For each={filled()}>
            {(d, i) => (
              <div class="bar-col">
                <div class="pop"><b>{d.key.slice(5)}</b> · 输出 {compact(d.output)} · 输入 {compact(d.input + d.cacheWrite)} · {d.messages} 条</div>
                <div class="bar" style={{ height: `${Math.max(2, (fresh(d) / max()) * 140)}px`, "animation-delay": `${i() * 12}ms` }}>
                  <i class="a" style={{ flex: d.output || 0.0001 }} /><i class="b" style={{ flex: d.input + d.cacheWrite || 0.0001 }} />
                </div>
                <Show when={days() <= 30 || i() % 7 === 0}><span class="d">{d.key.slice(8)}</span></Show>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="grid usage-bottom">
        <div class="card"><h3><Icon name="layers" size={15} />按模型</h3><Bars rows={r()?.byModel ?? []} label={shortModel} /></div>
        <div class="card"><h3><Icon name="folder" size={15} />按项目</h3><Bars rows={r()?.byProject ?? []} label={projName} /></div>
        <div class="card">
          <h3><Icon name="kanban" size={15} />活跃时段<span class="r muted">本地时间</span></h3>
          <div class="heat">
            <For each={["一", "二", "三", "四", "五", "六", "日"]}>
              {(d, di) => (
                <div class="hrow">
                  <span class="hd">{d}</span>
                  <For each={r()?.heatmap[di()] ?? []}>
                    {(n, h) => <i title={`周${d} ${h()}:00 · ${n} 条`} style={{ opacity: n ? 0.18 + (n / heatMax()) * 0.82 : 0.06, background: n ? HUES[Math.min(5, Math.floor((n / heatMax()) * 3))][1] : "var(--text-3)" }} />}
                  </For>
                </div>
              )}
            </For>
            <div class="hrow hx"><span class="hd" /><For each={[0, 6, 12, 18]}>{(h) => <span style={{ "grid-column": `${h + 2}` }}>{h}</span>}</For></div>
          </div>
        </div>
      </div>
    </Show>
  );
}

// ================================================================ 记忆
const TEMPLATES: { label: string; body: string }[] = [
  { label: "项目概述", body: "# 项目概述\n\n一句话说明这个项目做什么、给谁用。\n\n## 技术栈\n- \n\n## 目录结构\n- `src/`：\n" },
  { label: "常用命令", body: "## 常用命令\n- 安装依赖：\n- 开发运行：\n- 运行测试：\n- 构建发布：\n" },
  { label: "代码约定", body: "## 代码约定\n- 命名：\n- 错误处理：\n- 注释与文档语言：中文\n- 提交信息：Conventional Commits\n" },
  { label: "工作方式", body: "## 与 Claude 协作\n- 修改前先说明计划，改动保持最小\n- 改完运行测试并报告结果\n- 不要提交 .env 和密钥\n" },
];

function Memory(c: Ctx) {
  const [files, { refetch }] = createResource(() => ({ p: c.project?.path ?? null, id: c.project?.id ?? null }), ({ p, id }) => claude.memFiles(p, id));
  const [sel, setSel] = createSignal<MemFile | null>(null);
  const [text, setText] = createSignal("");
  const [orig, setOrig] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const dirty = () => text() !== orig();
  createEffect(on(files, (fs) => { if (fs && (!sel() || !fs.some((f) => f.path === sel()!.path))) setSel(fs.find((f) => f.exists) ?? fs[0] ?? null); }));
  createEffect(on(sel, async (f) => {
    if (!f) return;
    const t = await claude.memRead(f.path, c.project?.path ?? null, c.project?.id ?? null).catch((e) => { c.toast(String(e), true); return ""; });
    setText(t); setOrig(t);
  }));
  const save = async () => {
    const f = sel();
    if (!f || !dirty()) return;
    setSaving(true);
    try { await claude.memWrite(f.path, text(), c.project?.path ?? null, c.project?.id ?? null); setOrig(text()); c.toast(f.exists ? "已保存" : "已创建并保存"); refetch(); }
    catch (e) { c.toast(String(e), true); }
    finally { setSaving(false); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } };
  let ta!: HTMLTextAreaElement;
  const insert = (body: string) => {
    const s = ta.selectionStart, cur = text();
    const pre = cur.slice(0, s), sep = pre && !pre.endsWith("\n\n") ? (pre.endsWith("\n") ? "\n" : "\n\n") : "";
    setText(pre + sep + body + cur.slice(s));
    ta.focus();
  };
  const scopeIcon: Record<string, IconName> = { user: "settings", project: "folder", local: "lock", auto: "spark" };
  const lines = () => text().split("\n").length;
  const tokens = () => Math.round([...text()].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 0.7 : 0.27), 0));

  return (
    <div class="split mem">
      <div class="card slist">
        <div class="fsec"><span>记忆文件</span><span class="muted" style={{ "margin-left": "auto", "letter-spacing": 0 }}>Claude 每次启动都会读取</span></div>
        <For each={files() ?? []}>
          {(f, i) => (
            <button class="memrow" classList={{ on: sel()?.path === f.path }} style={hueVars(i())} onClick={() => { if (!dirty() || confirm("有未保存的修改，确定切换吗？")) setSel(f); }}>
              <span class="ib"><Icon name={scopeIcon[f.scope]} size={14} /></span>
              <div class="bmeta">
                <div class="bname">{f.label}<Show when={!f.exists}><span class="tag soon">未创建</span></Show></div>
                <div class="bsub">{f.hint}</div>
              </div>
              <Show when={f.exists}><span class="muted" style={{ "font-size": "11px" }}>{ago(f.modified)}</span></Show>
            </button>
          )}
        </For>
        <Show when={!c.project}><div class="empty pad">选择一个项目以编辑项目级记忆</div></Show>
      </div>
      <div class="card editor">
        <Show when={sel()} fallback={<div class="empty">选择左侧文件</div>}>
          <div class="ed-head">
            <span class="mono ed-path" title={sel()!.path}>{sel()!.path}</span>
            <Show when={dirty()}><span class="tag accent">未保存</span></Show>
            <div class="row-gap" style={{ "margin-left": "auto" }}>
              <select class="tpl" onChange={(e) => { const t = TEMPLATES[+e.currentTarget.value]; if (t) insert(t.body); e.currentTarget.value = ""; }}>
                <option value="">插入模板…</option>
                <For each={TEMPLATES}>{(t, i) => <option value={i()}>{t.label}</option>}</For>
              </select>
              <Show when={sel()!.exists}><button class="btn sm" onClick={() => openEditor(sel()!.path)}><Icon name="code" size={13} />VS Code</button></Show>
              <button class="btn sm primary" disabled={!dirty() || saving()} onClick={save}><Icon name="check" size={13} />{sel()!.exists ? "保存" : "创建"} <kbd>Ctrl S</kbd></button>
            </div>
          </div>
          <textarea ref={ta} class="ed-area" spellcheck={false} value={text()} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={onKey}
            placeholder={"这个文件还不存在。写点什么并保存即可创建，例如：\n\n# 项目说明\n- 构建命令：npm run build\n- 代码风格：…"} />
          <div class="ed-foot muted"><span>{lines()} 行</span><span>{text().length} 字符</span><span>约 {tokens()} tokens（每次会话都会占用上下文）</span></div>
        </Show>
      </div>
    </div>
  );
}

// ================================================================ MCP
function Mcp(c: Ctx) {
  const pp = () => c.project?.path ?? null;
  const [list, { refetch }] = createResource(pp, (p) => claude.mcpList(p), { initialValue: [] });
  const [version] = createResource(() => claude.version().catch((e) => "✗ " + e));
  const [health, setHealth] = createSignal<Record<string, { status: string; detail: string }>>({});
  const [checking, setChecking] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [confirmDel, setConfirmDel] = createSignal<McpServer | null>(null);
  const [f, setF] = createSignal({ name: "", scope: "user", transport: "stdio", target: "", args: "", env: "" });
  const upd = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const check = async () => {
    setChecking(true);
    try { const h = await claude.mcpHealth(pp()); setHealth(Object.fromEntries(h.map((x) => [x.name, x]))); }
    catch (e) { c.toast(String(e), true); }
    finally { setChecking(false); }
  };
  const add = async () => {
    const v = f();
    try {
      await claude.mcpAdd(pp(), v.scope, v.name.trim(), v.transport, v.target.trim(), v.args.trim() ? v.args.trim().split(/\s+/) : [], v.env.split("\n").map((s) => s.trim()).filter(Boolean));
      c.toast(`已添加 ${v.name}`); setAdding(false); setF({ name: "", scope: "user", transport: "stdio", target: "", args: "", env: "" }); refetch();
    } catch (e) { c.toast(String(e), true); }
  };
  const remove = async (s: McpServer) => {
    try { await claude.mcpRemove(pp(), s.name, s.scope); c.toast(`已移除 ${s.name}`); refetch(); } catch (e) { c.toast(String(e), true); }
  };
  const SCOPE: Record<string, [string, string]> = { user: ["用户", "所有项目可用"], local: ["本地", "仅当前项目、仅本机"], project: ["项目", ".mcp.json，随仓库共享"] };

  return (
    <>
      <div class="mcp-bar">
        <span class="chip"><Icon name="terminal" size={13} />{version.loading ? "检测 Claude Code…" : version()}</span>
        <div class="row-gap" style={{ "margin-left": "auto" }}>
          <button class="btn sm" classList={{ spin: checking() }} onClick={check} disabled={checking()}><Icon name="refresh" size={13} />{checking() ? "检测中…" : "检测连接"}</button>
          <button class="btn sm primary" onClick={() => setAdding(!adding())}><Icon name="plus" size={13} />添加服务器</button>
        </div>
      </div>

      <Show when={adding()}>
        <div class="card mcp-form">
          <div class="pub-grid">
            <div class="pub-form">
              <label class="lbl">名称</label>
              <input class="field" placeholder="例如 github、filesystem" value={f().name} onInput={(e) => upd("name", e.currentTarget.value)} />
              <label class="lbl">作用域</label>
              <div class="seg big"><For each={["user", "local", "project"]}>{(s) => <button classList={{ on: f().scope === s }} onClick={() => upd("scope", s)} disabled={s !== "user" && !c.project}>{SCOPE[s][0]}</button>}</For></div>
              <div class="muted" style={{ "font-size": "12px" }}>{SCOPE[f().scope][1]}</div>
              <label class="lbl">连接方式</label>
              <div class="seg big"><For each={[["stdio", "本地命令"], ["http", "HTTP"], ["sse", "SSE"]]}>{([k, l]) => <button classList={{ on: f().transport === k }} onClick={() => upd("transport", k)}>{l}</button>}</For></div>
            </div>
            <div class="pub-form">
              <Show when={f().transport === "stdio"} fallback={<>
                <label class="lbl">URL</label>
                <input class="field" placeholder="https://mcp.example.com/mcp" value={f().target} onInput={(e) => upd("target", e.currentTarget.value)} />
              </>}>
                <label class="lbl">命令</label>
                <input class="field mono" placeholder="npx" value={f().target} onInput={(e) => upd("target", e.currentTarget.value)} />
                <label class="lbl">参数（空格分隔）</label>
                <input class="field mono" placeholder="-y @modelcontextprotocol/server-filesystem C:/work" value={f().args} onInput={(e) => upd("args", e.currentTarget.value)} />
                <label class="lbl">环境变量（每行一个 KEY=VALUE）</label>
                <textarea class="field mono" rows={3} value={f().env} onInput={(e) => upd("env", e.currentTarget.value)} style={{ height: "auto", padding: "8px 11px" }} />
              </Show>
              <div class="row-gap" style={{ "margin-top": "12px" }}>
                <button class="btn primary" disabled={!f().name.trim() || !f().target.trim()} onClick={add}><Icon name="check" size={14} />通过 claude mcp add 添加</button>
                <button class="btn" onClick={() => setAdding(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <div class="grid mcp-grid">
        <For each={list()} fallback={<div class="card empty pad"><Icon name="plug" size={26} />还没有配置 MCP 服务器</div>}>
          {(s, i) => {
            const h = () => health()[s.name];
            return (
              <div class="card mcp" style={{ ...hueVars(i()), "animation-delay": `${i() * 40}ms` }}>
                <div class="mcp-top">
                  <span class="ib"><Icon name={s.transport === "stdio" ? "terminal" : "globe"} size={15} /></span>
                  <div class="bmeta">
                    <div class="bname">{s.name}<span class="tag soon">{SCOPE[s.scope][0]}</span><Show when={s.disabled}><span class="tag soon">已禁用</span></Show></div>
                    <div class="bsub mono">{s.target}</div>
                  </div>
                  <span class={`hdot ${h()?.status ?? "none"}`} title={h()?.detail ?? "未检测"} />
                </div>
                <div class="mcp-foot">
                  <span class="chip">{s.transport.toUpperCase()}</span>
                  <Show when={s.envKeys.length}><span class="chip"><Icon name="lock" size={11} />{s.envKeys.join(", ")}</span></Show>
                  <Show when={h()}><span class={`hstat ${h()!.status}`}>{{ ok: "已连接", fail: "连接失败", auth: "需要认证", unknown: h()!.detail }[h()!.status]}</span></Show>
                  <button class="icon-btn" style={{ "margin-left": "auto" }} title="移除" onClick={() => setConfirmDel(s)}><Icon name="close" size={13} /></button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={confirmDel()}>{(s) => (
        <ConfirmDialog c={{ title: `移除 MCP 服务器「${s().name}」？`, body: `将执行 claude mcp remove ${s().name} -s ${s().scope}。`, danger: true, okLabel: "移除", ok: () => remove(s()) }} close={() => setConfirmDel(null)} />
      )}</Show>
    </>
  );
}

// ================================================================ 配置
function Settings(c: Ctx) {
  const [files] = createResource(() => c.project?.path ?? null, (p) => claude.settings(p));
  return (
    <div class="grid settings-grid">
      <For each={files() ?? []}>
        {(s, i) => (
          <div class="card" style={{ ...hueVars(i()), "animation-delay": `${i() * 50}ms` }}>
            <h3><span class="ib sm"><Icon name={s.scope === "user" ? "settings" : s.scope === "local" ? "lock" : "folder"} size={13} /></span>{s.label}
              <Show when={s.exists} fallback={<span class="r tag soon">不存在</span>}>
                <button class="r btn sm" onClick={() => openEditor(s.path)}><Icon name="code" size={12} />编辑</button>
              </Show>
            </h3>
            <div class="mono muted path-line" title={s.path}>{s.path}</div>
            <Show when={s.error}><div class="findings"><div class="ft">{s.error}</div></div></Show>
            <Show when={s.exists && !s.error}>
              <Show when={s.model}><div class="kv-row"><span class="k">模型</span><span class="v">{s.model}</span></div></Show>
              <Show when={s.env.length}>
                <div class="sub-h">环境变量</div>
                <For each={s.env}>{([k, v]) => <div class="kv-row"><span class="k mono" style={{ width: "auto", "min-width": "45%" }}>{k}</span><span class="v mono" classList={{ muted: v.startsWith("已设置") }}>{v}</span></div>}</For>
              </Show>
              <Show when={s.allow.length || s.deny.length}>
                <div class="sub-h">权限</div>
                <div class="pills">
                  <For each={s.allow}>{(a) => <span class="pill ok mono">✓ {a}</span>}</For>
                  <For each={s.deny}>{(d) => <span class="pill no mono">✕ {d}</span>}</For>
                </div>
              </Show>
              <Show when={s.hooks.length}>
                <div class="sub-h">Hooks</div>
                <div class="pills"><For each={s.hooks}>{([k, n]) => <span class="pill">{k} × {n}</span>}</For></div>
              </Show>
              <Show when={s.other.length}><div class="sub-h">其他</div><div class="pills"><For each={s.other}>{(k) => <span class="pill mono">{k}</span>}</For></div></Show>
              <Show when={!s.model && !s.env.length && !s.allow.length && !s.deny.length && !s.hooks.length && !s.other.length}><div class="empty pad">空配置</div></Show>
            </Show>
          </div>
        )}
      </For>
      <div class="card hint-card">
        <h3><Icon name="shield" size={15} />关于安全</h3>
        <p class="muted">名称含 TOKEN、KEY、SECRET、PASSWORD、AUTH 的环境变量只显示「已设置」，Forge 不会读出或传输它们的值。修改配置请点「编辑」在 VS Code 中打开。</p>
      </div>
    </div>
  );
}

// ================================================================ 提示词
type Prompt = { id: string; title: string; body: string };
const DEFAULT_PROMPTS: Prompt[] = [
  { id: "p1", title: "熟悉项目", body: "通读 {{project}} 的目录结构和关键文件，用中文总结：它是做什么的、怎么构建运行、核心模块之间的关系。不要修改任何文件。" },
  { id: "p2", title: "审查当前改动", body: "审查当前未提交的改动（git diff 与 git diff --cached），按严重程度列出 bug、边界情况和可读性问题，并给出具体修改建议。" },
  { id: "p3", title: "补充测试", body: "为最近修改的代码补充单元测试，覆盖正常路径和边界情况。写完后运行测试并报告结果。" },
  { id: "p4", title: "修复失败的测试", body: "运行测试，找出失败的用例，定位根因后修复。不要通过修改断言来让测试通过。" },
  { id: "p5", title: "写提交信息", body: "根据暂存区的改动，用 Conventional Commits 格式写一条提交信息，正文用中文说明为什么这样改。" },
];

function Prompts(c: Ctx) {
  const load = (): Prompt[] => { try { return JSON.parse(store.get("forge.prompts") ?? "") as Prompt[]; } catch { return DEFAULT_PROMPTS; } };
  const [list, setList] = createSignal<Prompt[]>(load());
  const [sel, setSel] = createSignal<string>(list()[0]?.id ?? "");
  const cur = () => list().find((p) => p.id === sel());
  const save = (l: Prompt[]) => { setList(l); store.set("forge.prompts", JSON.stringify(l)); };
  const update = (k: "title" | "body", v: string) => save(list().map((p) => (p.id === sel() ? { ...p, [k]: v } : p)));
  const fill = (s: string) => s.replace(/\{\{project\}\}/g, c.project?.name ?? "").replace(/\{\{path\}\}/g, c.project?.path ?? "").replace(/\{\{date\}\}/g, new Date().toLocaleDateString("zh-CN"));
  const send = () => {
    if (terminals.send(fill(cur()!.body))) { c.toast("已输入到终端，检查后按回车发送"); c.goTerminal(); }
    else c.toast("请先在「终端」页打开一个 Claude 会话", true);
  };
  return (
    <div class="split mem">
      <div class="card slist">
        <div class="fsec"><span>提示词库</span><button class="link" style={{ "margin-left": "auto" }} onClick={() => { const p = { id: "p" + Date.now(), title: "新提示词", body: "" }; save([...list(), p]); setSel(p.id); }}>＋ 新建</button></div>
        <For each={list()}>
          {(p, i) => (
            <button class="memrow" classList={{ on: sel() === p.id }} style={hueVars(i())} onClick={() => setSel(p.id)}>
              <span class="ib"><Icon name="command" size={14} /></span>
              <div class="bmeta"><div class="bname">{p.title}</div><div class="bsub">{p.body.slice(0, 40)}</div></div>
            </button>
          )}
        </For>
      </div>
      <div class="card editor">
        <Show when={cur()} fallback={<div class="empty">新建一个提示词</div>}>
          <div class="ed-head">
            <input class="field title-in" value={cur()!.title} onInput={(e) => update("title", e.currentTarget.value)} />
            <div class="row-gap" style={{ "margin-left": "auto" }}>
              <button class="btn sm" onClick={() => { navigator.clipboard.writeText(fill(cur()!.body)); c.toast("已复制"); }}><Icon name="copy" size={13} />复制</button>
              <button class="btn sm" onClick={() => { save(list().filter((p) => p.id !== sel())); setSel(list()[0]?.id ?? ""); }}>删除</button>
              <button class="btn sm primary" onClick={send}><Icon name="terminal" size={13} />发送到终端</button>
            </div>
          </div>
          <textarea class="ed-area" value={cur()!.body} onInput={(e) => update("body", e.currentTarget.value)} placeholder="写下提示词，可以使用 {{project}}、{{path}}、{{date}} 变量" />
          <div class="ed-foot muted"><span>变量：<code>{"{{project}}"}</code> <code>{"{{path}}"}</code> <code>{"{{date}}"}</code></span><span>自动保存</span></div>
        </Show>
      </div>
    </div>
  );
}

// ================================================================ 页面
export function ClaudeView(p: Ctx) {
  const [tab, setTab] = createSignal<Tab>((store.get("forge.claudeTab") as Tab) || "sessions");
  const pick = (t: Tab) => { setTab(t); store.set("forge.claudeTab", t); };
  onMount(() => {});
  return (
    <div class="page wide">
      <div class="gbar">
        <div class="seg">
          <For each={TABS}>{(t) => <button classList={{ on: tab() === t.id }} onClick={() => pick(t.id)}><Icon name={t.icon} size={14} />{t.label}</button>}</For>
        </div>
        <Show when={p.project}><span class="chip"><Icon name="folder" size={13} />{p.project!.name}</span></Show>
      </div>
      <div class="cc-body">
        <Switch>
          <Match when={tab() === "sessions"}><Sessions {...p} /></Match>
          <Match when={tab() === "usage"}><div class="scroll"><Usage {...p} /></div></Match>
          <Match when={tab() === "memory"}><Memory {...p} /></Match>
          <Match when={tab() === "mcp"}><div class="scroll"><Mcp {...p} /></div></Match>
          <Match when={tab() === "settings"}><div class="scroll"><Settings {...p} /></div></Match>
          <Match when={tab() === "prompts"}><Prompts {...p} /></Match>
        </Switch>
      </div>
    </div>
  );
}
