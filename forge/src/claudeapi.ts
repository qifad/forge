// Claude 中心接口：会话、搜索、回放、用量、记忆、MCP、设置、终端。浏览器预览时使用示例数据。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./api";

export type Session = {
  id: string; projectId: string; cwd: string; title: string; firstPrompt: string;
  started: number; updated: number; userTurns: number; assistantMsgs: number;
  models: string[]; tokens: number; cost: number | null; gitBranch: string | null; size: number;
};
export type Hit = { projectId: string; sessionId: string; role: string; snippet: string; at: number; len: number; time: number };
export type Item = { role: "user" | "assistant"; kind: "text" | "thinking" | "tool_use" | "tool_result"; text: string; tool: string | null; isError: boolean; meta: boolean; sidechain: boolean; time: number; model: string | null };
export type Bucket = { key: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number };
export type UsageReport = { daily: Bucket[]; byModel: Bucket[]; byProject: Bucket[]; heatmap: number[][]; window: { start: number; resetAt: number; tokens: number; messages: number } | null; sessions: number; cost: number };
export type MemFile = { scope: "user" | "project" | "local" | "auto"; label: string; hint: string; path: string; exists: boolean; size: number; modified: number };
export type McpServer = { name: string; scope: "user" | "local" | "project"; transport: string; target: string; envKeys: string[]; disabled: boolean };
export type Health = { name: string; status: "ok" | "fail" | "auth" | "unknown"; detail: string };
export type SettingsFile = { scope: string; label: string; path: string; exists: boolean; model: string | null; env: [string, string][]; allow: string[]; deny: string[]; hooks: [string, number][]; other: string[]; error: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = <T>(cmd: string, args: Record<string, unknown>, mock: () => T | Promise<T>): Promise<T> =>
  isTauri ? invoke<T>(cmd, args) : sleep(200).then(mock);

// ---------------------------------------------------------------- 示例数据
const H = 3600e3, now = Date.now();
const S = (id: string, title: string, h: number, turns: number, tokens: number, models: string[], branch = "main", cost: number | null = null): Session =>
  ({ id, projectId: "a", cwd: "C:\\Users\\dev\\ModSources\\Moonrealm", title, firstPrompt: title, started: now - (h + 1.5) * H, updated: now - h * H, userTurns: turns, assistantMsgs: turns * 6, models, tokens, cost, gitBranch: branch, size: tokens * 3 });
const mockSessions: Session[] = [
  S("6f1c2a90-aaaa", "给月光生物群系加入地形生成和环境音效", 0.3, 14, 412000, ["claude-opus-5-5"], "main", 3.42),
  S("1b9e77c2-bbbb", "观星者 NPC：对话、商店和贴图动画", 5, 22, 688000, ["claude-opus-5-5", "claude-sonnet-5-5"], "feature/stargazer", 5.1),
  S("c03d5e11-cccc", "多人模式下潮汐系统不同步的 bug", 26, 9, 201000, ["claude-sonnet-5-5"]),
  S("9a8b7c6d-dddd", "把物品注册拆成独立模块并补测试", 70, 6, 98000, ["claude-sonnet-5-5"]),
  S("44ee21ab-eeee", "写 README 和截图说明", 90, 3, 31000, ["claude-haiku-5-5"]),
];
const mockTranscript: Item[] = [
  { role: "user", kind: "text", text: "给月光生物群系加入地形生成，地表要有发光的月石，地下要有潮汐洞穴。", tool: null, isError: false, meta: false, sidechain: false, time: now - 1.8 * H, model: null },
  { role: "assistant", kind: "thinking", text: "先看现有的 Biome 注册方式，再找 WorldGen 的 pass 插入点……", tool: null, isError: false, meta: false, sidechain: false, time: now - 1.79 * H, model: "claude-opus-5-5" },
  { role: "assistant", kind: "text", text: "我先看一下现有的群系注册和世界生成代码。", tool: null, isError: false, meta: false, sidechain: false, time: now - 1.79 * H, model: "claude-opus-5-5" },
  { role: "assistant", kind: "tool_use", text: "src/world/MoonBiome.cs", tool: "Read", isError: false, meta: false, sidechain: false, time: now - 1.78 * H, model: "claude-opus-5-5" },
  { role: "user", kind: "tool_result", text: "public class MoonBiome : ModBiome { … 128 行 … }", tool: null, isError: false, meta: false, sidechain: false, time: now - 1.78 * H, model: null },
  { role: "assistant", kind: "tool_use", text: "dotnet build", tool: "Bash", isError: false, meta: false, sidechain: false, time: now - 1.7 * H, model: "claude-opus-5-5" },
  { role: "user", kind: "tool_result", text: "error CS0246: 未能找到类型或命名空间名“TidePass”", tool: null, isError: true, meta: false, sidechain: false, time: now - 1.7 * H, model: null },
  { role: "assistant", kind: "text", text: "构建失败是因为 `TidePass` 还没创建。我新建 `src/world/TidePass.cs`，在 `ModifyWorldGenTasks` 里把它插到 \"Caves\" 之后。\n\n改动摘要：\n- 新增 `TidePass`：用 Perlin 噪声挖出潮汐洞穴\n- `MoonBiome` 地表随机放置发光月石\n- 构建通过 ✓", tool: null, isError: false, meta: false, sidechain: false, time: now - 1.5 * H, model: "claude-opus-5-5" },
];
function mockReport(days: number): UsageReport {
  const daily = Array.from({ length: days }, (_, i) => {
    const d = new Date(now - (days - 1 - i) * 24 * H); const k = 0.3 + Math.abs(Math.sin(i * 1.3)) * 1.5;
    return { key: d.toISOString().slice(0, 10), input: 40e3 * k, output: 150e3 * k, cacheRead: 2.2e6 * k, cacheWrite: 200e3 * k, messages: Math.round(120 * k) };
  });
  const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 23 ? Math.round(Math.max(0, Math.sin((h - 8) / 4) * 20 + (d < 5 ? 10 : 2) + Math.random() * 8)) : Math.round(Math.random() * 2))));
  return {
    daily, heatmap: heat, sessions: 37, cost: 41.7,
    byModel: [
      { key: "claude-opus-5-5", input: 520e3, output: 1.9e6, cacheRead: 31e6, cacheWrite: 2.4e6, messages: 1840 },
      { key: "claude-sonnet-5-5", input: 300e3, output: 900e3, cacheRead: 12e6, cacheWrite: 1.1e6, messages: 1210 },
      { key: "claude-haiku-5-5", input: 80e3, output: 120e3, cacheRead: 1e6, cacheWrite: 90e3, messages: 330 },
    ],
    byProject: [
      { key: "a", input: 500e3, output: 1.6e6, cacheRead: 25e6, cacheWrite: 2e6, messages: 1700 },
      { key: "b", input: 250e3, output: 800e3, cacheRead: 11e6, cacheWrite: 900e3, messages: 900 },
      { key: "c", input: 150e3, output: 500e3, cacheRead: 8e6, cacheWrite: 700e3, messages: 780 },
    ],
    window: { start: now - 2.2 * H, resetAt: now + 2.8 * H, tokens: 612e3, messages: 96 },
  };
}
const mockMem: Record<string, string> = {
  "C:\\Users\\dev\\.claude\\CLAUDE.md": "# 我的偏好\n\n- 回答用中文，代码注释用中文\n- 提交信息遵循 Conventional Commits\n",
  "C:\\Users\\dev\\ModSources\\Moonrealm\\CLAUDE.md": "# Moonrealm\n\ntModLoader 模组，主题是月亮与潮汐。\n\n## 常用命令\n- 构建：`dotnet build`\n- 打包：在游戏内 Mod Sources 页面点击 Build\n\n## 约定\n- 所有内容类放在 `src/` 下，按 world / items / npcs / systems 分目录\n",
};

