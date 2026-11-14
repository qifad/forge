import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { ago, type Project } from "./api";
import { git, layoutGraph, openUrl, parseDiff, type Branch, type FileEntry, type Finding, type Hunk } from "./gitapi";
import { ai } from "./aiapi";
import { Icon } from "./icons";
import { HUES } from "./views";

type Tab = "changes" | "history" | "branches";
type Sel = { path: string; staged: boolean } | null;
type Confirm = { title: string; body: string; danger?: boolean; okLabel: string; ok: () => void } | null;

export function ConfirmDialog(p: { c: NonNullable<Confirm>; close: () => void }) {
  onMount(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.close();
    window.addEventListener("keydown", k);
    onCleanup(() => window.removeEventListener("keydown", k));
  });
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.close()}>
      <div class="dialog">
        <h3>{p.c.title}</h3>
        <p>{p.c.body}</p>
        <div class="dialog-actions">
          <button class="btn" onClick={p.close}>取消</button>
          <button class="btn" classList={{ danger: p.c.danger, primary: !p.c.danger }} onClick={() => { p.close(); p.c.ok(); }}>{p.c.okLabel}</button>
        </div>
      </div>
    </div>
  );
}

function PrDialog(p: { repo: string; close: () => void; toast: (m: string, e?: boolean) => void }) {
  const [info] = createResource(() => p.repo, ai.prInfo);
  const [base, setBase] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [draft, setDraft] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [done, setDone] = createSignal<string | null>(null);
  createEffect(on(info, (i) => { if (i && !base()) setBase(i.base); }));
  const write = async () => {
    setBusy("ai");
    try {
      const t = await ai.prDescription(p.repo, base());
      const [first, ...rest] = t.split("\n");
      setTitle(first.replace(/^#+\s*/, "").trim());
      setBody(rest.join("\n").trim());
    } catch (e) { p.toast(String(e), true); } finally { setBusy(null); }
  };
  const create = async () => {
    setBusy("create");
    try { setDone(await ai.createPr(p.repo, title(), body(), base(), draft())); p.toast("PR 已创建"); }
    catch (e) { p.toast(String(e), true); } finally { setBusy(null); }
  };
  onMount(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy() && p.close();
    window.addEventListener("keydown", k);
    onCleanup(() => window.removeEventListener("keydown", k));
  });
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy() && p.close()}>
      <div class="dialog pr-dialog">
        <Show when={!info.error} fallback={<><h3>无法创建 PR</h3><p>{String(info.error)}</p><div class="dialog-actions"><button class="btn" onClick={p.close}>关闭</button></div></>}>
          <Show when={!done()} fallback={
            <div class="success">
              <div class="burst"><Icon name="check" size={28} stroke={2.4} /></div>
              <h2>Pull Request 已创建</h2>
              <p class="mono muted">{done()!.replace("https://github.com/", "")}</p>
              <div class="row-gap"><button class="btn primary" onClick={() => openUrl(done()!)}><Icon name="globe" size={15} />在浏览器中打开</button><button class="btn" onClick={p.close}>关闭</button></div>
            </div>
          }>
            <h3><Icon name="github" size={16} /> 创建 Pull Request</h3>
            <Show when={info()} fallback={<div class="sk" style={{ height: "160px" }} />}>
              <div class="pr-route">
                <span class="chip"><Icon name="branch" size={13} />{info()!.branch}</span>
                <span class="muted">→</span>
                <input class="field base-in" value={base()} onInput={(e) => setBase(e.currentTarget.value)} />
                <span class="muted mono" style={{ "margin-left": "auto" }}>{info()!.owner}/{info()!.repo}</span>
              </div>
              <Show when={info()!.existing}>
                <div class="findings warn"><div class="ft">这个分支已经有一个打开的 PR</div><button class="link" onClick={() => openUrl(info()!.existing!)}>{info()!.existing}</button></div>
              </Show>
              <div class="row-gap" style={{ "margin-top": "12px" }}>
                <input class="field" style={{ flex: 1 }} placeholder="标题" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
                <button class="btn ai-btn" classList={{ loading: busy() === "ai" }} disabled={!!busy()} onClick={write}><Icon name="wand" size={14} />{busy() === "ai" ? "撰写中…" : "AI 撰写"}</button>
              </div>
              <textarea class="field pr-body" placeholder="描述（支持 Markdown）" value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
              <div class="dialog-actions" style={{ "align-items": "center" }}>
                <label class="check" style={{ "margin-right": "auto" }}><input type="checkbox" checked={draft()} onChange={(e) => setDraft(e.currentTarget.checked)} />草稿 PR</label>
                <button class="btn" disabled={!!busy()} onClick={p.close}>取消</button>
                <button class="btn primary" disabled={!!busy() || !title().trim() || !base().trim()} onClick={create}>
                  <Icon name="upload" size={14} />{busy() === "create" ? "推送并创建中…" : "推送并创建"}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { M: "修改", A: "新增", D: "删除", R: "重命名", C: "复制", U: "冲突", "?": "未跟踪", T: "类型" };

function letter(f: FileEntry, staged: boolean) {
  if (f.kind === "untracked") return "U";
  if (f.kind === "conflict") return "!";
  const c = staged ? f.x : f.y;
  return c === "?" ? "U" : c;
}

function FileRow(p: { f: FileEntry; staged: boolean; selected: boolean; onSelect: () => void; onToggle: () => void; onDiscard?: () => void }) {
  const name = () => p.f.path.split("/").pop()!;
  const dir = () => p.f.path.split("/").slice(0, -1).join("/");
  const l = () => letter(p.f, p.staged);
  return (
    <div class="frow" classList={{ on: p.selected }} onClick={p.onSelect} title={p.f.origPath ? `${p.f.origPath} → ${p.f.path}` : p.f.path}>
      <span class={`fl fl-${l() === "!" ? "C" : l()}`} title={STATUS_LABEL[p.staged ? p.f.x : p.f.y] ?? ""}>{l()}</span>
      <span class="fname">{name()}</span>
      <span class="fdir">{dir()}</span>
      <span class="facts" onClick={(e) => e.stopPropagation()}>
        <Show when={p.onDiscard}>
          <button class="icon-btn" title="丢弃更改" onClick={p.onDiscard}><Icon name="history" size={14} /></button>
        </Show>
        <button class="icon-btn" title={p.staged ? "取消暂存" : "暂存"} onClick={p.onToggle}>
          <Icon name={p.staged ? "min" : "plus"} size={14} />
        </button>
      </span>
    </div>
  );
}

function DiffView(p: { repo: string; sel: NonNullable<Sel>; file?: FileEntry; onHunk: (h: Hunk, header: string) => void; onStageFile: () => void }) {
  const untracked = () => p.file?.kind === "untracked";
  const [raw] = createResource(() => ({ ...p.sel, u: untracked(), k: JSON.stringify(p.file) }), (s) => git.diff(p.repo, s.path, s.staged, s.u));
  const parsed = createMemo(() => (raw() !== undefined ? parseDiff(raw()!) : null));
  const stats = createMemo(() => {
    let add = 0, del = 0;
    for (const h of parsed()?.hunks ?? []) for (const l of h.lines) l.t === "+" ? add++ : l.t === "-" ? del++ : 0;
    return { add, del };
  });
  return (
    <div class="diff">
      <div class="diff-head">
        <Icon name="file" size={15} />
        <span class="mono">{p.sel.path}</span>
        <span class="chip">{p.sel.staged ? "已暂存" : untracked() ? "新文件" : "工作区"}</span>
        <span class="dstat"><b class="add">+{stats().add}</b> <b class="del">−{stats().del}</b></span>
        <Show when={untracked()}>
          <button class="btn sm" onClick={p.onStageFile}><Icon name="plus" size={13} />暂存整个文件</button>
        </Show>
      </div>
      <div class="diff-body">
        <Show when={!raw.loading} fallback={<div class="sk" style={{ height: "160px", margin: "16px" }} />}>
          <Show when={!raw.error} fallback={<div class="empty pad">{String(raw.error)}</div>}>
            <Switch>
              <Match when={parsed()?.binary}><div class="empty pad"><Icon name="box" size={26} />二进制文件，无法显示差异</div></Match>
              <Match when={!parsed()?.hunks.length}><div class="empty pad">没有差异</div></Match>
              <Match when={true}>
                <For each={parsed()!.hunks}>
                  {(h) => (
                    <div class="hunk">
                      <div class="hunk-head">
                        <span class="mono">{h.header}</span>
                        <Show when={!untracked()}>
                          <button class="btn sm" onClick={() => p.onHunk(h, parsed()!.header)}>
                            <Icon name={p.sel.staged ? "min" : "plus"} size={13} />{p.sel.staged ? "取消暂存此块" : "暂存此块"}
                          </button>
                        </Show>
                      </div>
                      <For each={h.lines.slice(0, 4000)}>
                        {(l) => (
                          <div class={`dl dl-${l.t === "+" ? "add" : l.t === "-" ? "del" : l.t === "\\" ? "meta" : "ctx"}`}>
                            <span class="ln">{l.a ?? ""}</span>
                            <span class="ln">{l.b ?? ""}</span>
                            <span class="sg">{l.t === " " ? "" : l.t}</span>
                            <span class="code">{l.text}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Match>
            </Switch>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function Graph(p: { repo: string }) {
  const [log] = createResource(() => p.repo, (r) => git.log(r, 300));
  const rows = createMemo(() => layoutGraph(log() ?? []));
  const W = 14, H = 34, M = H / 2;
  const x = (i: number) => 9 + i * W;
  const color = (i: number) => HUES[i % HUES.length][0];
  const curve = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  const refClass = (r: string) => (r.startsWith("HEAD") ? "ref head" : r.startsWith("tag: ") ? "ref tag" : r.includes("/") && !r.startsWith("feature") ? "ref remote" : "ref");
  return (
    <div class="card graph">
      <Show when={!log.loading} fallback={<For each={[1, 2, 3, 4, 5, 6]}>{() => <div class="sk" style={{ height: "22px", margin: "10px 0" }} />}</For>}>
        <Show when={rows().length} fallback={<div class="empty pad">还没有任何提交</div>}>
          <For each={rows()}>
            {(r, i) => (
              <div class="grow" style={{ "animation-delay": `${Math.min(i(), 20) * 18}ms` }}>
                <svg width={x(r.width) } height={H} class="gsvg">
                  <For each={r.before}>
                    {(h, k) => (h ? <path d={h === r.commit.hash ? curve(x(k()), 0, x(r.col), M) : `M${x(k())} 0V${M}`} stroke={color(h === r.commit.hash ? r.col : k())} /> : null)}
                  </For>
                  <For each={r.after}>
                    {(h, k) => (h && !r.outs.includes(k()) ? <path d={`M${x(k())} ${M}V${H}`} stroke={color(k())} /> : null)}
                  </For>
                  <For each={r.outs}>{(k) => <path d={curve(x(r.col), M, x(k), H)} stroke={color(k)} />}</For>
                  <circle cx={x(r.col)} cy={M} r={r.commit.parents.length > 1 ? 3.5 : 4.5} fill={r.commit.parents.length > 1 ? "var(--bg)" : color(r.col)} stroke={color(r.col)} stroke-width="2" />
                </svg>
                <div class="gmain">
                  <For each={r.commit.refs}>{(ref) => <span class={refClass(ref)}>{ref.replace("HEAD -> ", "").replace("tag: ", "")}</span>}</For>
                  <span class="gsub">{r.commit.subject}</span>
                </div>
                <span class="gauth">{r.commit.author}</span>
                <span class="gtime">{ago(r.commit.time * 1000)}</span>
                <span class="ghash mono">{r.commit.hash.slice(0, 7)}</span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function Branches(p: { repo: string; onChanged: () => void; toast: (m: string, e?: boolean) => void }) {
  const [list, { refetch }] = createResource(() => p.repo, git.branches);
  const [name, setName] = createSignal("");
  const local = () => (list() ?? []).filter((b) => !b.remote);
  const remote = () => (list() ?? []).filter((b) => !b.remote ? false : !local().some((l) => l.upstream === b.name));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); p.toast(ok); refetch(); p.onChanged(); } catch (e) { p.toast(String(e), true); }
  };
  const create = () => { const n = name().trim(); if (n) run(() => git.createBranch(p.repo, n, true), `已创建并切换到 ${n}`).then(() => setName("")); };
  const Row = (b: Branch) => (
    <div class="brow" classList={{ on: b.current }}>
      <Icon name={b.remote ? "github" : "branch"} size={15} />
      <div class="bmeta">
        <div class="bname">{b.name}<Show when={b.current}><span class="tag accent">当前</span></Show></div>
        <div class="bsub">{b.subject} · {ago(b.updated * 1000)}</div>
      </div>
      <Show when={b.track}><span class="chip">{b.track.replace("ahead", "↑").replace("behind", "↓")}</span></Show>
      <Show when={!b.current}>
        <button class="btn sm" onClick={() => run(() => git.checkout(p.repo, b.remote ? b.name.split("/").slice(1).join("/") : b.name), `已切换到 ${b.name}`)}>
          {b.remote ? "检出" : "切换"}
        </button>
      </Show>
    </div>
  );
  return (
    <div class="grid two-even">
      <div class="card">
        <h3><Icon name="branch" size={15} />本地分支<span class="r">{local().length}</span></h3>
        <form class="newbranch" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input placeholder="新分支名，例如 feature/login" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <button class="btn sm primary" type="submit" disabled={!name().trim()}><Icon name="plus" size={13} />创建并切换</button>
        </form>
        <For each={local()}>{Row}</For>
      </div>
      <div class="card" style={{ "animation-delay": "60ms" }}>
        <h3><Icon name="github" size={15} />远程分支<span class="r">{remote().length}</span></h3>
        <For each={remote()} fallback={<div class="empty pad">没有其他远程分支</div>}>{Row}</For>
      </div>
    </div>
  );
}

export function GitView(p: { project: Project; toast: (m: string, e?: boolean) => void; goPublish: () => void }) {
  const repo = () => p.project.path;
  const [tab, setTab] = createSignal<Tab>("changes");
  const [status, { refetch }] = createResource(repo, git.status);
  const [sel, setSel] = createSignal<Sel>(null);
  const [msg, setMsg] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [findings, setFindings] = createSignal<Finding[] | null>(null);
  const [confirm, setConfirm] = createSignal<Confirm>(null);
  const [graphKey, setGraphKey] = createSignal(0);
  const [prOpen, setPrOpen] = createSignal(false);
  const [aiBusy, setAiBusy] = createSignal(false);
  const aiMessage = async () => {
    setAiBusy(true);
    try { setMsg(await ai.commitMessage(repo())); } catch (e) { p.toast(String(e), true); } finally { setAiBusy(false); }
  };

  createEffect(on(repo, () => { setSel(null); setMsg(""); setFindings(null); }));
  const onFocus = () => refetch();
  onMount(() => window.addEventListener("focus", onFocus));
  onCleanup(() => window.removeEventListener("focus", onFocus));

  const files = () => status()?.files ?? [];
  const staged = () => files().filter((f) => f.staged);
  const unstaged = () => files().filter((f) => f.unstaged);
  const selFile = () => files().find((f) => f.path === sel()?.path);

  // 选中的文件不再处于该区时，自动切到另一侧或清空
  createEffect(() => {
    const s = sel();
    if (!s || status.loading) return;
    const f = selFile();
    if (!f) setSel(null);
    else if (s.staged && !f.staged) setSel({ path: s.path, staged: false });
    else if (!s.staged && !f.unstaged) setSel({ path: s.path, staged: true });
  });

  const act = async (label: string | null, fn: () => Promise<unknown>) => {
    try { await fn(); if (label) p.toast(label); } catch (e) { p.toast(String(e), true); }
    refetch();
  };
  const stage = (paths: string[]) => act(null, () => git.stage(repo(), paths));
  const unstage = (paths: string[]) => act(null, () => git.unstage(repo(), paths));
  const discard = (fs: FileEntry[]) => {
    const untracked = fs.filter((f) => f.kind === "untracked");
    setConfirm({
      title: fs.length === 1 ? `丢弃 ${fs[0].path.split("/").pop()} 的更改？` : `丢弃 ${fs.length} 个文件的更改？`,
      body: untracked.length ? `其中 ${untracked.length} 个未跟踪文件会被直接删除。此操作无法撤销。` : "工作区中的修改会恢复到暂存区或上次提交的状态。此操作无法撤销。",
      danger: true,
      okLabel: "丢弃",
      ok: () => act("已丢弃更改", () => git.discard(repo(), fs.filter((f) => f.kind !== "untracked").map((f) => f.path), untracked.map((f) => f.path))),
    });
  };
  const applyHunk = (h: Hunk, header: string) => {
    const s = sel();
    if (!s) return;
    act(s.staged ? "已取消暂存该块" : "已暂存该块", () => git.applyPatch(repo(), header + h.raw, s.staged));
  };

  const doCommit = async (force = false) => {
    if (!msg().trim() || (!staged().length && !amend())) return;
    setBusy("commit");
    try {
      if (!force) {
        const f = await git.scan(repo(), "staged");
        if (f.some((x) => x.level === "block")) { setFindings(f); return; }
      }
      const res = await git.commit(repo(), msg(), amend());
      p.toast(`已提交 ${res}`);
      setMsg(""); setAmend(false); setFindings(null); setGraphKey((k) => k + 1);
    } catch (e) { p.toast(String(e), true); } finally { setBusy(null); refetch(); }
  };
  createEffect(on(amend, async (a) => { if (a && !msg()) setMsg(await git.lastMessage(repo())); }, { defer: true }));

  const sync = async (action: "fetch" | "pull" | "push") => {
    setBusy(action);
    const label = { fetch: "已获取远程更新", pull: "已拉取最新提交", push: "已推送到远程" }[action];
    try { await git.sync(repo(), action); p.toast(label); setGraphKey((k) => k + 1); } catch (e) { p.toast(String(e), true); } finally { setBusy(null); refetch(); }
  };

  return (
    <div class="page wide">
      <Show when={!status.error} fallback={
        <div class="hero-card center">
          <div class="mesh" />
          <Icon name="git" size={34} />
          <h2>「{p.project.name}」还不是 Git 仓库</h2>
          <p class="muted">初始化后即可管理版本，或者直接一键发布到 GitHub。</p>
          <div class="row-gap">
            <button class="btn" onClick={() => act("已初始化仓库（main 分支）", () => git.init(repo()))}><Icon name="git" size={15} />初始化仓库</button>
            <button class="btn primary" onClick={p.goPublish}><Icon name="upload" size={15} />发布到 GitHub</button>
          </div>
        </div>
      }>
        <div class="gbar">
          <div class="seg">
            <button classList={{ on: tab() === "changes" }} onClick={() => setTab("changes")}>
              <Icon name="git" size={14} />变更<Show when={files().length}><span class="cnt">{files().length}</span></Show>
            </button>
            <button classList={{ on: tab() === "history" }} onClick={() => setTab("history")}><Icon name="history" size={14} />历史</button>
            <button classList={{ on: tab() === "branches" }} onClick={() => setTab("branches")}><Icon name="branch" size={14} />分支</button>
          </div>
          <span class="chip"><Icon name="branch" size={13} />{status()?.branch ?? "…"}
            <Show when={status()?.upstream}><span class="muted">→ {status()!.upstream}</span></Show>
          </span>
          <div class="gbar-r">
            <button class="btn sm" title="暂存全部改动（含未跟踪文件）到 stash" disabled={!files().length} onClick={() => act("已存入 stash", () => git.stash(repo(), false))}><Icon name="box" size={13} />暂存区</button>
            <Show when={status()?.stashCount}>
              <button class="btn sm" onClick={() => act("已恢复 stash", () => git.stash(repo(), true))}>恢复 <span class="cnt">{status()!.stashCount}</span></button>
            </Show>
            <button class="btn sm" onClick={() => setPrOpen(true)} title="把当前分支推送到 GitHub 并创建 Pull Request"><Icon name="github" size={13} />创建 PR</button>
            <button class="btn sm" classList={{ spin: busy() === "fetch" }} onClick={() => sync("fetch")} title="获取"><Icon name="refresh" size={13} /></button>
            <button class="btn sm" classList={{ spin: busy() === "pull" }} onClick={() => sync("pull")}><Icon name="arrowDown" size={13} />拉取<Show when={status()?.behind}><span class="cnt">{status()!.behind}</span></Show></button>
            <button class="btn sm primary" classList={{ spin: busy() === "push" }} onClick={() => sync("push")}><Icon name="arrowUp" size={13} />推送<Show when={status()?.ahead}><span class="cnt light">{status()!.ahead}</span></Show></button>
          </div>
        </div>

        <Switch>
          <Match when={tab() === "changes"}>
            <div class="changes">
              <div class="cleft">
                <div class="card commit-box">
                  <textarea
                    placeholder={`提交信息（Ctrl+Enter 提交到 ${status()?.branch ?? ""}）`}
                    value={msg()}
                    onInput={(e) => setMsg(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); doCommit(); } }}
                  />
                  <Show when={findings()}>
                    <div class="findings">
                      <div class="ft"><Icon name="shield" size={14} />提交前扫描发现 {findings()!.length} 个问题</div>
                      <For each={findings()!}>{(f) => <div class="fi"><span class="mono">{f.file}{f.line ? `:${f.line}` : ""}</span><span>{f.kind}</span></div>}</For>
                      <div class="row-gap">
                        <button class="btn sm" onClick={() => setFindings(null)}>返回修改</button>
                        <button class="btn sm danger" onClick={() => doCommit(true)}>仍要提交</button>
                      </div>
                    </div>
                  </Show>
                  <div class="commit-row">
                    <label class="check"><input type="checkbox" checked={amend()} onChange={(e) => setAmend(e.currentTarget.checked)} disabled={!status()?.hasCommits} />修改上次提交</label>
                    <button class="btn sm ai-btn" classList={{ loading: aiBusy() }} disabled={aiBusy() || !staged().length} onClick={aiMessage} title="根据暂存区改动生成提交信息（调用本机 claude -p）">
                      <Icon name="wand" size={13} />{aiBusy() ? "生成中…" : "AI 生成"}
                    </button>
                    <button class="btn primary" disabled={!msg().trim() || (!staged().length && !amend()) || busy() === "commit"} onClick={() => doCommit()}>
                      <Icon name="check" size={15} />{amend() ? "修改提交" : `提交 ${staged().length || ""}`}
                    </button>
                  </div>
                </div>

                <div class="card flist">
                  <Show when={!status.loading || status()} fallback={<For each={[1, 2, 3, 4]}>{() => <div class="sk" style={{ height: "26px", margin: "8px 0" }} />}</For>}>
                    <Show when={files().length} fallback={<div class="empty pad"><Icon name="check" size={26} />工作区很干净</div>}>
                      <Show when={staged().length}>
                        <div class="fsec">
                          <span>已暂存</span><span class="cnt">{staged().length}</span>
                          <button class="link" onClick={() => unstage(staged().map((f) => f.path))}>全部取消</button>
                        </div>
                        <For each={staged()}>
                          {(f) => <FileRow f={f} staged selected={sel()?.path === f.path && sel()!.staged} onSelect={() => setSel({ path: f.path, staged: true })} onToggle={() => unstage([f.path])} />}
                        </For>
                      </Show>
                      <Show when={unstaged().length}>
                        <div class="fsec">
                          <span>更改</span><span class="cnt">{unstaged().length}</span>
                          <button class="link" onClick={() => discard(unstaged())}>全部丢弃</button>
                          <button class="link" onClick={() => stage(unstaged().map((f) => f.path))}>全部暂存</button>
                        </div>
                        <For each={unstaged()}>
                          {(f) => <FileRow f={f} staged={false} selected={sel()?.path === f.path && !sel()!.staged} onSelect={() => setSel({ path: f.path, staged: false })} onToggle={() => stage([f.path])} onDiscard={() => discard([f])} />}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </div>
              </div>

              <div class="card cright">
                <Show when={sel()} fallback={<div class="empty"><div><Icon name="code" size={30} /><p>选择左侧文件查看差异</p><p class="muted">可以逐块暂存，只提交你想要的改动</p></div></div>}>
                  {(s) => <DiffView repo={repo()} sel={s()} file={selFile()} onHunk={applyHunk} onStageFile={() => stage([s().path])} />}
                </Show>
              </div>
            </div>
          </Match>
          <Match when={tab() === "history"}>
            <Show when={graphKey() + 1} keyed>{(_k: number) => <Graph repo={repo()} />}</Show>
          </Match>
          <Match when={tab() === "branches"}>
            <Branches repo={repo()} toast={p.toast} onChanged={() => { refetch(); setGraphKey((k) => k + 1); }} />
          </Match>
        </Switch>
      </Show>

      <Show when={confirm()}>{(c) => <ConfirmDialog c={c()} close={() => setConfirm(null)} />}</Show>
      <Show when={prOpen()}><PrDialog repo={repo()} toast={p.toast} close={() => { setPrOpen(false); refetch(); }} /></Show>
    </div>
  );
}
