// 更新与发布接口。浏览器预览时使用示例数据。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./api";

export type ReleaseInfo = {
  id: number; tag: string; version: string; name: string; notes: string; publishedAt: string; prerelease: boolean;
  htmlUrl: string; assetId: number | null; assetName: string | null; assetSize: number; downloads: number;
};
export type UpdateCheck = { current: string; latest: ReleaseInfo | null; hasUpdate: boolean };
export type RepoReleases = { exists: boolean; private: boolean; releases: ReleaseInfo[]; totalSize: number };
export type LocalInstaller = { path: string; name: string; size: number; modified: number; version: string | null };
export type PublishResult = { url: string; deleted: string[]; totalAfter: number };
export type Step = { id: string; state: "run" | "ok" | "skip" | "err"; detail: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = <T>(cmd: string, args: Record<string, unknown>, mock: () => T | Promise<T>): Promise<T> =>
  isTauri ? invoke<T>(cmd, args) : sleep(300).then(mock);

const MB = 1024 * 1024, day = 86400e3;
const rel = (v: string, daysAgo: number, size: number, dl: number, notes = ""): ReleaseInfo => ({
  id: Math.round(daysAgo * 10), tag: "v" + v, version: v, name: "Forge " + v, notes, publishedAt: new Date(Date.now() - daysAgo * day).toISOString(),
  prerelease: false, htmlUrl: "#", assetId: 1, assetName: `Forge_${v}_x64-setup.exe`, assetSize: size, downloads: dl,
});
const mockReleases = [
  rel("0.2.0", 0.2, 3.9 * MB, 3, "## 新功能\n- 应用内自动更新\n- 设置页：发布新版本、容量管理\n\n## 修复\n- Win10 拖动窗口卡顿"),
  rel("0.1.2", 6, 3.7 * MB, 12), rel("0.1.1", 13, 3.7 * MB, 9), rel("0.1.0", 20, 3.68 * MB, 5),
];

export const upd = {
  version: () => call<string>("app_version", {}, () => "0.1.0"),
  check: (repo: string, includePrerelease: boolean) =>
    call<UpdateCheck>("update_check", { repo, includePrerelease }, () => ({ current: "0.1.0", latest: mockReleases[0], hasUpdate: true })),
  install: async (repo: string, r: ReleaseInfo) => {
    if (isTauri) return invoke<void>("update_install", { repo, assetId: r.assetId, assetName: r.assetName, expectedSize: r.assetSize });
    for (let i = 1; i <= 20; i++) { await sleep(80); progressHandlers.forEach((h) => h({ downloaded: (r.assetSize * i) / 20, total: r.assetSize })); }
  },
  quit: () => (isTauri ? invoke<void>("app_quit") : Promise.resolve()),
  createRepo: (name: string, priv: boolean) => call<string>("release_repo_create", { name, private: priv }, () => "you/" + name),
  list: (repo: string) => call<RepoReleases>("release_list", { repo }, () => ({ exists: true, private: false, releases: mockReleases, totalSize: mockReleases.reduce((a, r) => a + r.assetSize, 0) })),
  remove: (repo: string, id: number, tag: string) => call<void>("release_delete", { repo, id, tag }, () => {}),
  installers: (dir: string) =>
    call<LocalInstaller[]>("release_find_installers", { dir }, () => [
      { path: dir + "\\Forge_0.2.1_x64-setup.exe", name: "Forge_0.2.1_x64-setup.exe", size: 3.9 * MB, modified: Date.now() - 600e3, version: "0.2.1" },
      { path: dir + "\\Forge_0.2.0_x64-setup.exe", name: "Forge_0.2.0_x64-setup.exe", size: 3.9 * MB, modified: Date.now() - day, version: "0.2.0" },
    ]),
  publish: async (repo: string, installer: string, version: string, notes: string, prerelease: boolean, overwrite: boolean, limitMb: number): Promise<PublishResult> => {
    if (isTauri) return invoke("release_publish", { repo, installer, version, notes, prerelease, overwrite, limitMb });
    const emit = (s: Step) => stepHandlers.forEach((h) => h(s));
    emit({ id: "check", state: "run", detail: "" }); await sleep(500); emit({ id: "check", state: "ok", detail: "4 个 Release，共 15.0 MB" });
    emit({ id: "prune", state: "run", detail: "" }); await sleep(600); emit({ id: "prune", state: "ok", detail: "已删除最旧的 1 个版本：v0.1.0" });
    emit({ id: "create", state: "run", detail: "" }); await sleep(500); emit({ id: "create", state: "ok", detail: "v" + version });
    emit({ id: "upload", state: "run", detail: "" }); await sleep(900); emit({ id: "upload", state: "ok", detail: "3.9 MB" });
    return { url: "#", deleted: ["v0.1.0"], totalAfter: 15.2 * MB };
  },
};

const progressHandlers = new Set<(p: { downloaded: number; total: number }) => void>();
export async function onDownloadProgress(h: (p: { downloaded: number; total: number }) => void) {
  if (isTauri) return listen<{ downloaded: number; total: number }>("update-progress", (e) => h(e.payload));
  progressHandlers.add(h);
  return () => progressHandlers.delete(h);
}
const stepHandlers = new Set<(s: Step) => void>();
export async function onReleaseStep(h: (s: Step) => void) {
  if (isTauri) return listen<Step>("release-progress", (e) => h(e.payload));
  stepHandlers.add(h);
  return () => stepHandlers.delete(h);
}

// ---------------------------------------------------------------- 本机设置
const K = "forge.update.";
export const updPrefs = {
  get: (k: string, d: string) => { try { return localStorage.getItem(K + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(K + k, v); } catch {} },
};
export const mbStr = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
