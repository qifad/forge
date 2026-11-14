import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  // 轮询监听：杀毒软件/索引服务临时锁住目录时，原生监听会抛 EBUSY 并让开发服务器崩溃
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"], usePolling: true, interval: 300 } },
});
