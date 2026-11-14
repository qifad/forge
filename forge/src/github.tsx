import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ago, gitSummary, type Project } from "./api";
import { gh, onPublishProgress, openUrl, type DeviceCode, type Finding, type GhUser, type Progress } from "./gitapi";
import { Icon } from "./icons";
import { Avatar, hueVars } from "./views";

type Toast = (m: string, e?: boolean) => void;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

function UserAvatar(p: { user: GhUser; size?: number }) {
  return (
    <Show when={p.user.avatarUrl} fallback={<Avatar name={p.user.login} class="round" />}>
      <img class="gh-avatar" src={p.user.avatarUrl} width={p.size ?? 52} height={p.size ?? 52} alt="" />
    </Show>
  );
}

// ---------------------------------------------------------------- 登录

function Login(p: { onLogin: (u: GhUser) => void; toast: Toast }) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [clientId, setClientId] = createSignal(store.get("forge.gh.clientId"));
  const [pat, setPat] = createSignal("");
  const [device, setDevice] = createSignal<DeviceCode | null>(null);
  let timer = 0;
  onCleanup(() => clearTimeout(timer));

  const done = (u: GhUser) => { setBusy(null); setDevice(null); p.toast(`已连接 GitHub：${u.login}`); p.onLogin(u); };
  const fail = (e: unknown) => { setBusy(null); p.toast(String(e), true); };

  const viaCli = () => { setBusy("cli"); gh.importCli().then(done, fail); };
  const viaPat = () => { if (!pat().trim()) return; setBusy("pat"); gh.setToken(pat()).then((u) => { setPat(""); done(u); }, fail); };
  const viaDevice = async () => {
    const id = clientId().trim();
    if (!id) return;
    store.set("forge.gh.clientId", id);
    setBusy("device");
    try {
      const d = await gh.deviceStart(id);
      setDevice(d);
      const deadline = Date.now() + d.expiresIn * 1000;
      let interval = d.interval;
      const poll = async () => {
        if (!device()) return;
        if (Date.now() > deadline) { setDevice(null); return fail("授权码已过期，请重新开始"); }
        try {
          const r = await gh.devicePoll(id, d.deviceCode);
          if (r.status === "ok" && r.user) return done(r.user);
          if (r.status === "denied") { setDevice(null); return fail("你在 GitHub 上拒绝了授权"); }
          if (r.status === "expired") { setDevice(null); return fail("授权码已过期，请重新开始"); }
          if (r.status === "slow_down") interval += 5;
          timer = window.setTimeout(poll, interval * 1000);
        } catch (e) { setDevice(null); fail(e); }
      };
      timer = window.setTimeout(poll, interval * 1000);
    } catch (e) { fail(e); }
  };
  const copyAndOpen = async () => {
    const d = device();
    if (!d) return;
    try { await navigator.clipboard.writeText(d.userCode); p.toast("授权码已复制"); } catch {}
    openUrl(d.verificationUri);
  };

  return (
    <>
      <div class="hero-card center">
        <div class="mesh" />
        <div class="gh-mark"><Icon name="github" size={30} /></div>
        <h2>连接你的 GitHub 账号</h2>
        <p class="muted">连接后可以一键发布项目、推送时自动认证。令牌只保存在 Windows 凭据管理器中。</p>
      </div>

      <Show when={device()} fallback={
        <div class="grid three">
          <div class="card method" style={hueVars(0)}>
            <div class="ico"><Icon name="terminal" size={18} /></div>
            <h4>从 GitHub CLI 导入<span class="tag accent">最快</span></h4>
            <p>如果你已经在终端运行过 <code>gh auth login</code>，直接复用那次登录。</p>
            <button class="btn primary" disabled={!!busy()} onClick={viaCli}>{busy() === "cli" ? "连接中…" : "导入登录"}</button>
          </div>
          <div class="card method" style={{ ...hueVars(1), "animation-delay": "50ms" }}>
            <div class="ico"><Icon name="globe" size={18} /></div>
            <h4>浏览器授权</h4>
            <p>使用你自己的 OAuth App（需在设置里启用 Device Flow）。</p>
            <input class="field" placeholder="OAuth App 的 Client ID" value={clientId()} onInput={(e) => setClientId(e.currentTarget.value)} />
            <div class="row-gap">
              <button class="btn" disabled={!!busy() || !clientId().trim()} onClick={viaDevice}>{busy() === "device" ? "请求中…" : "开始授权"}</button>
              <button class="link" onClick={() => openUrl("https://github.com/settings/applications/new")}>创建 OAuth App ↗</button>
            </div>
          </div>
          <div class="card method" style={{ ...hueVars(2), "animation-delay": "100ms" }}>
            <div class="ico"><Icon name="lock" size={18} /></div>
            <h4>个人访问令牌</h4>
            <p>需要 <code>repo</code> 与 <code>workflow</code> 权限。</p>
            <form onSubmit={(e) => { e.preventDefault(); viaPat(); }}>
              <input class="field" type="password" autocomplete="off" placeholder="ghp_… 或 github_pat_…" value={pat()} onInput={(e) => setPat(e.currentTarget.value)} />
              <div class="row-gap">
                <button class="btn" type="submit" disabled={!!busy() || !pat().trim()}>{busy() === "pat" ? "验证中…" : "连接"}</button>
                <button class="link" type="button" onClick={() => openUrl("https://github.com/settings/tokens/new?scopes=repo,workflow,read:user&description=Forge")}>生成令牌 ↗</button>
              </div>
            </form>
          </div>
        </div>
      }>
        <div class="card device">
          <p class="muted">在 GitHub 页面输入下面的授权码</p>
          <div class="ucode">{device()!.userCode.split("").map((c, i) => <span style={{ "animation-delay": `${i * 40}ms` }}>{c}</span>)}</div>
          <div class="row-gap">
            <button class="btn primary" onClick={copyAndOpen}><Icon name="copy" size={15} />复制并打开 GitHub</button>
            <button class="btn" onClick={() => { clearTimeout(timer); setDevice(null); setBusy(null); }}>取消</button>
          </div>
          <div class="waiting"><span class="dot" /><span class="dot" /><span class="dot" />等待你在浏览器中确认</div>
        </div>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------- 发布

const STEPS: { id: string; label: string }[] = [
  { id: "init", label: "初始化仓库" },
  { id: "files", label: "生成 README / .gitignore / LICENSE" },
  { id: "scan", label: "扫描密钥与大文件" },
  { id: "commit", label: "创建提交" },
  { id: "create", label: "在 GitHub 创建仓库" },
  { id: "push", label: "推送代码" },
];

function Publish(p: { project: Project; user: GhUser; toast: Toast }) {
  const [summary, { refetch }] = createResource(() => p.project.path, gitSummary);
  const [name, setName] = createSignal(p.project.name.replace(/[^\w.-]+/g, "-"));
  const [desc, setDesc] = createSignal("");
  const [priv, setPriv] = createSignal(true);
  const [readme, setReadme] = createSignal(true);
  const [ignore, setIgnore] = createSignal(true);
  const [license, setLicense] = createSignal("");
  const [steps, setSteps] = createSignal<Record<string, Progress>>({});
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<string | null>(null);
  const [findings, setFindings] = createSignal<Finding[] | null>(null);

  let unlisten: (() => void) | undefined;
  onPublishProgress((e) => setSteps((s) => ({ ...s, [e.id]: e }))).then((u) => (unlisten = u));
  onCleanup(() => unlisten?.());

  const remote = () => summary()?.remote;
  const valid = () => /^[\w.-]{1,100}$/.test(name().trim());

  const go = async (force = false) => {
    setRunning(true); setResult(null); setFindings(null); setSteps({});
    try {
      const r = await gh.publish({ path: p.project.path, name: name().trim(), description: desc(), private: priv(), readme: readme(), gitignore: ignore(), license: license() || null, force });
      if (r.ok && r.url) { setResult(r.url); p.toast("发布成功 🎉"); refetch(); }
      else setFindings(r.findings);
    } catch (e) { p.toast(String(e), true); }
    finally { setRunning(false); }
  };

  return (
    <div class="card publish">
      <h3><Icon name="upload" size={15} />发布「{p.project.name}」<span class="r mono">{p.project.path}</span></h3>
      <Switch>
        <Match when={result()}>
          <div class="success">
            <div class="burst"><Icon name="check" size={30} stroke={2.4} /></div>
            <h2>已发布到 GitHub</h2>
            <p class="mono muted">{result()!.replace("https://", "")}</p>
            <button class="btn primary" onClick={() => openUrl(result()!)}><Icon name="globe" size={15} />在浏览器中打开</button>
          </div>
        </Match>
        <Match when={remote() && !running() && !Object.keys(steps()).length}>
          <div class="empty pad">
            <Icon name="github" size={28} />
            <div>这个项目已经关联了远程仓库</div>
            <div class="mono muted">{remote()}</div>
            <Show when={remote()!.startsWith("https://")}>
              <button class="btn" onClick={() => openUrl(remote()!.replace(/\.git$/, ""))}><Icon name="globe" size={15} />打开仓库</button>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div class="pub-grid">
            <div class="pub-form">
              <label class="lbl">仓库名</label>
              <div class="namefield" classList={{ bad: !valid() }}>
                <span class="muted">{p.user.login} /</span>
                <input value={name()} onInput={(e) => setName(e.currentTarget.value)} disabled={running()} />
              </div>
              <label class="lbl">描述（可选）</label>
              <input class="field" value={desc()} onInput={(e) => setDesc(e.currentTarget.value)} placeholder="一句话介绍这个项目" disabled={running()} />
              <label class="lbl">可见性</label>
              <div class="seg big">
                <button classList={{ on: priv() }} onClick={() => setPriv(true)} disabled={running()}><Icon name="lock" size={14} />私有</button>
                <button classList={{ on: !priv() }} onClick={() => setPriv(false)} disabled={running()}><Icon name="globe" size={14} />公开</button>
              </div>
              <label class="lbl">自动补全（已存在的文件不会被覆盖）</label>
              <div class="checks">
                <label class="check"><input type="checkbox" checked={readme()} onChange={(e) => setReadme(e.currentTarget.checked)} />README.md</label>
                <label class="check"><input type="checkbox" checked={ignore()} onChange={(e) => setIgnore(e.currentTarget.checked)} />.gitignore（按项目类型）</label>
                <label class="check">LICENSE
                  <select value={license()} onChange={(e) => setLicense(e.currentTarget.value)}>
                    <option value="">不添加</option>
                    <option value="mit">MIT</option>
                    <option value="apache-2.0">Apache 2.0</option>
                    <option value="gpl-3.0">GPL 3.0</option>
                    <option value="bsd-3-clause">BSD 3-Clause</option>
                  </select>
                </label>
              </div>
              <button class="btn primary big" disabled={running() || !valid()} onClick={() => go()}>
                <Icon name="upload" size={16} />{running() ? "发布中…" : "一键发布到 GitHub"}
              </button>
            </div>
            <div class="steps">
              <For each={STEPS}>
                {(s) => {
                  const st = () => steps()[s.id];
                  return (
                    <div class={`step ${st()?.state ?? "idle"}`}>
                      <span class="sdot">
                        <Switch fallback={<i />}>
                          <Match when={st()?.state === "ok"}><Icon name="check" size={13} stroke={2.6} /></Match>
                          <Match when={st()?.state === "skip"}><Icon name="min" size={13} stroke={2.6} /></Match>
                          <Match when={st()?.state === "err"}><Icon name="close" size={13} stroke={2.6} /></Match>
                        </Switch>
                      </span>
                      <div>
                        <div class="slabel">{s.label}</div>
                        <Show when={st()?.detail}><div class="sdetail">{st()!.detail}</div></Show>
                      </div>
                    </div>
                  );
                }}
              </For>
              <Show when={findings()}>
                <div class="findings">
                  <div class="ft"><Icon name="shield" size={14} />发现可能不该上传的内容，已暂停发布</div>
                  <For each={findings()!}>{(f) => <div class="fi"><span class="mono">{f.file}{f.line ? `:${f.line}` : ""}</span><span>{f.kind}</span></div>}</For>
                  <p class="muted">建议把它们加入 .gitignore 后重新发布。</p>
                  <div class="row-gap">
                    <button class="btn sm danger" onClick={() => go(true)}>我已确认，继续发布</button>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

// ---------------------------------------------------------------- 页面

export function GitHubView(p: { project?: Project; user: GhUser | null | undefined; loading: boolean; setUser: (u: GhUser | null) => void; toast: Toast }) {
  const [repos] = createResource(() => p.user?.login, () => gh.repos());
  const logout = async () => { await gh.logout(); p.setUser(null); p.toast("已断开 GitHub"); };
  return (
    <div class="page">
      <Show when={!p.loading} fallback={<div class="sk" style={{ height: "160px", "border-radius": "20px" }} />}>
        <Show when={p.user} fallback={<Login onLogin={(u) => p.setUser(u)} toast={p.toast} />}>
          {(u) => (
            <>
              <div class="hero-card">
                <div class="mesh" />
                <div class="hero">
                  <UserAvatar user={u()} />
                  <div>
                    <h1>{u().name ?? u().login}</h1>
                    <div class="path">@{u().login}</div>
                  </div>
                  <div class="hero-actions">
                    <button class="btn" onClick={() => openUrl(u().htmlUrl)}><Icon name="globe" size={15} />个人主页</button>
                    <button class="btn" onClick={logout}>断开连接</button>
                  </div>
                </div>
                <div class="hero-meta">
                  <span class="chip"><Icon name="globe" size={13} />{u().publicRepos} 个公开仓库</span>
                  <span class="chip"><Icon name="lock" size={13} />{u().totalPrivateRepos} 个私有仓库</span>
                  <span class="chip"><Icon name="shield" size={13} />令牌保存在 Windows 凭据管理器</span>
                </div>
              </div>

              <Show when={p.project}>{(proj) => <Publish project={proj()} user={u()} toast={p.toast} />}</Show>

              <div class="card" style={{ "margin-top": "14px", "animation-delay": "80ms" }}>
                <h3><Icon name="layers" size={15} />最近推送的仓库</h3>
                <Show when={!repos.loading} fallback={<div class="sk" style={{ height: "80px" }} />}>
                  <div class="repos">
                    <For each={repos() ?? []} fallback={<div class="empty pad">还没有仓库</div>}>
                      {(r) => (
                        <button class="repo" onClick={() => openUrl(r.htmlUrl)}>
                          <div class="rn"><Icon name={r.private ? "lock" : "globe"} size={13} />{r.name}</div>
                          <div class="rd">{r.description ?? "没有描述"}</div>
                          <div class="rm">
                            <Show when={r.language}><span>{r.language}</span></Show>
                            <span>★ {r.stars}</span>
                            <span>{ago(Date.parse(r.updatedAt))}</span>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
