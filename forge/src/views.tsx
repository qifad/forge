import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ago, compact, gitSummary, usageSummary, type DayUsage, type Project } from "./api";
import { Icon, type IconName } from "./icons";

export function avatarStyle(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return { background: `linear-gradient(145deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 38%))` };
}

export function Avatar(props: { name: string; class?: string }) {
  return (
    <div class={`avatar ${props.class ?? ""}`} style={avatarStyle(props.name)}>
      {props.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

const DAYS = 14;

/** 渐变色板：每张卡片 / 图标取一对，形成彩色但协调的节奏。 */
export const HUES: [string, string][] = [
  ["#ff8a5b", "#ff5fa2"],
  ["#ff5fa2", "#8b7bff"],
  ["#8b7bff", "#46c9ff"],
  ["#46c9ff", "#3ee0a8"],
  ["#ffc65b", "#ff8a5b"],
  ["#b76bff", "#ff5fa2"],
];
export const hueVars = (i: number) => {
  const [a, b] = HUES[i % HUES.length];
  return { "--h1": a, "--h2": b };
};

const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 数字从当前值缓动到目标值（easeOutExpo，约 0.9s）。 */
function useCountUp(target: () => number) {
  const [v, setV] = createSignal(0);
  let raf = 0;
  createEffect(on(target, (to) => {
    cancelAnimationFrame(raf);
    const from = v();
    if (reduceMotion() || from === to) { setV(to); return; }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      setV(from + (to - from) * (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }));
  onCleanup(() => cancelAnimationFrame(raf));
  return v;
}

function fillDays(rows: DayUsage[] | undefined): DayUsage[] {
  const map = new Map((rows ?? []).map((r) => [r.date, r]));
  return Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(Date.now() - (DAYS - 1 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return map.get(key) ?? { date: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  });
}

function UsageChart(props: { days: DayUsage[] }) {
  const max = createMemo(() => Math.max(1, ...props.days.map((d) => d.input + d.output + d.cacheWrite)));
  return (
    <div class="chart">
      <For each={props.days}>
        {(d, i) => {
          const fresh = d.input + d.cacheWrite;
          const total = fresh + d.output;
          return (
            <div class="bar-col">
              <div class="pop">
                <b>{d.date.slice(5)}</b> · 输出 {compact(d.output)} · 输入 {compact(fresh)} · 缓存读 {compact(d.cacheRead)}
              </div>
              <div class="bar" style={{ height: `${Math.max(2, (total / max()) * 150)}px`, "animation-delay": `${i() * 25}ms` }}>
                <i class="a" style={{ flex: d.output || 0.0001 }} />
                <i class="b" style={{ flex: fresh || 0.0001 }} />
              </div>
              <span class="d">{d.date.slice(8)}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export type Actions = {
  openClaude: (resume?: boolean) => void;
  openEditor: () => void;
  reveal: () => void;
  goPublish: () => void;
  goGit: () => void;
  goAi: () => void;
  goClaude: () => void;
  toast: (msg: string, err?: boolean) => void;
};

export function Overview(props: { project: Project; actions: Actions }) {
  const [usage] = createResource(() => props.project.id, (id) => usageSummary(id, DAYS));
  const [git] = createResource(() => props.project.path, gitSummary);

  const days = createMemo(() => fillDays(usage()));
  const totals = createMemo(() => {
    const ds = days();
    const sum = (f: (d: DayUsage) => number) => ds.reduce((a, d) => a + f(d), 0);
    const input = sum((d) => d.input), cr = sum((d) => d.cacheRead), cw = sum((d) => d.cacheWrite);
    return {
      today: ds[ds.length - 1],
      output: sum((d) => d.output),
      all: sum((d) => d.input + d.output + d.cacheRead + d.cacheWrite),
      messages: sum((d) => d.messages),
      hit: input + cr + cw > 0 ? cr / (input + cr + cw) : 0,
      activeDays: ds.filter((d) => d.messages > 0).length,
    };
  });
  const changes = () => {
    const g = git();
    return g ? g.staged + g.modified + g.untracked + g.conflicted : 0;
  };

  return (
    <div class="page">
      <div class="hero-card">
        <div class="mesh" />
        <div class="hero">
          <Avatar name={props.project.name} />
          <div style={{ "min-width": 0 }}>
            <h1>
              {props.project.name}
              <Show when={!props.project.exists}><span class="tag soon">目录已不存在</span></Show>
            </h1>
            <div class="path">{props.project.path}</div>
          </div>
          <div class="hero-actions">
            <button class="btn" onClick={props.actions.reveal}><Icon name="folder" size={15} />资源管理器</button>
            <button class="btn" onClick={props.actions.openEditor}><Icon name="code" size={15} />VS Code</button>
            <button class="btn" onClick={() => props.actions.openClaude(true)}><Icon name="history" size={15} />继续会话</button>
            <button class="btn primary" onClick={() => props.actions.openClaude()}><Icon name="terminal" size={15} />启动 Claude</button>
          </div>
        </div>
        <div class="hero-meta">
          <Show when={git()?.isRepo}>
            <span class="chip"><Icon name="branch" size={13} />{git()!.branch}</span>
            <span class="chip"><Icon name="git" size={13} />{changes() ? `${changes()} 处变更` : "工作区干净"}</span>
          </Show>
          <span class="chip"><Icon name="history" size={13} />{props.project.sessions} 个会话</span>
          <span class="chip"><Icon name="spark" size={13} />最近活动 {ago(props.project.lastActive)}</span>
        </div>
      </div>

      <div class="grid stats">
        <Stat i={0} icon="spark" label="今日 Tokens" loading={usage.loading}
          num={totals().today.input + totals().today.output + totals().today.cacheWrite} fmt={compact}
          delta={`${totals().today.messages} 条消息 · 不含缓存读取`} />
        <Stat i={1} icon="layers" label={`${DAYS} 天总吞吐`} loading={usage.loading}
          num={totals().all} fmt={compact} delta={`活跃 ${totals().activeDays} 天 · 输出 ${compact(totals().output)}`} />
        <Stat i={2} icon="bell" label="缓存命中率" loading={usage.loading}
          num={totals().hit * 100} fmt={(n) => n.toFixed(1)} unit="%" delta="越高越省钱、越快" />
        <Stat i={3} icon="history" label="会话数" num={props.project.sessions} fmt={(n) => String(Math.round(n))}
          delta={`最近活动 ${ago(props.project.lastActive)}`} />
      </div>

      <div class="grid two">
        <div class="card">
          <h3>
            <Icon name="spark" size={15} />Token 用量 · 近 {DAYS} 天
            <span class="r legend"><span><i style={{ background: "var(--accent)" }} />输出</span><span><i style={{ background: "rgba(232,135,91,.3)" }} />输入 + 缓存写</span></span>
          </h3>
          <Show when={!usage.loading} fallback={<div class="sk" style={{ height: "190px" }} />}>
            <UsageChart days={days()} />
          </Show>
        </div>

        <div class="card" style={{ "animation-delay": "60ms" }}>
          <h3 style={{ cursor: "pointer" }} onClick={props.actions.goGit}><Icon name="git" size={15} />仓库状态
            <Show when={git()?.isRepo}><span class="r tag ok">Git</span></Show>
          </h3>
          <Show when={!git.loading} fallback={<For each={[1, 2, 3, 4]}>{() => <div class="sk" style={{ height: "18px", margin: "12px 0" }} />}</For>}>
            <Show when={git()?.isRepo} fallback={
              <div class="empty" style={{ padding: "22px 0" }}>
                <Icon name="git" size={28} />
                <div>此项目还不是 Git 仓库</div>
                <button class="btn primary" onClick={props.actions.goPublish}><Icon name="upload" size={15} />初始化并上传到 GitHub</button>
              </div>
            }>
              <div class="kv">
                <div class="kv-row"><span class="k">分支</span><span class="v mono">{git()!.branch}</span>
                  <span class="pills" style={{ "margin-left": "auto" }}>
                    <Show when={git()!.ahead}><span class="pill"><Icon name="arrowUp" size={12} /><b>{git()!.ahead}</b></span></Show>
                    <Show when={git()!.behind}><span class="pill"><Icon name="arrowDown" size={12} /><b>{git()!.behind}</b></span></Show>
                  </span>
                </div>
                <div class="kv-row"><span class="k">变更</span>
                  <Show when={changes()} fallback={<span class="v" style={{ color: "var(--ok)" }}>工作区干净 ✓</span>}>
                    <span class="pills">
                      <Show when={git()!.staged}><span class="pill" style={{ color: "var(--ok)" }}>已暂存 <b>{git()!.staged}</b></span></Show>
                      <Show when={git()!.modified}><span class="pill" style={{ color: "var(--warn)" }}>已修改 <b>{git()!.modified}</b></span></Show>
                      <Show when={git()!.untracked}><span class="pill" style={{ color: "var(--info)" }}>未跟踪 <b>{git()!.untracked}</b></span></Show>
                      <Show when={git()!.conflicted}><span class="pill" style={{ color: "var(--err)" }}>冲突 <b>{git()!.conflicted}</b></span></Show>
                    </span>
                  </Show>
                </div>
                <div class="kv-row"><span class="k">最近提交</span><span class="v">{git()!.lastCommit ?? "—"}</span></div>
                <div class="kv-row"><span class="k">远程</span><span class="v mono" title={git()!.remote ?? ""}>{git()!.remote?.replace(/^https?:\/\//, "") ?? "未连接"}</span></div>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      <div class="grid quick">
        <QuickAction i={0} icon="shield" title="检查点与改动审查" sub="Claude 动手前自动快照，逐个文件审查和撤销" onClick={props.actions.goAi} />
        <QuickAction i={1} icon="upload" title="一键上传 GitHub" sub="初始化、创建远程仓库、推送，一步完成" onClick={props.actions.goPublish} />
        <QuickAction i={2} icon="wand" title="AI 提交与 PR" sub="按块暂存，AI 写提交信息和 PR 描述" onClick={props.actions.goGit} />
        <QuickAction i={3} icon="box" title="上下文打包器" sub="勾选文件 → 估算 token → 导出给 Claude" onClick={props.actions.goAi} />
        <QuickAction i={4} icon="file" title="CLAUDE.md 编辑器" sub="分层查看用户 / 项目 / 本地级记忆" onClick={props.actions.goClaude} />
        <QuickAction i={5} icon="plug" title="MCP 服务器" sub="查看、检测连接、添加和移除" onClick={props.actions.goClaude} />
      </div>
    </div>
  );
}

function Stat(p: { i: number; icon: IconName; label: string; num: number; fmt: (n: number) => string; unit?: string; delta: string; loading?: boolean }) {
  const shown = useCountUp(() => (p.loading ? 0 : p.num));
  return (
    <div class="card stat" style={{ ...hueVars(p.i), "animation-delay": `${p.i * 50}ms` }}>
      <div class="label"><span class="ib"><Icon name={p.icon} size={14} /></span>{p.label}</div>
      <Show when={!p.loading} fallback={<div class="sk" style={{ height: "30px", width: "60%", margin: "12px 0 4px" }} />}>
        <div class="value"><span class="gt">{p.fmt(shown())}</span><Show when={p.unit}><small>{p.unit}</small></Show></div>
      </Show>
      <div class="delta">{p.delta}</div>
    </div>
  );
}

function QuickAction(p: { i: number; icon: IconName; title: string; sub: string; soon?: boolean; onClick?: () => void }) {
  return (
    <button class="qa" style={{ ...hueVars(p.i), "animation-delay": `${120 + p.i * 40}ms` }} onClick={p.onClick}>
      <div class="ico"><Icon name={p.icon} size={17} /></div>
      <div>
        <div class="t">{p.title}<Show when={p.soon}><span class="tag soon">即将推出</span></Show></div>
        <div class="s">{p.sub}</div>
      </div>
    </button>
  );
}

export type Feature = { icon: IconName; title: string; desc: string; stage: string };

export function Roadmap(p: { title: string; sub: string; features: Feature[] }) {
  return (
    <div class="page">
      <div class="section-title">{p.title}</div>
      <div class="section-sub">{p.sub}</div>
      <div class="grid features">
        <For each={p.features}>
          {(f, i) => (
            <div class="card feature" style={{ ...hueVars(i()), "animation-delay": `${i() * 40}ms` }}>
              <div class="ico"><Icon name={f.icon} /></div>
              <div>
                <div class="t">{f.title}<span class="tag accent">{f.stage}</span></div>
                <div class="s">{f.desc}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