// ---------------------------------------------------------------- 接口
export const claude = {
  sessions: (projectId: string | null) => call<Session[]>("list_sessions", { projectId }, () => mockSessions),
  search: (query: string, projectId: string | null) =>
    call<Hit[]>("search_sessions", { query, projectId }, () => {
      const q = query.toLowerCase();
      return mockSessions.filter((s) => s.title.toLowerCase().includes(q)).map((s) => ({ projectId: s.projectId, sessionId: s.id, role: "user", snippet: s.title, at: s.title.toLowerCase().indexOf(q), len: q.length, time: s.updated }));
    }),
  transcript: (projectId: string, sessionId: string) => call<Item[]>("session_transcript", { projectId, sessionId }, () => mockTranscript),
  usage: (days: number) => call<UsageReport>("usage_report", { days }, () => mockReport(days)),
  memFiles: (projectPath: string | null, projectId: string | null) =>
    call<MemFile[]>("memory_files", { projectPath, projectId }, () => [
      { scope: "user", label: "用户记忆", hint: "所有项目共享 · ~/.claude/CLAUDE.md", path: "C:\\Users\\dev\\.claude\\CLAUDE.md", exists: true, size: 80, modified: now - 50 * H },
      { scope: "project", label: "项目记忆", hint: "随仓库提交，团队共享 · CLAUDE.md", path: "C:\\Users\\dev\\ModSources\\Moonrealm\\CLAUDE.md", exists: true, size: 260, modified: now - 4 * H },
      { scope: "project", label: "项目记忆（.claude 目录）", hint: "另一种放置位置 · .claude/CLAUDE.md", path: "C:\\Users\\dev\\ModSources\\Moonrealm\\.claude\\CLAUDE.md", exists: false, size: 0, modified: 0 },
      { scope: "local", label: "本地记忆", hint: "只在本机生效，不应提交 · CLAUDE.local.md", path: "C:\\Users\\dev\\ModSources\\Moonrealm\\CLAUDE.local.md", exists: false, size: 0, modified: 0 },
    ]),
  memRead: (path: string, projectPath: string | null, projectId: string | null) => call<string>("memory_read", { path, projectPath, projectId }, () => mockMem[path] ?? ""),
  memWrite: (path: string, content: string, projectPath: string | null, projectId: string | null) => call<void>("memory_write", { path, content, projectPath, projectId }, () => { mockMem[path] = content; }),
  mcpList: (projectPath: string | null) =>
    call<McpServer[]>("mcp_list", { projectPath }, () => [
      { name: "github", scope: "user", transport: "http", target: "https://api.githubcopilot.com/mcp/", envKeys: [], disabled: false },
      { name: "context7", scope: "user", transport: "http", target: "https://mcp.context7.com/mcp", envKeys: [], disabled: false },
      { name: "tml-docs", scope: "project", transport: "stdio", target: "npx -y tml-docs-mcp", envKeys: ["TML_PATH"], disabled: false },
      { name: "sqlite", scope: "local", transport: "stdio", target: "uvx mcp-server-sqlite --db-path saves.db", envKeys: [], disabled: true },
    ]),
  mcpHealth: (projectPath: string | null) =>
    call<Health[]>("mcp_health", { projectPath }, () => sleep(1200).then(() => [
      { name: "github", status: "ok", detail: "Connected" }, { name: "context7", status: "ok", detail: "Connected" },
      { name: "tml-docs", status: "fail", detail: "Failed to connect" }, { name: "sqlite", status: "auth", detail: "Needs authentication" },
    ] as Health[])),
  mcpAdd: (projectPath: string | null, scope: string, name: string, transport: string, target: string, args: string[], env: string[]) =>
    call<string>("mcp_add", { projectPath, scope, name, transport, target, args, env }, () => `Added ${transport} MCP server ${name}`),
  mcpRemove: (projectPath: string | null, name: string, scope: string) => call<string>("mcp_remove", { projectPath, name, scope }, () => `Removed ${name}`),
  version: () => call<string>("claude_version", {}, () => "3.1.0 (Claude Code)"),
  settings: (projectPath: string | null) =>
    call<SettingsFile[]>("settings_overview", { projectPath }, () => [
      { scope: "user", label: "用户设置", path: "C:\\Users\\dev\\.claude\\settings.json", exists: true, model: null, env: [["ANTHROPIC_AUTH_TOKEN", "已设置（已隐藏）"], ["ANTHROPIC_BASE_URL", "https://api.example.com"], ["ENABLE_TOOL_SEARCH", "true"]], allow: [], deny: [], hooks: [], other: [], error: null },
      { scope: "project", label: "项目设置（共享）", path: "C:\\Users\\dev\\ModSources\\Moonrealm\\.claude\\settings.json", exists: true, model: "opus", env: [], allow: ["Bash(dotnet build:*)", "Bash(git status)", "Read(src/**)"], deny: ["Read(.env)"], hooks: [["PostToolUse", 1]], other: [], error: null },
      { scope: "local", label: "项目设置（本机）", path: "C:\\Users\\dev\\ModSources\\Moonrealm\\.claude\\settings.local.json", exists: false, model: null, env: [], allow: [], deny: [], hooks: [], other: [], error: null },
    ]),
};

