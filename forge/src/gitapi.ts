// Git / GitHub 接口。浏览器预览时使用内存里的模拟仓库。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./api";

export type FileEntry = {
  path: string;
  origPath: string | null;
  x: string;
  y: string;
  kind: "changed" | "renamed" | "untracked" | "conflict";
  staged: boolean;
  unstaged: boolean;
};
export type RepoStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  files: FileEntry[];
  stashCount: number;
};
export type Branch = { name: string; remote: boolean; current: boolean; upstream: string | null; track: string; updated: number; subject: string };
export type Commit = { hash: string; parents: string[]; author: string; time: number; subject: string; refs: string[] };
export type Finding = { file: string; kind: string; line: number | null; level: "block" | "warn" };
export type GhUser = { id: number; login: string; name: string | null; avatarUrl: string; htmlUrl: string; publicRepos: number; totalPrivateRepos: number };
export type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
export type Repo = { fullName: string; name: string; private: boolean; htmlUrl: string; description: string | null; language: string | null; stars: number; updatedAt: string };
export type PublishOpts = { path: string; name: string; description: string; private: boolean; readme: boolean; gitignore: boolean; license: string | null; force: boolean };
export type PublishOutcome = { ok: boolean; url: string | null; findings: Finding[] };
export type Progress = { id: string; state: "run" | "ok" | "skip" | "err"; detail: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = <T>(cmd: string, args: Record<string, unknown>, mock: () => T | Promise<T>): Promise<T> =>
  isTauri ? invoke<T>(cmd, args) : sleep(160).then(mock);

// ---------------------------------------------------------------- 模拟仓库
const m = {
  files: [
    { path: "src/world/MoonBiome.cs", origPath: null, x: "M", y: ".", kind: "changed", staged: true, unstaged: false },
    { path: "src/items/LunarBlade.cs", origPath: null, x: "M", y: "M", kind: "changed", staged: true, unstaged: true },
    { path: "src/npcs/Stargazer.cs", origPath: null, x: ".", y: "M", kind: "changed", staged: false, unstaged: true },
    { path: "assets/textures/moon_tile.png", origPath: null, x: ".", y: "M", kind: "changed", staged: false, unstaged: true },
    { path: "docs/设计说明.md", origPath: null, x: "?", y: "?", kind: "untracked", staged: false, unstaged: true },
    { path: "src/systems/Tides.cs", origPath: "src/systems/Tide.cs", x: "R", y: ".", kind: "renamed", staged: true, unstaged: false },
  ] as FileEntry[],
};
const mockDiff = (file: string) =>
  file.endsWith(".png")
    ? `diff --git a/${file} b/${file}\nBinary files a/${file} and b/${file} differ\n`
    : `diff --git a/${file} b/${file}\nindex 3f2a1c4..9b8e7d2 100644\n--- a/${file}\n+++ b/${file}\n@@ -12,9 +12,11 @@ namespace Moonrealm.Content\n     public class Stargazer : ModNPC\n     {\n-        private const int SpawnChance = 12;\n+        private const int SpawnChance = 18;\n+        private const float GlowRadius = 2.5f;\n \n         public override void SetDefaults()\n         {\n             NPC.width = 18;\n-            NPC.height = 40;\n+            NPC.height = 42;\n+            NPC.townNPC = true;\n             NPC.friendly = true;\n         }\n@@ -58,6 +60,8 @@ namespace Moonrealm.Content\n         public override string GetChat()\n         {\n             return Main.rand.Next(3) switch\n             {\n+                0 => \"月相在变，潮汐也在变。\",\n+                1 => \"你见过会唱歌的星星吗？\",\n                 _ => \"夜色正好。\",\n             };\n         }\n`;

function mockLog(): Commit[] {
  const now = Date.now() / 1000;
  const c = (hash: string, parents: string[], subject: string, h: number, refs: string[] = [], author = "you"): Commit => ({ hash, parents, author, time: now - h * 3600, subject, refs });
  return [
    c("a9", ["a8"], "feat: 新增月光生物群系的地形生成", 1, ["HEAD -> main", "origin/main"]),
    c("a8", ["a7", "b3"], "Merge branch 'feature/stargazer'", 3),
    c("b3", ["b2"], "feat(npc): 观星者对话与商店", 5, ["feature/stargazer"]),
    c("a7", ["a6"], "fix: 修复潮汐系统在多人模式下不同步", 7),
    c("b2", ["b1"], "feat(npc): 观星者贴图与动画", 20),
    c("a6", ["a5", "d1"], "Merge pull request #12 from dev/fix-crash", 26),
    c("d1", ["a4"], "fix: 加载世界时的空引用崩溃", 30, [], "dev"),
    c("b1", ["a4"], "feat(npc): 观星者基础设定", 32),
    c("a5", ["a4"], "chore: 升级 tModLoader 依赖", 40, ["v0.3.0"]),
    c("a4", ["a3"], "feat: 月之刃 LunarBlade", 52),
    c("a3", ["a2"], "refactor: 拆分物品注册", 70),
    c("a2", ["a1"], "docs: README 与截图", 90),
    c("a1", [], "Initial commit", 120),
  ];
}

// ---------------------------------------------------------------- Git
export const git = {
  status: (path: string) => call<RepoStatus>("git_status", { path }, () => ({ branch: "main", upstream: "origin/main", ahead: 2, behind: 0, hasCommits: true, files: m.files.map((f) => ({ ...f })), stashCount: 1 })),
  diff: (path: string, file: string, staged: boolean, untracked: boolean) =>
    call<string>("git_diff", { path, file, staged, untracked }, () => mockDiff(file)),
  stage: (path: string, files: string[]) =>
    call<void>("git_stage", { path, files }, () => { m.files = m.files.map((f) => (files.includes(f.path) ? { ...f, staged: true, unstaged: false, x: f.kind === "untracked" ? "A" : f.x === "." ? f.y : f.x, y: ".", kind: f.kind === "untracked" ? "changed" : f.kind } : f)); }),
  unstage: (path: string, files: string[]) =>
    call<void>("git_unstage", { path, files }, () => { m.files = m.files.map((f) => (files.includes(f.path) ? { ...f, staged: false, unstaged: true, y: f.x === "A" ? "?" : f.x, x: f.x === "A" ? "?" : ".", kind: f.x === "A" ? "untracked" : f.kind } : f)); }),
  discard: (path: string, tracked: string[], untracked: string[]) =>
    call<void>("git_discard", { path, tracked, untracked }, () => { m.files = m.files.filter((f) => !untracked.includes(f.path)).map((f) => (tracked.includes(f.path) ? { ...f, unstaged: false, y: "." } : f)).filter((f) => f.staged || f.unstaged); }),
  applyPatch: (path: string, patch: string, reverse: boolean) => call<void>("git_apply_patch", { path, patch, reverse }, () => {}),
  commit: (path: string, message: string, amend: boolean) =>
    call<string>("git_commit", { path, message, amend }, () => { m.files = m.files.filter((f) => f.unstaged).map((f) => ({ ...f, staged: false, x: "." })); return "f00dbab " + message.split("\n")[0]; }),
  lastMessage: (path: string) => call<string>("git_last_message", { path }, () => "feat: 新增月光生物群系的地形生成"),
  branches: (path: string) =>
    call<Branch[]>("git_branches", { path }, () => {
      const t = Date.now() / 1000;
      return [
        { name: "main", remote: false, current: true, upstream: "origin/main", track: "ahead 2", updated: t - 3600, subject: "feat: 新增月光生物群系的地形生成" },
        { name: "feature/stargazer", remote: false, current: false, upstream: null, track: "", updated: t - 18000, subject: "feat(npc): 观星者对话与商店" },
        { name: "experiment/tides-v2", remote: false, current: false, upstream: "origin/experiment/tides-v2", track: "behind 3", updated: t - 86400 * 4, subject: "wip: 新潮汐算法" },
        { name: "origin/main", remote: true, current: false, upstream: null, track: "", updated: t - 7200, subject: "Merge branch 'feature/stargazer'" },
        { name: "origin/dev/fix-crash", remote: true, current: false, upstream: null, track: "", updated: t - 86400, subject: "fix: 加载世界时的空引用崩溃" },
      ];
    }),
  checkout: (path: string, branch: string) => call<void>("git_checkout", { path, branch }, () => {}),
  createBranch: (path: string, name: string, checkout: boolean) => call<void>("git_create_branch", { path, name, checkout }, () => {}),
  log: (path: string, limit = 300) => call<Commit[]>("git_log", { path, limit }, mockLog),
  sync: (path: string, action: "fetch" | "pull" | "push") => call<string>("git_sync", { path, action }, () => sleep(700).then(() => "")),
  stash: (path: string, pop: boolean) => call<void>("git_stash", { path, pop }, () => {}),
  init: (path: string) => call<void>("git_init", { path }, () => {}),
  scan: (path: string, mode: "staged" | "all") => call<Finding[]>("git_scan", { path, mode }, () => []),
};

// ---------------------------------------------------------------- GitHub
let mockUser: GhUser | null = null;
const demoUser: GhUser = { id: 1, login: "moonrealm-dev", name: "Moon Dev", avatarUrl: "", htmlUrl: "https://github.com/moonrealm-dev", publicRepos: 14, totalPrivateRepos: 5 };

export const gh = {
  status: () => call<GhUser | null>("gh_status", {}, () => mockUser),
  setToken: (token: string) => call<GhUser>("gh_set_token", { token }, () => (mockUser = demoUser)),
  importCli: () => call<GhUser>("gh_import_cli", {}, () => (mockUser = demoUser)),
  logout: () => call<void>("gh_logout", {}, () => { mockUser = null; }),
  deviceStart: (clientId: string) =>
    call<DeviceCode>("gh_device_start", { clientId }, () => ({ deviceCode: "x", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", interval: 2, expiresIn: 900 })),
  devicePoll: (clientId: string, deviceCode: string) =>
    call<{ status: string; user: GhUser | null }>("gh_device_poll", { clientId, deviceCode }, () => ({ status: "ok", user: (mockUser = demoUser) })),
  repos: () =>
    call<Repo[]>("gh_repos", {}, () => [
      { fullName: "moonrealm-dev/Moonrealm", name: "Moonrealm", private: false, htmlUrl: "#", description: "一个以月亮为主题的 tModLoader 模组", language: "C#", stars: 128, updatedAt: new Date(Date.now() - 3600e3).toISOString() },
      { fullName: "moonrealm-dev/Badminton", name: "Badminton", private: true, htmlUrl: "#", description: "Godot 羽毛球小游戏", language: "GDScript", stars: 3, updatedAt: new Date(Date.now() - 86400e3).toISOString() },
      { fullName: "moonrealm-dev/translation", name: "translation", private: true, htmlUrl: "#", description: null, language: "Python", stars: 0, updatedAt: new Date(Date.now() - 86400e3 * 5).toISOString() },
    ]),
  publish: async (opts: PublishOpts): Promise<PublishOutcome> => {
    if (isTauri) return invoke("gh_publish", { opts });
    for (const id of ["init", "files", "scan", "commit", "create", "push"]) {
      progressHandlers.forEach((h) => h({ id, state: "run", detail: "" }));
      await sleep(550);
      progressHandlers.forEach((h) => h({ id, state: id === "init" ? "skip" : "ok", detail: { init: "已是 Git 仓库", files: "README.md、.gitignore（Node）", scan: "未发现密钥或超大文件", commit: "1a2b3c4 Initial commit", create: `moonrealm-dev/${opts.name}`, push: "已推送并设置上游分支" }[id]! }));
    }
    return { ok: true, url: `https://github.com/moonrealm-dev/${opts.name}`, findings: [] };
  },
};

const progressHandlers = new Set<(p: Progress) => void>();
export async function onPublishProgress(h: (p: Progress) => void): Promise<() => void> {
  if (isTauri) return listen<Progress>("publish-progress", (e) => h(e.payload));
  progressHandlers.add(h);
  return () => progressHandlers.delete(h);
}

export async function openUrl(url: string) {
  if (isTauri) return invoke("open_url", { url });
  window.open(url, "_blank", "noopener");
}

// ---------------------------------------------------------------- diff 解析
export type DiffLine = { t: " " | "+" | "-" | "\\"; text: string; a: number | null; b: number | null };
export type Hunk = { header: string; lines: DiffLine[]; raw: string };
export type ParsedDiff = { header: string; hunks: Hunk[]; binary: boolean };

export function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines.findIndex((l) => l.startsWith("@@"));
  const header = (first < 0 ? lines : lines.slice(0, first)).join("\n") + "\n";
  const binary = /^Binary files /m.test(raw) && first < 0;
  const hunks: Hunk[] = [];
  if (first >= 0) {
    let cur: Hunk | null = null;
    let a = 0, b = 0;
    for (const l of lines.slice(first)) {
      if (l.startsWith("@@")) {
        const mm = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        a = mm ? +mm[1] : 0; b = mm ? +mm[2] : 0;
        cur = { header: l, lines: [], raw: l + "\n" };
        hunks.push(cur);
        continue;
      }
      if (!cur) continue;
      cur.raw += l + "\n";
      const t = (l[0] ?? " ") as DiffLine["t"];
      if (t === "+") cur.lines.push({ t, text: l.slice(1), a: null, b: b++ });
      else if (t === "-") cur.lines.push({ t, text: l.slice(1), a: a++, b: null });
      else if (t === "\\") cur.lines.push({ t, text: l.slice(1), a: null, b: null });
      else cur.lines.push({ t: " ", text: l.slice(1), a: a++, b: b++ });
    }
  }
  return { header, hunks, binary };
}

// ---------------------------------------------------------------- 提交图谱布局
export type GraphRow = { commit: Commit; col: number; before: (string | null)[]; after: (string | null)[]; outs: number[]; width: number };

export function layoutGraph(commits: Commit[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) { col = lanes.length; lanes.push(null); }
    }
    // 其他指向本提交的车道在此汇合
    lanes = lanes.map((h, i) => (h === c.hash && i !== col ? null : h));
    lanes[col] = c.parents[0] ?? null;
    const outs = c.parents.length ? [col] : [];
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) {
        k = lanes.indexOf(null);
        if (k < 0) { k = lanes.length; lanes.push(null); }
        lanes[k] = p;
      }
      outs.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, col, before, after: lanes.slice(), outs, width: Math.max(before.length, lanes.length, col + 1) });
  }
  return rows;
}
