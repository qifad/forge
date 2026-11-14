# Forge

面向 Claude 的 Windows 桌面项目指挥台。技术栈：Tauri 2 (Rust) + SolidJS。

## 运行

```bash
npm install
npx tauri dev        # 桌面窗口（读取真实的 ~/.claude 数据）
npm run dev          # 仅在浏览器中预览 UI（使用示例数据）
npx tauri build      # 生成 NSIS 安装包
```

> 如果编译时报 `os error 32`（文件被占用），说明杀毒软件或索引服务正在扫描 `target` 目录。
> 解决方法：把它加入排除列表，或者设置 `CARGO_TARGET_DIR` 指向一个较短的路径。

## 已完成（M1）
- 无边框窗口：Win11 使用 Mica，Win10 使用亚克力；自定义标题栏和窗口按钮
- 「深空玻璃」设计系统，支持深色和浅色主题
- `Ctrl+K` 命令面板，支持模糊搜索
- 从 `~/.claude/projects` 自动发现项目（会话数、最近活动时间）
- 近 14 天 Token 用量图表，以及缓存命中率
- Git 仓库概况：分支、领先/落后、已暂存/已修改/未跟踪
- 一键操作：在 Windows Terminal 中启动或继续 Claude、用 VS Code 打开、在资源管理器中显示

## 已完成（M2）
- **源代码管理**：变更列表（已暂存 / 更改）、并排行号 diff、**按块暂存 / 取消暂存**、丢弃（带确认）
- 提交（Ctrl+Enter）、修改上次提交；提交前自动扫描私钥、各类 API Key、.env、超大文件
- 历史：带车道的提交图谱（分支 / 合并 / 标签 / 远程引用）
- 分支：创建并切换、切换、检出远程分支；拉取（仅快进）/ 推送 / 获取；stash 存取
- **GitHub**：三种登录方式——导入 gh CLI、Device Flow（需自己的 OAuth App Client ID）、个人访问令牌；
  令牌存在 Windows 凭据管理器；推送时通过环境变量注入认证，不写进 .git/config
- **一键发布**：init → 补全 README / .gitignore（按项目类型取官方模板）/ LICENSE → 扫描 → 提交 → 创建仓库 → 推送，
  每一步实时显示进度；扫描到敏感内容会暂停并让你确认

## 已完成（M3）
- **会话**：浏览全部 Claude Code 会话（标题、轮数、tokens、模型、分支），全文搜索所有对话，
  回放完整对话（可切换显示工具调用 / 思考过程），一键在内置终端 `claude --resume`
- **用量**：5 小时窗口（估算）倒计时、每日用量（7/14/30/90 天）、按模型 / 项目占比、每周活跃时段热力图、Claude Code 记录的费用
- **记忆**：用户 / 项目 / 本地 CLAUDE.md 以及 Claude 自动记忆，内置模板、Ctrl+S 保存、估算占用的上下文
- **MCP**：读取三种作用域的服务器，`claude mcp list` 检测连接状态，通过官方 `claude mcp add/remove` 增删
- **配置**：settings.json 概览（模型、环境变量、权限、Hooks），名字含 TOKEN/KEY/SECRET 等的值一律不显示
- **提示词库**：带 `{{project}}` 等变量，一键输入到当前终端
- **内置终端**：ConPTY + xterm.js，多标签，切换页面不丢失，UTF-8 中文正常显示

## 已完成（M4）
- **检查点与改动审查**：给工作区（含未跟踪文件，遵守 .gitignore）拍快照，存在 `refs/forge/checkpoints/*`，
  不产生可见提交、不动分支和暂存区；从 Forge 启动 Claude 前自动创建。可查看此后的全部改动、
  逐个文件撤销、或整体恢复（恢复前自动再备份一次）
- **上下文打包**：文件树勾选（遵守 .gitignore / .claudeignore，排除二进制），实时 token 估算与 200K 预算条，
  导出 Markdown / XML，复制或保存到「下载」
- **项目地图**：语言占比、关键文件、目录结构，可让 Claude 补充模块说明，写入 CLAUDE.md 的标记区块（不影响手写内容）
- **AI 提交信息 / PR 描述**：通过本机 `claude -p` 生成（沿用 Claude Code 自己的登录，Forge 不接触密钥）；
  一键推送并在 GitHub 创建 PR（可设为草稿，已存在 PR 时会提示）
- **完成通知**：终端响铃或 Claude 持续输出后安静下来时弹出 Windows 通知，对应终端标签和侧边栏亮起提示点

## 已完成（M5：安装与自动更新）

### 发布一个新版本
```bash
npm run release -- patch      # 升级版本号（patch / minor / major / x.y.z），构建并把安装包复制到 release/
```
然后在 Forge「设置 → 发布新版本」：
1. 第一次使用时点「创建仓库」，在 GitHub 上新建发布仓库（建议公开），它会自动设为更新仓库
2. 选择 release/ 里的安装包，版本号自动从文件名读取，写好更新说明，点「发布」
3. 发布前会统计仓库里所有 Release 的总大小：若加上新安装包会超过「容量上限」，从最旧的版本开始删除（连同标签），
   直到放得下；只上传安装包这一个文件；上传失败会撤掉空的 Release

### 安装包的行为（`src-tauri/nsis/installer.nsi`，基于 Tauri 2.12.4 官方模板修改）
- 检测到已安装的旧版本时，默认选项是「**更新**」：原位覆盖、保留设置和数据，并跳过安装目录与开始菜单页面
- 第二个选项是「**重新安装**」：先卸载旧版本，再全新安装
- 同版本时可选择「覆盖重装」或卸载

### 软件内更新
「设置 → 软件更新」填写仓库 `owner/repo`（可开启启动时自动检查、接收预发布版本）。有新版本时标题栏会出现提示；
点「下载并安装」后，Forge 下载安装包并以 `/S /UPDATE /R` 运行——与手动双击安装包走同一套「检测到已安装 → 更新」逻辑，
只是没有界面：正在运行的 Forge 会被安装程序关闭，装完自动重新启动。私有仓库需要在 Forge 中登录 GitHub 才能下载。

## 性能
- Win10 不再使用 Acrylic（在 1903+ 上拖动 / 缩放窗口会卡顿，属已知问题），Win11 使用 Mica
- 背景极光用渐变绘制，常驻界面不使用实时背景模糊；拖动窗口时暂停背景动画
- 命令面板（Ctrl+K）→「开启低特效模式」可进一步关闭动画

## 测试

```bash
cd src-tauri && cargo test   # 状态解析、按块暂存、中文路径、密钥识别、会话解析、MCP 输出解析、UTF-8 分块
cargo test real_data -- --ignored --nocapture   # 用本机 ~/.claude 数据做冒烟测试（只输出数量）
```

## 目录
- `src-tauri/src/claude.rs`：会话日志解析、用量统计
- `src-tauri/src/git.rs`：Git 工作台（状态、diff、按块暂存、提交、分支、历史、同步、扫描）
- `src-tauri/src/github.rs`：GitHub 登录、仓库、一键发布
- `src/git.tsx`、`src/github.tsx`、`src/gitapi.ts`：对应前端页面与接口（含浏览器预览用的模拟数据）
- `src-tauri/src/system.rs`：调用终端、编辑器、资源管理器
- `src/`：前端（`App.tsx` 外壳，`views.tsx` 页面，`palette.tsx` 命令面板，`styles.css` 设计系统）

路线图见 Claude 中心 / Git / GitHub / AI 工具箱这几个页面（M2–M5）。
