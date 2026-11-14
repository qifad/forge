import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { ago, compact, type Project } from "./api";
import { ai, notify, prefs, type Change, type Checkpoint, type FileInfo } from "./aiapi";
import { claude } from "./claudeapi";
import { ConfirmDialog } from "./git";
import { parseDiff } from "./gitapi";
import { Icon, type IconName } from "./icons";
import { hueVars } from "./views";

type Toast = (m: string, e?: boolean) => void;
type Ctx = { project?: Project; toast: Toast };
type Tab = "checkpoints" | "pack" | "map" | "notify";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "checkpoints", label: "检查点与改动审查", icon: "shield" },
  { id: "pack", label: "上下文打包", icon: "box" },
  { id: "map", label: "项目地图", icon: "layers" },
  { id: "notify", label: "完成通知", icon: "bell" },
];

export function DiffText(p: { raw: string }) {
  const d = createMemo(() => parseDiff(p.raw));
  return (
    <Switch>
      <Match when={d().binary}><div class="empty pad"><Icon name="box" size={24} />二进制文件</div></Match>
      <Match when={!d().hunks.length}><div class="empty pad">没有差异</div></Match>
      <Match when={true}>
        <For each={d().hunks}>
          {(h) => (
            <div class="hunk">
              <div class="hunk-head"><span class="mono">{h.header}</span></div>
              <For each={h.lines.slice(0, 3000)}>
                {(l) => (
                  <div class={`dl dl-${l.t === "+" ? "add" : l.t === "-" ? "del" : l.t === "\\" ? "meta" : "ctx"}`}>
                    <span class="ln">{l.a ?? ""}</span><span class="ln">{l.b ?? ""}</span><span class="sg">{l.t === " " ? "" : l.t}</span><span class="code">{l.text}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Match>
    </Switch>
  );
}

// ================================================================ 检查点
function Checkpoints(c: Ctx & { project: Project }) {
  const path = () => c.project.path;
  const [list, { refetch }] = createResource(path, ai.checkpoints);
  const [sel, setSel] = createSignal<Checkpoint | null>(null);
  const [label, setLabel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [auto, setAuto] = createSignal(prefs.bool("autoCheckpoint", true));
  const [file, setFile] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal<null | { title: string; body: string; ok: () => void; label: string }>(null);
  createEffect(on(list, (l) => { if (l && (!sel() || !l.some((x) => x.id === sel()!.id))) setSel(l[0] ?? null); }));
  const [changes, { refetch: refetchChanges }] = createResource(() => (sel() ? { p: path(), t: sel()!.tree } : null), ({ p, t }) => ai.changes(p, t));
  createEffect(on(changes, (ch) => { if (ch && (!file() || !ch.some((x) => x.path === file()))) setFile(ch[0]?.path ?? null); }));
  const [diff] = createResource(() => (sel() && file() ? { p: path(), t: sel()!.tree, f: file()! } : null), ({ p, t, f }) => ai.fileDiff(p, t, f));

  const create = async () => {
    setBusy(true);
    try {
      const ck = await ai.createCheckpoint(path(), label().trim() || "手动检查点");
      c.toast(ck ? "已创建检查点" : "工作区与最近的检查点相同，无需重复创建");
      setLabel(""); refetch();
    } catch (e) { c.toast(String(e), true); } finally { setBusy(false); }
  };
  const revert = (ch: Change) => setConfirm({
    title: `撤销「${ch.path.split("/").pop()}」的改动？`,
    body: ch.status === "A" ? "这个文件是检查点之后新增的，将被删除。" : "文件内容会恢复到检查点时的状态。",
    label: "撤销",
    ok: async () => { try { await ai.revertFile(path(), sel()!.tree, ch.path); c.toast("已撤销"); refetchChanges(); } catch (e) { c.toast(String(e), true); } },
  });
  const restoreAll = () => setConfirm({
    title: "把整个工作区恢复到这个检查点？",
    body: `会撤销 ${changes()?.length ?? 0} 个文件的改动。恢复前会自动把当前状态另存为一个新检查点，所以随时可以反悔。分支、提交和暂存区都不受影响。`,
    label: "恢复",
    ok: async () => { setBusy(true); try { const n = await ai.restore(path(), sel()!.tree); c.toast(`已恢复 ${n} 个文件`); refetch(); refetchChanges(); } catch (e) { c.toast(String(e), true); } finally { setBusy(false); } },
  });
  const ST: Record<string, [string, string]> = { A: ["新增", "A"], M: ["修改", "M"], D: ["删除", "D"] };

  return (
    <Show when={!list.error} fallback={<div class="hero-card center"><div class="mesh" /><Icon name="shield" size={30} /><h2>检查点需要 Git 仓库</h2><p class="muted">先在「源代码管理」里初始化仓库。检查点不会产生任何提交，也不会改动分支。</p></div>}>
      <div class="split ckw">
        <div class="card slist">
          <form class="newbranch" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input placeholder="检查点说明（可选）" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
            <button class="btn sm primary" type="submit" disabled={busy()}><Icon name="plus" size={13} />创建</button>
          </form>
          <label class="check auto-ck"><input type="checkbox" checked={auto()} onChange={(e) => { setAuto(e.currentTarget.checked); prefs.set("autoCheckpoint", e.currentTarget.checked ? "1" : "0"); }} />从 Forge 启动 Claude 前自动创建</label>
          <div class="slist-body">
            <Show when={!list.loading || list()} fallback={<For each={[1, 2, 3]}>{() => <div class="sk" style={{ height: "56px", margin: "6px" }} />}</For>}>
              <For each={list()} fallback={<div class="empty pad"><Icon name="shield" size={24} />还没有检查点</div>}>
                {(k) => (
                  <button class="srow ck" classList={{ on: sel()?.id === k.id }} onClick={() => setSel(k)}>
                    <div class="st">{k.label}</div>
                    <div class="sm">
                      <span>{ago(k.time)}</span>
                      <Show when={k.files} fallback={<span class="ok-t">与当前一致</span>}>
                        <span>{k.files} 个文件</span><span class="add">+{k.added}</span><span class="del">−{k.removed}</span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="card sview">
          <Show when={sel()} fallback={<div class="empty"><div><Icon name="shield" size={30} /><p>检查点会在 Claude 动手之前给工作区拍快照</p><p class="muted">之后可以逐个文件审查和撤销 Claude 的改动</p></div></div>}>
            <div class="sview-head">
              <div style={{ "min-width": 0 }}>
                <div class="svt">自「{sel()!.label}」以来的改动</div>
                <div class="sm"><span>{new Date(sel()!.time).toLocaleString("zh-CN")}</span><span class="mono muted">{sel()!.commit.slice(0, 8)}</span></div>
              </div>
              <div class="row-gap">
                <button class="btn sm" onClick={() => setConfirm({ title: "删除这个检查点？", body: "只删除快照本身，不影响任何文件。", label: "删除", ok: async () => { await ai.deleteCheckpoint(path(), sel()!.id); setSel(null); refetch(); } })}>删除</button>
                <button class="btn sm danger" disabled={busy() || !changes()?.length} onClick={restoreAll}><Icon name="history" size={13} />全部恢复到此</button>
              </div>
            </div>
            <div class="review">
              <div class="review-files">
                <Show when={!changes.loading || changes()} fallback={<div class="sk" style={{ height: "120px", margin: "10px" }} />}>
                  <For each={changes()} fallback={<div class="empty pad"><Icon name="check" size={22} />没有改动</div>}>
                    {(ch) => (
                      <div class="frow" classList={{ on: file() === ch.path }} onClick={() => setFile(ch.path)} title={ch.path}>
                        <span class={`fl fl-${ST[ch.status]?.[1] ?? "M"}`}>{ch.status}</span>
                        <span class="fname">{ch.path.split("/").pop()}</span>
                        <span class="fdir">{ch.path.split("/").slice(0, -1).join("/")}</span>
                        <Show when={ch.added !== null}><span class="nstat"><b class="add">+{ch.added}</b><b class="del">−{ch.removed}</b></span></Show>
                        <span class="facts" onClick={(e) => e.stopPropagation()}>
                          <button class="icon-btn" title="撤销此文件" onClick={() => revert(ch)}><Icon name="history" size={14} /></button>
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
              <div class="diff-body">
                <Show when={file()} fallback={<div class="empty pad">选择文件查看改动</div>}>
                  <Show when={!diff.loading} fallback={<div class="sk" style={{ height: "140px", margin: "12px" }} />}>
                    <DiffText raw={diff() ?? ""} />
                  </Show>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <Show when={confirm()}>{(k) => <ConfirmDialog c={{ title: k().title, body: k().body, danger: true, okLabel: k().label, ok: k().ok }} close={() => setConfirm(null)} />}</Show>
    </Show>
  );
}

// ================================================================ 上下文打包
type Node = { name: string; path: string; dir: boolean; children: Node[]; files: FileInfo[] };

function buildTree(files: FileInfo[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let c = n.children.find((x) => x.path === p);
      if (!c) { c = { name: parts[i], path: p, dir: true, children: [], files: [] }; n.children.push(c); }
      n = c;
    }
    n.files.push(f);
  }
  const sort = (n: Node) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sort); };
  sort(root);
  return root;
}

function Packer(c: Ctx & { project: Project }) {
  const [files] = createResource(() => c.project.path, ai.files);
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  const [open, setOpen] = createSignal<Set<string>>(new Set([""]));
  const [q, setQ] = createSignal("");
  const [format, setFormat] = createSignal<"markdown" | "xml">((prefs.get("packFormat", "markdown") as "markdown" | "xml"));
  const [tree, setTree] = createSignal(prefs.bool("packTree", true));
  const [busy, setBusy] = createSignal(false);
  createEffect(on(() => c.project.path, () => setPicked(new Set<string>())));

  const visible = createMemo(() => {
    const s = q().trim().toLowerCase();
    return (files() ?? []).filter((f) => !f.binary && (!s || f.path.toLowerCase().includes(s)));
  });
  const root = createMemo(() => buildTree(visible()));
  const all = (n: Node): FileInfo[] => [...n.files, ...n.children.flatMap(all)];
  const tokens = createMemo(() => (files() ?? []).filter((f) => picked().has(f.path)).reduce((a, f) => a + f.tokens, 0));
  const BUDGET = 200_000;
  const toggle = (paths: string[], on: boolean) => setPicked((s) => { const n = new Set(s); paths.forEach((p) => (on ? n.add(p) : n.delete(p))); return n; });
  const state = (n: Node) => { const fs = all(n); const k = fs.filter((f) => picked().has(f.path)).length; return k === 0 ? 0 : k === fs.length ? 2 : 1; };

  const run = async (mode: "copy" | "save") => {
    const list = [...picked()].sort();
    if (!list.length) return;
    setBusy(true);
    try {
      const r = await ai.pack(c.project.path, list, format(), tree());
      if (mode === "copy") { await navigator.clipboard.writeText(r.text); c.toast(`已复制 ${r.files} 个文件 · 约 ${compact(r.tokens)} tokens`); }
      else { const p = await ai.saveDownloads(`${c.project.name}-context.${format() === "xml" ? "xml" : "md"}`, r.text); c.toast(`已保存到 ${p}`); }
      if (r.skipped.length) c.toast(`跳过了 ${r.skipped.length} 个文件：${r.skipped.slice(0, 3).join("、")}`, true);
    } catch (e) { c.toast(String(e), true); } finally { setBusy(false); }
  };

  const Dir = (p: { n: Node; depth: number }) => {
    const isOpen = () => open().has(p.n.path) || !!q().trim();
    const st = () => state(p.n);
    return (
      <>
        <Show when={p.n.path}>
          <div class="trow" style={{ "padding-left": `${p.depth * 14 + 6}px` }}>
            <button class="caret" classList={{ open: isOpen() }} onClick={() => setOpen((s) => { const n = new Set(s); n.has(p.n.path) ? n.delete(p.n.path) : n.add(p.n.path); return n; })}>›</button>
            <input type="checkbox" checked={st() === 2} ref={(el) => createEffect(() => (el.indeterminate = st() === 1))} onChange={(e) => toggle(all(p.n).map((f) => f.path), e.currentTarget.checked)} />
            <Icon name="folder" size={14} />
            <span class="tname-d">{p.n.name}</span>
            <span class="ttok">{compact(all(p.n).reduce((a, f) => a + f.tokens, 0))}</span>
          </div>
        </Show>
        <Show when={isOpen()}>
          <For each={p.n.children}>{(ch) => <Dir n={ch} depth={p.n.path ? p.depth + 1 : 0} />}</For>
          <For each={p.n.files}>
            {(f) => (
              <label class="trow file" style={{ "padding-left": `${(p.n.path ? p.depth + 1 : 0) * 14 + 26}px` }}>
                <input type="checkbox" checked={picked().has(f.path)} onChange={(e) => toggle([f.path], e.currentTarget.checked)} />
                <Icon name="file" size={13} />
                <span>{f.path.split("/").pop()}</span>
                <span class="ttok">{compact(f.tokens)}</span>
              </label>
            )}
          </For>
        </Show>
      </>
    );
  };

  return (
    <div class="split pack">
      <div class="card slist">
        <div class="slist-head">
          <label class="filter grow1"><Icon name="search" size={13} /><input placeholder="筛选文件" value={q()} onInput={(e) => setQ(e.currentTarget.value)} /></label>
          <button class="btn sm" onClick={() => toggle(visible().map((f) => f.path), true)}>全选</button>
          <button class="btn sm" onClick={() => setPicked(new Set<string>())}>清空</button>
        </div>
        <div class="slist-body tree">
          <Show when={!files.loading} fallback={<For each={[1, 2, 3, 4, 5]}>{() => <div class="sk" style={{ height: "22px", margin: "6px" }} />}</For>}>
            <Dir n={root()} depth={0} />
          </Show>
        </div>
        <div class="muted tree-foot">遵守 .gitignore 与 .claudeignore · 已排除二进制文件</div>
      </div>
      <div class="pack-side">
        <div class="card">
          <h3><Icon name="box" size={15} />已选内容</h3>
          <div class="big-num"><span class="gt">{compact(tokens())}</span><small> tokens（估算）</small></div>
          <div class="track budget"><i classList={{ over: tokens() > BUDGET }} style={{ width: `${Math.min(100, (tokens() / BUDGET) * 100)}%` }} /></div>
          <div class="muted" style={{ "font-size": "12px", "margin-top": "6px" }}>{picked().size} 个文件 · 占 200K 上下文的 {((tokens() / BUDGET) * 100).toFixed(1)}%</div>
          <Show when={tokens() > BUDGET}><div class="findings"><div class="ft">超出 200K，Claude 一次读不完，建议减少文件</div></div></Show>
          <label class="lbl">格式</label>
          <div class="seg big">
            <button classList={{ on: format() === "markdown" }} onClick={() => { setFormat("markdown"); prefs.set("packFormat", "markdown"); }}>Markdown</button>
            <button classList={{ on: format() === "xml" }} onClick={() => { setFormat("xml"); prefs.set("packFormat", "xml"); }}>XML</button>
          </div>
          <label class="check" style={{ margin: "12px 0" }}><input type="checkbox" checked={tree()} onChange={(e) => { setTree(e.currentTarget.checked); prefs.set("packTree", e.currentTarget.checked ? "1" : "0"); }} />开头附带目录树</label>
          <div class="row-gap">
            <button class="btn primary" disabled={!picked().size || busy()} onClick={() => run("copy")}><Icon name="copy" size={14} />复制到剪贴板</button>
            <button class="btn" disabled={!picked().size || busy()} onClick={() => run("save")}><Icon name="upload" size={14} />保存到下载</button>
          </div>
        </div>
        <div class="card hint-card">
          <h3><Icon name="spark" size={15} />什么时候用</h3>
          <p class="muted">把代码交给 claude.ai 网页版、其他 AI 或同事审阅时，一次性带上完整上下文。在 Claude Code 里不需要打包——它会自己读文件。</p>
        </div>
      </div>
    </div>
  );
}

// ================================================================ 项目地图
function MapTab(c: Ctx & { project: Project }) {
  const [map, { refetch }] = createResource(() => c.project.path, ai.projectMap);
  const [summary, setSummary] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  createEffect(on(() => c.project.path, () => setSummary("")));
  const full = () => {
    const m = map()?.markdown ?? "";
    return summary() ? m.replace("<!-- forge:map:end -->", `\n### 模块说明\n\n${summary().trim()}\n<!-- forge:map:end -->`) : m;
  };
  const gen = async () => {
    setBusy("ai");
    try {
      setSummary(await ai.ask(c.project.path, "下面是一个项目的目录结构和关键文件。请为每个主要目录（最多 12 个）写一行中文说明，格式为「- `目录/`：作用」，只描述能从材料中确定的内容，不要猜测。只输出列表。", map()!.context));
    } catch (e) { c.toast(String(e), true); } finally { setBusy(null); }
  };
  const write = async () => {
    setBusy("write");
    const pp = c.project.path, id = c.project.id;
    try {
      const target = (await claude.memFiles(pp, id)).find((f) => f.scope === "project");
      if (!target) throw new Error("找不到项目 CLAUDE.md 的位置");
      const cur = await claude.memRead(target.path, pp, id);
      const re = /<!-- forge:map:start -->[\s\S]*?<!-- forge:map:end -->\n?/;
      const next = re.test(cur) ? cur.replace(re, full()) : (cur.trimEnd() ? cur.trimEnd() + "\n\n" : "") + full();
      await claude.memWrite(target.path, next, pp, id);
      c.toast(re.test(cur) ? "已更新 CLAUDE.md 中的项目地图" : "已写入 CLAUDE.md");
    } catch (e) { c.toast(String(e), true); } finally { setBusy(null); }
  };
  return (
    <div class="split mapw">
      <div class="card editor">
        <div class="ed-head">
          <Icon name="layers" size={15} /><b>CLAUDE.md 预览</b>
          <div class="row-gap" style={{ "margin-left": "auto" }}>
            <button class="btn sm" onClick={() => refetch()}><Icon name="refresh" size={13} />重新扫描</button>
            <button class="btn sm" onClick={() => { navigator.clipboard.writeText(full()); c.toast("已复制"); }}><Icon name="copy" size={13} />复制</button>
            <button class="btn sm primary" disabled={!map() || !!busy()} onClick={write}><Icon name="file" size={13} />{busy() === "write" ? "写入中…" : "写入 CLAUDE.md"}</button>
          </div>
        </div>
        <Show when={!map.loading} fallback={<div class="sk" style={{ height: "260px", margin: "16px" }} />}>
          <pre class="map-pre">{full()}</pre>
        </Show>
      </div>
      <div class="pack-side">
        <div class="card" style={hueVars(1)}>
          <h3><Icon name="spark" size={15} />AI 模块说明</h3>
          <p class="muted" style={{ "font-size": "12.5px" }}>让 Claude 根据目录结构、README 和配置文件，为每个主要目录写一句说明。调用本机的 <code>claude -p</code>，会消耗少量用量。</p>
          <button class="btn primary" style={{ "margin-top": "12px" }} disabled={!map() || !!busy()} onClick={gen}>
            <Icon name="wand" size={14} />{busy() === "ai" ? "Claude 正在阅读…" : summary() ? "重新生成" : "生成模块说明"}
          </button>
          <Show when={busy() === "ai"}><div class="ai-shimmer" /></Show>
        </div>
        <div class="card hint-card">
          <h3><Icon name="file" size={15} />为什么要写进 CLAUDE.md</h3>
          <p class="muted">Claude 每次会话都会读取 CLAUDE.md。有了项目地图，它不必每次重新探索目录，回答更快、更省 tokens。再次写入时只替换 <code>forge:map</code> 标记之间的内容，你手写的部分不受影响。</p>
        </div>
      </div>
    </div>
  );
}

// ================================================================ 通知
function NotifyTab(c: Ctx) {
  const [bell, setBell] = createSignal(prefs.bool("notifyBell", true));
  const [idle, setIdle] = createSignal(prefs.bool("notifyIdle", true));
  const [secs, setSecs] = createSignal(+prefs.get("idleSecs", "8"));
  const sw = (k: string, set: (v: boolean) => void) => (e: Event & { currentTarget: HTMLInputElement }) => { set(e.currentTarget.checked); prefs.set(k, e.currentTarget.checked ? "1" : "0"); };
  return (
    <div class="grid notify-grid">
      <div class="card" style={hueVars(0)}>
        <h3><span class="ib sm"><Icon name="bell" size={13} /></span>终端响铃时通知</h3>
        <p class="muted">Claude Code 可以在完成任务或等待你确认时让终端响铃。Forge 的内置终端检测到响铃后，会弹出 Windows 通知。</p>
        <label class="switch"><input type="checkbox" checked={bell()} onChange={sw("notifyBell", setBell)} /><i /><span>{bell() ? "已开启" : "已关闭"}</span></label>
        <div class="sub-h">让 Claude Code 在完成时响铃</div>
        <p class="muted">在 Claude Code 里输入 <code>/config</code>，把通知方式（Notifications）设为 terminal bell；较早的版本也可以在终端运行：</p>
        <pre class="cmd-pre">claude config set --global preferredNotifChannel terminal_bell</pre>
        <button class="btn sm" onClick={() => { navigator.clipboard.writeText("claude config set --global preferredNotifChannel terminal_bell"); c.toast("已复制命令"); }}><Icon name="copy" size={13} />复制命令</button>
      </div>
      <div class="card" style={hueVars(2)}>
        <h3><span class="ib sm"><Icon name="history" size={13} /></span>输出停止时通知</h3>
        <p class="muted">不需要任何配置：Claude 工作时终端会持续刷新，连续输出一段时间后突然安静下来，通常意味着它已完成或在等你确认。</p>
        <label class="switch"><input type="checkbox" checked={idle()} onChange={sw("notifyIdle", setIdle)} /><i /><span>{idle() ? "已开启" : "已关闭"}</span></label>
        <label class="lbl">安静多久后通知：{secs()} 秒</label>
        <input type="range" min="4" max="30" value={secs()} class="range" onInput={(e) => { setSecs(+e.currentTarget.value); prefs.set("idleSecs", e.currentTarget.value); }} />
      </div>
      <div class="card" style={hueVars(4)}>
        <h3><span class="ib sm"><Icon name="spark" size={13} /></span>试一下</h3>
        <p class="muted">只有当 Forge 不在前台、或者你正在看别的页面 / 标签时才会通知，避免打扰。对应的终端标签会亮起提示点。</p>
        <button class="btn primary" onClick={() => notify("Forge", "这是一条测试通知 ✨").then(() => c.toast("已发送测试通知"), (e) => c.toast(String(e), true))}><Icon name="bell" size={14} />发送测试通知</button>
      </div>
    </div>
  );
}

// ================================================================ 页面
export function AiToolsView(p: Ctx) {
  const [tab, setTab] = createSignal<Tab>((prefs.get("tab", "checkpoints") as Tab));
  const pick = (t: Tab) => { setTab(t); prefs.set("tab", t); };
  return (
    <div class="page wide">
      <div class="gbar">
        <div class="seg"><For each={TABS}>{(t) => <button classList={{ on: tab() === t.id }} onClick={() => pick(t.id)}><Icon name={t.icon} size={14} />{t.label}</button>}</For></div>
        <Show when={p.project}><span class="chip"><Icon name="folder" size={13} />{p.project!.name}</span></Show>
      </div>
      <div class="cc-body">
        <Show when={p.project || tab() === "notify"} fallback={<div class="empty">请先在左侧选择一个项目</div>}>
          <Switch>
            <Match when={tab() === "checkpoints"}><Checkpoints project={p.project!} toast={p.toast} /></Match>
            <Match when={tab() === "pack"}><Packer project={p.project!} toast={p.toast} /></Match>
            <Match when={tab() === "map"}><MapTab project={p.project!} toast={p.toast} /></Match>
            <Match when={tab() === "notify"}><div class="scroll"><NotifyTab {...p} /></div></Match>
          </Switch>
        </Show>
      </div>
    </div>
  );
}