// ---------------------------------------------------------------- 终端
type DataEvt = { id: string; data: string };
const mockHandlers = new Set<(e: DataEvt) => void>();
const mockExit = new Set<(id: string) => void>();

export const pty = {
  spawn: async (id: string, cwd: string, command: string | null, cols: number, rows: number) => {
    if (isTauri) return invoke<void>("pty_spawn", { id, cwd, command, cols, rows });
    const emit = (data: string) => mockHandlers.forEach((h) => h({ id, data }));
    emit(`\x1b[2m浏览器预览：这里是模拟终端，不会执行命令。\x1b[0m\r\n${cwd}> ${command ?? ""}\r\n`);
    if (command?.startsWith("claude")) {
      await sleep(400);
      emit("\r\n \x1b[38;2;255;138;91m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m\r\n\r\n   \x1b[2m/help for help, /status for your current setup\x1b[0m\r\n\r\n   cwd: " + cwd + "\r\n\r\n\x1b[38;2;139;123;255m>\x1b[0m ");
    }
  },
  write: (id: string, data: string) => (isTauri ? invoke<void>("pty_write", { id, data }) : (mockHandlers.forEach((h) => h({ id, data: data.replace(/\r/g, "\r\n") })), Promise.resolve())),
  resize: (id: string, cols: number, rows: number) => (isTauri ? invoke<void>("pty_resize", { id, cols, rows }) : Promise.resolve()),
  kill: (id: string) => (isTauri ? invoke<void>("pty_kill", { id }) : Promise.resolve()),
  onData: async (h: (e: DataEvt) => void): Promise<() => void> => {
    if (isTauri) return listen<DataEvt>("pty-data", (e) => h(e.payload));
    mockHandlers.add(h);
    return () => mockHandlers.delete(h);
  },
  onBell: async (h: (id: string) => void): Promise<() => void> => {
    if (isTauri) return listen<string>("pty-bell", (e) => h(e.payload));
    return () => {};
  },
  onExit: async (h: (id: string) => void): Promise<() => void> => {
    if (isTauri) return listen<string>("pty-exit", (e) => h(e.payload));
    mockExit.add(h);
    return () => mockExit.delete(h);
  },
};
