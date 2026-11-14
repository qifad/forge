// AI 工具箱接口：检查点、上下文打包、项目地图、claude -p、PR、通知。浏览器预览使用示例数据。
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

export type Checkpoint = { id: string; commit: string; tree: string; time: number; label: string; files: number; added: number; removed: number };
export type Change = { path: string; status: "A" | "M" | "D"; added: number | null; removed: number | null };
export type FileInfo = { path: string; size: number; binary: boolean; tokens: number };
export type Packed = { text: string; tokens: number; files: number; skipped: string[] };
export type ProjectMap = { markdown: string; context: string };
export type PrInfo = { owner: string; repo: string; branch: string; base: string; existing: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = <T>(cmd: string, args: Record<string, unknown>, mock: () => T | Promise<T>): Promise<T> =>
  isTauri ? invoke<T>(cmd, args) : sleep(220).then(mock);

// ---------------------------------------------------------------- 示例数据
const H = 3600e3, now = Date.now();
let mockCks: Checkpoint[] = [
  { id: "3", commit: "c3", tree: "t3", time: now - 0.4 * H, label: "启动 Claude 前 · 给月光群系加地形生成", files: 4, added: 126, removed: 18 },
  { id: "2", commit: "c2", tree: "t2", time: now - 5 * H, label: "启动 Claude 前 · 观星者 NPC", files: 9, added: 402, removed: 77 },
  { id: "1", commit: "c1", tree: "t1", time: now - 26 * H, label: "手动：重构物品注册之前", files: 15, added: 690, removed: 240 },
];
const mockChanges: Change[] = [
  { path: "src/world/MoonBiome.cs", status: "M", added: 38, removed: 6 },
  { path: "src/world/TidePass.cs", status: "A", added: 74, removed: 0 },
  { path: "assets/textures/moonstone.png", status: "A", added: null, removed: null },
  { path: "src/world/OldTide.cs", status: "D", added: 0, removed: 12 },
];
const mockFiles = (): FileInfo[] => {
  const f = (path: string, size: number, binary = false) => ({ path, size, binary, tokens: binary ? 0 : Math.round(size / 3.6) });
  return [
    f("README.md", 4200), f("Moonrealm.csproj", 1600), f("build.txt", 300), f("description.txt", 900),
    f("src/Moonrealm.cs", 2400), f("src/world/MoonBiome.cs", 9800), f("src/world/TidePass.cs", 6400), f("src/world/WorldGenHelpers.cs", 12000),
    f("src/items/LunarBlade.cs", 5200), f("src/items/MoonstoneOre.cs", 3100), f("src/items/Registry.cs", 7700),
    f("src/npcs/Stargazer.cs", 11200), f("src/npcs/StargazerShop.cs", 4300), f("src/systems/Tides.cs", 15800), f("src/systems/Sync.cs", 6900),
    f("assets/textures/moon_tile.png", 22000, true), f("assets/textures/moonstone.png", 8000, true), f("Localization/zh-Hans.hjson", 18000), f("Localization/en-US.hjson", 16500),
  ];
};

// ---------------------------------------------------------------- 接口
export const ai = {
  checkpoints: (path: string) => call<Checkpoint[]>("checkpoint_list", { path }, () => mockCks),
  createCheckpoint: (path: string, label: string) =>
    call<Checkpoint | null>("checkpoint_create", { path, label }, () => {
      const c = { id: String(Date.now()), commit: "c", tree: "t" + Date.now(), time: Date.now(), label, files: 0, added: 0, removed: 0 };
      mockCks = [c, ...mockCks];
      return c;
    }),
  deleteCheckpoint: (path: string, id: string) => call<void>("checkpoint_delete", { path, id }, () => { mockCks = mockCks.filter((c) => c.id !== id); }),
  changes: (path: string, tree: string) => call<Change[]>("checkpoint_changes", { path, tree }, () => mockChanges),
  fileDiff: (path: string, tree: string, file: string) =>
    call<string>("checkpoint_file_diff", { path, tree, file }, () =>
      file.endsWith(".png") ? `diff --git a/${file} b/${file}\nBinary files differ\n`
      : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -20,6 +20,14 @@ public class MoonBiome : ModBiome\n     public override void SetStaticDefaults()\n     {\n-        DisplayName.SetDefault("Moon");\n+        // 地表：发光月石\n+        SpawnSurfaceOre<MoonstoneOre>(density: 0.012f);\n+        // 地下：潮汐洞穴，由 TidePass 生成\n+        WorldGen.AddPass<TidePass>(after: "Caves");\n     }\n \n     public override int Music => MusicID.Space;\n`),
  revertFile: (path: string, tree: string, file: string) => call<void>("checkpoint_revert_file", { path, tree, file }, () => {}),
  restore: (path: string, tree: string) => call<number>("checkpoint_restore", { path, tree }, () => 4),
  files: (path: string) => call<FileInfo[]>("project_files", { path }, mockFiles),
  pack: (path: string, files: string[], format: "markdown" | "xml", includeTree: boolean) =>
    call<Packed>("pack_context", { path, files, format, includeTree }, () => ({ text: `# 示例\n\n${files.map((f) => `## ${f}\n\n\`\`\`\n…\n\`\`\``).join("\n\n")}`, tokens: files.length * 2100, files: files.length, skipped: [] })),
  saveDownloads: (name: string, content: string) => call<string>("save_to_downloads", { name, content }, () => `C:\\Users\\dev\\Downloads\\${name}`),
  projectMap: (path: string) =>
    call<ProjectMap>("project_map", { path }, () => ({
      markdown: "<!-- forge:map:start -->\n## 项目地图\n\n> 由 Forge 自动生成 · 19 个文件\n\n- **语言**：C# 86% · HJSON 14%\n- **关键文件**：`Moonrealm.csproj`\n\n### 目录结构\n\n```text\nLocalization/ (2)\nassets/ (2)\n  textures/ (2)\nsrc/ (11)\n  items/ (3)\n  npcs/ (2)\n  systems/ (2)\n  world/ (3)\nMoonrealm.csproj\nREADME.md\n```\n<!-- forge:map:end -->\n",
      context: "…",
    })),
  ask: (cwd: string, instruction: string, input: string) =>
    call<string>("ai_ask", { cwd, instruction, input }, () => sleep(1500).then(() => "- `src/world/`：世界生成——月光群系与潮汐洞穴\n- `src/items/`：物品定义与注册\n- `src/npcs/`：观星者 NPC 及其商店\n- `src/systems/`：潮汐周期与多人同步\n- `Localization/`：中英文本地化")),
  commitMessage: (path: string) =>
    call<string>("ai_commit_message", { path }, () => sleep(1600).then(() => "feat(world): 月光群系加入月石矿与潮汐洞穴\n\n- 新增 TidePass，在 Caves 之后用噪声挖出潮汐洞穴\n- 地表按 1.2% 密度生成发光月石\n- 移除不再使用的 OldTide")),
  prDescription: (path: string, base: string) =>
    call<string>("ai_pr_description", { path, base }, () => sleep(1800).then(() => "观星者 NPC：对话、商店与动画\n\n## 改动内容\n- 新增观星者 NPC，夜晚在月光群系出现\n- 商店出售星图与月石工具\n- 补充贴图与 8 帧待机动画\n\n## 如何测试\n1. 新建世界并进入月光群系\n2. 夜晚等待观星者出现，打开商店检查商品")),
  defaultBranch: (path: string) => call<string>("git_default_branch", { path }, () => "main"),
  prInfo: (path: string) => call<PrInfo>("gh_pr_info", { path }, () => ({ owner: "moonrealm-dev", repo: "Moonrealm", branch: "feature/stargazer", base: "main", existing: null })),
  createPr: (path: string, title: string, body: string, base: string, draft: boolean) =>
    call<string>("gh_create_pr", { path, title, body, base, draft }, () => sleep(900).then(() => "https://github.com/moonrealm-dev/Moonrealm/pull/42")),
};

// ---------------------------------------------------------------- 系统通知
export async function notify(title: string, body: string) {
  if (!isTauri) {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
    return;
  }
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === "granted";
  if (ok) n.sendNotification({ title, body });
}

// ---------------------------------------------------------------- 偏好（本机）
const K = "forge.ai.";
export const prefs = {
  get: (k: string, d: string) => { try { return localStorage.getItem(K + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(K + k, v); } catch {} },
  bool: (k: string, d: boolean) => prefs.get(k, d ? "1" : "0") === "1",
};
