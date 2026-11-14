// 构建发布版安装包：可选地升级版本号 → tauri build → 把安装包复制到 release/
// 用法：
//   npm run release            # 使用当前版本号
//   npm run release -- patch   # 0.1.0 → 0.1.1（也可用 minor / major / 1.2.3）
// 构建完成后，在 Forge「设置 → 发布新版本」里选择安装包上传到 GitHub。
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const arg = process.argv[2];

function bump(v, kind) {
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(kind)) return kind;
  const [maj, min, pat] = v.split("-")[0].split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`无法识别的版本参数：${kind}（可用 patch / minor / major / x.y.z）`);
}

let version = conf.version;
if (arg) {
  version = bump(conf.version, arg);
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const cargoPath = join(root, "src-tauri", "Cargo.toml");
  writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
  console.log(`版本号已更新为 ${version}`);
}

console.log(`正在构建 Forge ${version} …`);
execSync("npx tauri build", { cwd: root, stdio: "inherit" });

const target = process.env.CARGO_TARGET_DIR || join(root, "src-tauri", "target");
const name = `${conf.productName}_${version}_x64-setup.exe`;
const built = join(target, "release", "bundle", "nsis", name);
if (!existsSync(built)) throw new Error(`没有找到安装包：${built}`);
mkdirSync(join(root, "release"), { recursive: true });
copyFileSync(built, join(root, "release", name));
console.log(`\n✓ 安装包已复制到 release/${name}`);
console.log("  下一步：打开 Forge →「设置」→「发布新版本」上传到 GitHub");
