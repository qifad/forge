import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ago, type Project } from "./api";
import { openUrl, type GhUser } from "./gitapi";
import { Icon } from "./icons";
import { ConfirmDialog } from "./git";
import { mbStr, onDownloadProgress, onReleaseStep, upd, updPrefs, type ReleaseInfo, type Step } from "./updateapi";
import { hueVars } from "./views";

type Toast = (m: string, e?: boolean) => void;

// ================================================================ 全局更新状态（标题栏提示也会用到）
const [checkState, setCheckState] = createSignal<{ busy: boolean; latest: ReleaseInfo | null; hasUpdate: boolean; current: string; error: string | null; at: number }>({
  busy: false, latest: null, hasUpdate: false, current: "", error: null, at: 0,
});
export const updateState = checkState;

const [repoSig, setRepoSig] = createSignal(updPrefs.get("repo", "").trim());
export const getRepo = repoSig;
const saveRepoGlobal = (v: string) => { setRepoSig(v); updPrefs.set("repo", v); };

export async function checkForUpdate(silent = false) {
  const repo = getRepo();
  if (!repo) {
    setCheckState((s) => ({ ...s, error: silent ? null : "还没有配置更新仓库" }));
    return;
  }
  setCheckState((s) => ({ ...s, busy: true, error: null }));
  try {
    const r = await upd.check(repo, updPrefs.get("pre", "0") === "1");
    setCheckState({ busy: false, latest: r.latest, hasUpdate: r.hasUpdate, current: r.current, error: null, at: Date.now() });
  } catch (e) {
    setCheckState((s) => ({ ...s, busy: false, error: silent ? null : String(e), at: Date.now() }));
  }
}

/** 启动时按设置检查一次（静默失败）。 */
export function startupCheck() {
  if (updPrefs.get("auto", "1") === "1" && getRepo()) setTimeout(() => checkForUpdate(true), 2500);
}

