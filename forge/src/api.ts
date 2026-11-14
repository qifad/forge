// 前端与 Rust 后端之间的桥。在普通浏览器里（非 Tauri）使用示例数据，方便调 UI。
import { invoke } from "@tauri-apps/api/core";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Project = {
  id: string;
  name: string;
  path: string;
  sessions: number;
  lastActive: number;
  exists: boolean;
  isGit: boolean;
};

export type DayUsage = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
};

export type GitSummary = {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  remote: string | null;
  lastCommit: string | null;
};

const now = Date.now();
const H = 3_600_000;
const mockProjects: Project[] = [
  { id: "a", name: "Moonrealm", path: "C:\\Users\\dev\\ModSources\\Moonrealm", sessions: 42, lastActive: now - 0.3 * H, exists: true, isGit: true },
  { id: "b", name: "Badminton", path: "E:\\Godotproject\\Badminton", sessions: 18, lastActive: now - 5 * H, exists: true, isGit: true },
  { id: "c", name: "Autoword", path: "F:\\Work\\Autoword", sessions: 27, lastActive: now - 26 * H, exists: true, isGit: false },
  { id: "d", name: "translation", path: "F:\\Work\\translation", sessions: 9, lastActive: now - 80 * H, exists: true, isGit: true },
  { id: "e", name: "BDH", path: "C:\\Users\\dev\\midiii\\BDH", sessions: 4, lastActive: now - 300 * H, exists: false, isGit: false },
];

function mockUsage(days: number): DayUsage[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now - (days - 1 - i) * 24 * H);
    const k = 0.4 + Math.abs(Math.sin(i * 1.7)) * 1.4;
    return {
      date: d.toISOString().slice(0, 10),
      input: Math.round(48_000 * k),
      output: Math.round(160_000 * k),
      cacheRead: Math.round(2_400_000 * k),
      cacheWrite: Math.round(220_000 * k),
      messages: Math.round(140 * k),
    };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function listProjects(): Promise<Project[]> {
  if (!isTauri) return sleep(350).then(() => mockProjects);
  return invoke("list_claude_projects");
}

export async function usageSummary(projectId: string | null, days: number): Promise<DayUsage[]> {
  if (!isTauri) return sleep(450).then(() => mockUsage(days));
  return invoke("usage_summary", { projectId, days });
}

export async function gitSummary(path: string): Promise<GitSummary> {
  if (!isTauri) {
    await sleep(250);
    if (!mockProjects.find((p) => p.path === path)?.isGit)
      return { isRepo: false, branch: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, remote: null, lastCommit: null };
    return { isRepo: true, branch: "main", ahead: 2, behind: 0, staged: 3, modified: 5, untracked: 2, conflicted: 0, remote: "https://github.com/you/" + path.split("\\").pop(), lastCommit: "feat: 新增月光生物群系 · 2 hours ago" };
  }
  return invoke("git_summary", { path });
}

export async function openClaude(path: string, resume = false) {
  if (!isTauri) return;
  return invoke("open_terminal_claude", { path, resume });
}
export async function openEditor(path: string) {
  if (!isTauri) return;
  return invoke("open_in_editor", { path });
}
export async function reveal(path: string) {
  if (!isTauri) return;
  return invoke("reveal_in_explorer", { path });
}

// ---------- 格式化 ----------
export function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  return new Date(ms).toLocaleDateString("zh-CN");
}