// ================================================================ 软件更新卡片
function UpdateCard(p: { toast: Toast }) {
  const [repo, setRepo] = createSignal(getRepo());
  createEffect(on(getRepo, (v) => setRepo(v), { defer: true }));
  const [auto, setAuto] = createSignal(updPrefs.get("auto", "1") === "1");
  const [pre, setPre] = createSignal(updPrefs.get("pre", "0") === "1");
  const [version] = createResource(upd.version);
  const [dl, setDl] = createSignal<{ downloaded: number; total: number } | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "download" | "install">("idle");
  let unlisten: (() => void) | undefined;
  onDownloadProgress((x) => setDl(x)).then((u) => (unlisten = u));
  onCleanup(() => unlisten?.());

  const saveRepo = () => {
    const v = repo().trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    setRepo(v);
    saveRepoGlobal(v);
    if (v) checkForUpdate();
  };
  const install = async () => {
    const st = checkState();
    if (!st.latest) return;
    setPhase("download");
    try {
      await upd.install(getRepo(), st.latest);
      setPhase("install");
      p.toast("正在安装更新，Forge 会自动重新启动");
      setTimeout(() => upd.quit(), 900);
    } catch (e) { setPhase("idle"); p.toast(String(e), true); }
  };
  const st = checkState;
  return (
    <div class="card set-card" style={hueVars(1)}>
      <h3><span class="ib sm"><Icon name="refresh" size={13} /></span>软件更新<span class="r chip">当前版本 {version() ?? "…"}</span></h3>
      <label class="lbl">更新仓库（GitHub owner/repo）</label>
      <div class="row-gap">
        <input class="field mono" style={{ flex: 1 }} placeholder="例如 yourname/forge-releases" value={repo()} onInput={(e) => setRepo(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && saveRepo()} />
        <button class="btn" onClick={saveRepo}>保存</button>
        <button class="btn primary" classList={{ spin: st().busy }} disabled={st().busy || !getRepo()} onClick={() => checkForUpdate()}><Icon name="refresh" size={14} />检查更新</button>
      </div>
      <div class="row-gap" style={{ margin: "12px 0 4px", gap: "18px" }}>
        <label class="switch"><input type="checkbox" checked={auto()} onChange={(e) => { setAuto(e.currentTarget.checked); updPrefs.set("auto", e.currentTarget.checked ? "1" : "0"); }} /><i /><span>启动时自动检查</span></label>
        <label class="switch"><input type="checkbox" checked={pre()} onChange={(e) => { setPre(e.currentTarget.checked); updPrefs.set("pre", e.currentTarget.checked ? "1" : "0"); }} /><i /><span>接收预发布版本</span></label>
      </div>

      <Show when={st().error}><div class="findings"><div class="ft">{st().error}</div></div></Show>
      <Show when={st().at && !st().error}>
        <Show when={st().hasUpdate && st().latest} fallback={
          <div class="up-ok"><Icon name="check" size={16} />已是最新版本<span class="muted">· {new Date(st().at).toLocaleTimeString("zh-CN")} 检查</span></div>
        }>
          <div class="up-new">
            <div class="up-head">
              <div class="up-badge"><Icon name="spark" size={16} /></div>
              <div style={{ flex: 1 }}>
                <div class="up-title">发现新版本 {st().latest!.version}</div>
                <div class="muted" style={{ "font-size": "12px" }}>{ago(Date.parse(st().latest!.publishedAt))} 发布 · 安装包 {mbStr(st().latest!.assetSize)}</div>
              </div>
              <Show when={phase() === "idle"}>
                <button class="btn primary" onClick={install}><Icon name="arrowDown" size={14} />下载并安装</button>
              </Show>
            </div>
            <Show when={st().latest!.notes}><pre class="up-notes">{st().latest!.notes}</pre></Show>
            <Show when={phase() !== "idle"}>
              <div class="track budget"><i style={{ width: `${dl() ? Math.min(100, (dl()!.downloaded / Math.max(1, dl()!.total)) * 100) : 2}%` }} /></div>
              <div class="muted" style={{ "font-size": "12px", "margin-top": "6px" }}>
                {phase() === "download" ? `正在下载 ${dl() ? `${mbStr(dl()!.downloaded)} / ${mbStr(dl()!.total)}` : "…"}` : "下载完成，正在后台安装，完成后自动重新启动…"}
              </div>
            </Show>
          </div>
        </Show>
      </Show>
      <p class="muted hint-line">更新时会在后台静默运行安装包：与手动双击安装包相同的「检测到已安装 → 原位更新」流程，只是没有界面，装完自动重启，设置和数据都会保留。</p>
    </div>
  );
}

// ================================================================ 发布卡片（开发者）
const STEPS = [
  { id: "check", label: "检查仓库与现有版本" },
  { id: "prune", label: "检查容量，必要时删除最旧的版本" },
  { id: "create", label: "创建 Release" },
  { id: "upload", label: "上传安装包" },
];

function PublishCard(p: { toast: Toast; user: GhUser | null | undefined; project?: Project; goGitHub: () => void }) {
  const repo = () => getRepo();
  const [limit, setLimit] = createSignal(+updPrefs.get("limitMb", "1024"));
  const [list, { refetch }] = createResource(() => (p.user && repo() ? repo() : null), upd.list);
  const [newName, setNewName] = createSignal("forge-releases");
  const [newPrivate, setNewPrivate] = createSignal(false);
  const [dir, setDir] = createSignal(updPrefs.get("dir", ""));
  createEffect(on(() => p.project?.path, (pp) => { if (!dir() && pp) setDir(pp + "\\release"); }));
  const [installers, { refetch: refetchInstallers }] = createResource(() => dir().trim() || null, (d) => upd.installers(d).catch(() => []));
  const [pick, setPick] = createSignal<string | null>(null);
  createEffect(on(installers, (l) => { if (l?.length && (!pick() || !l.some((i) => i.path === pick()))) setPick(l[0].path); }));
  const chosen = () => installers()?.find((i) => i.path === pick());
  const [version, setVersion] = createSignal("");
  createEffect(on(chosen, (c) => setVersion(c?.version ?? "")));
  const [notes, setNotes] = createSignal("");
  const [prerelease, setPrerelease] = createSignal(false);
  const [overwrite, setOverwrite] = createSignal(false);
  const [steps, setSteps] = createSignal<Record<string, Step>>({});
  const [busy, setBusy] = createSignal(false);
  const [del, setDel] = createSignal<ReleaseInfo | null>(null);
  let unlisten: (() => void) | undefined;
  onReleaseStep((s) => setSteps((x) => ({ ...x, [s.id]: s }))).then((u) => (unlisten = u));
  onCleanup(() => unlisten?.());

  const used = () => list()?.totalSize ?? 0;
  const lim = () => limit() * 1024 * 1024;
  const after = () => used() + (chosen()?.size ?? 0);

  const createRepo = async () => {
    setBusy(true);
    try { const full = await upd.createRepo(newName().trim(), newPrivate()); saveRepoGlobal(full); p.toast(`已创建发布仓库 ${full}，并已设为更新仓库`); }
    catch (e) { p.toast(String(e), true); } finally { setBusy(false); }
  };
  const publish = async () => {
    const c = chosen();
    if (!c) return;
    setBusy(true); setSteps({});
    try {
      const r = await upd.publish(repo(), c.path, version(), notes(), prerelease(), overwrite(), limit());
      p.toast(`已发布 v${version()}` + (r.deleted.length ? `，并清理了 ${r.deleted.join("、")}` : ""));
      setNotes(""); refetch();
    } catch (e) { p.toast(String(e), true); } finally { setBusy(false); }
  };

  return (
    <div class="card set-card wide-card" style={hueVars(2)}>
      <h3><span class="ib sm"><Icon name="upload" size={13} /></span>发布新版本<span class="r tag soon">开发者</span></h3>
      <Show when={p.user} fallback={<div class="empty pad"><Icon name="github" size={24} />发布需要先登录 GitHub<button class="btn" onClick={p.goGitHub}>去登录</button></div>}>
        <Show when={repo() && list()?.exists !== false} fallback={
          <div class="new-repo">
            <p class="muted">{repo() ? `仓库 ${repo()} 不存在。` : "还没有发布仓库。"}在 GitHub 上新建一个专门存放安装包的仓库：</p>
            <div class="row-gap">
              <div class="namefield" style={{ flex: 1 }}><span class="muted">{p.user!.login} /</span><input value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} /></div>
              <div class="seg"><button classList={{ on: !newPrivate() }} onClick={() => setNewPrivate(false)}><Icon name="globe" size={13} />公开</button><button classList={{ on: newPrivate() }} onClick={() => setNewPrivate(true)}><Icon name="lock" size={13} />私有</button></div>
              <button class="btn primary" disabled={busy() || !newName().trim()} onClick={createRepo}><Icon name="plus" size={14} />创建仓库</button>
            </div>
            <Show when={newPrivate()}><p class="muted hint-line">私有仓库的更新只有登录了 GitHub 且有权限的 Forge 才能下载；分发给其他人请用公开仓库。</p></Show>
          </div>
        }>
          <div class="pub-grid">
            <div class="pub-form">
              <label class="lbl">安装包所在文件夹</label>
              <div class="row-gap">
                <input class="field mono" style={{ flex: 1 }} value={dir()} onInput={(e) => setDir(e.currentTarget.value)} onChange={() => { updPrefs.set("dir", dir()); refetchInstallers(); }} />
                <button class="btn sm" onClick={() => refetchInstallers()}><Icon name="refresh" size={13} /></button>
              </div>
              <div class="inst-list">
                <For each={installers() ?? []} fallback={<div class="muted" style={{ "font-size": "12px", padding: "8px 2px" }}>这里没有安装包。先在项目目录运行 <code>npm run release -- patch</code> 构建一个。</div>}>
                  {(i) => (
                    <label class="inst" classList={{ on: pick() === i.path }}>
                      <input type="radio" name="inst" checked={pick() === i.path} onChange={() => setPick(i.path)} />
                      <span class="mono">{i.name}</span>
                      <span class="muted">{mbStr(i.size)} · {ago(i.modified)}</span>
                    </label>
                  )}
                </For>
              </div>
              <div class="row-gap">
                <div style={{ flex: 1 }}><label class="lbl">版本号</label><input class="field mono" value={version()} onInput={(e) => setVersion(e.currentTarget.value)} placeholder="0.2.0" /></div>
                <div style={{ width: "150px" }}><label class="lbl">容量上限（MB）</label><input class="field mono" type="number" min="10" value={limit()} onInput={(e) => { setLimit(+e.currentTarget.value || 1024); updPrefs.set("limitMb", String(+e.currentTarget.value || 1024)); }} /></div>
              </div>
              <label class="lbl">更新说明（Markdown，会显示在用户的更新提示里）</label>
              <textarea class="field" rows={4} style={{ height: "auto", padding: "8px 11px" }} value={notes()} onInput={(e) => setNotes(e.currentTarget.value)} placeholder={"## 新功能\n- …"} />
              <div class="row-gap" style={{ margin: "10px 0" }}>
                <label class="check"><input type="checkbox" checked={prerelease()} onChange={(e) => setPrerelease(e.currentTarget.checked)} />预发布</label>
                <label class="check"><input type="checkbox" checked={overwrite()} onChange={(e) => setOverwrite(e.currentTarget.checked)} />覆盖同版本</label>
              </div>
              <button class="btn primary big" disabled={busy() || !chosen() || !version().trim()} onClick={publish}><Icon name="upload" size={16} />{busy() ? "发布中…" : `发布 v${version() || "?"} 到 ${repo()}`}</button>
            </div>
            <div>
              <label class="lbl">仓库容量</label>
              <div class="cap">
                <div class="track budget"><i classList={{ over: after() > lim() }} style={{ width: `${Math.min(100, (used() / lim()) * 100)}%` }} /><b class="cap-next" style={{ left: `${Math.min(100, (used() / lim()) * 100)}%`, width: `${Math.min(100 - Math.min(100, (used() / lim()) * 100), ((chosen()?.size ?? 0) / lim()) * 100)}%` }} /></div>
                <div class="muted" style={{ "font-size": "12px", "margin-top": "6px" }}>已用 {mbStr(used())} / {limit()} MB<Show when={chosen()}> · 发布后 {mbStr(after())}</Show></div>
                <Show when={after() > lim()}><div class="findings warn"><div class="ft">超出上限：发布时会自动删除最旧的版本，直到放得下</div></div></Show>
              </div>
              <Show when={Object.keys(steps()).length}>
                <div class="steps" style={{ "margin-top": "14px" }}>
                  <For each={STEPS}>
                    {(s) => {
                      const x = () => steps()[s.id];
                      return (
                        <div class={`step ${x()?.state ?? "idle"}`}>
                          <span class="sdot">{x()?.state === "ok" ? <Icon name="check" size={13} stroke={2.6} /> : x()?.state === "skip" ? <Icon name="min" size={13} stroke={2.6} /> : x()?.state === "err" ? <Icon name="close" size={13} stroke={2.6} /> : <i />}</span>
                          <div><div class="slabel">{s.label}</div><Show when={x()?.detail}><div class="sdetail">{x()!.detail}</div></Show></div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <label class="lbl" style={{ "margin-top": "14px", display: "block" }}>已发布的版本（{list()?.releases.length ?? 0}）</label>
              <div class="rel-list">
                <For each={list()?.releases ?? []} fallback={<div class="muted" style={{ "font-size": "12px" }}>还没有发布过</div>}>
                  {(r, i) => (
                    <div class="rel">
                      <span class="rel-tag" classList={{ latest: i() === 0 }}>{r.tag}</span>
                      <span class="muted">{ago(Date.parse(r.publishedAt))}</span>
                      <span class="muted">{mbStr(r.assetSize)}</span>
                      <span class="muted">↓ {r.downloads}</span>
                      <Show when={r.prerelease}><span class="tag soon">预发布</span></Show>
                      <button class="icon-btn" style={{ "margin-left": "auto" }} title="在 GitHub 打开" onClick={() => openUrl(r.htmlUrl)}><Icon name="globe" size={13} /></button>
                      <button class="icon-btn" title="删除" onClick={() => setDel(r)}><Icon name="close" size={13} /></button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>
      </Show>
      <Show when={del()}>{(r) => <ConfirmDialog c={{ title: `删除 ${r().tag}？`, body: "会同时删除 GitHub 上的 Release、安装包和标签，无法撤销。已经安装的用户不受影响。", danger: true, okLabel: "删除", ok: async () => { try { await upd.remove(repo(), r().id, r().tag); p.toast(`已删除 ${r().tag}`); refetch(); } catch (e) { p.toast(String(e), true); } } }} close={() => setDel(null)} />}</Show>
    </div>
  );
}

// ================================================================ 页面
export function SettingsView(p: { toast: Toast; user: GhUser | null | undefined; project?: Project; theme: "dark" | "light"; toggleTheme: () => void; lite: boolean; toggleLite: () => void; goGitHub: () => void }) {
  return (
    <div class="page">
      <div class="section-title">设置</div>
      <div class="section-sub">外观、软件更新与版本发布。</div>
      <div class="grid set-grid">
        <div class="card set-card" style={hueVars(0)}>
          <h3><span class="ib sm"><Icon name="sun" size={13} /></span>外观</h3>
          <div class="set-row"><div><b>深色主题</b><div class="muted">关闭后使用浅色主题</div></div>
            <label class="switch"><input type="checkbox" checked={p.theme === "dark"} onChange={p.toggleTheme} /><i /></label></div>
          <div class="set-row"><div><b>低特效模式</b><div class="muted">关闭背景动画和鼠标聚光，更省电</div></div>
            <label class="switch"><input type="checkbox" checked={p.lite} onChange={p.toggleLite} /><i /></label></div>
        </div>
        <UpdateCard toast={p.toast} />
      </div>
      <PublishCard toast={p.toast} user={p.user} project={p.project} goGitHub={p.goGitHub} />
    </div>
  );
}
