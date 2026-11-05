import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const rootPackage = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.join(here, 'src') },
  },
  define: {
    // 版本号在构建时注入，省掉运行时再去请求 app-meta.json
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标只覆盖支持 ESM 与现代 CSS 的浏览器，避免为旧语法额外转译
    target: 'es2022',
    rollupOptions: {
      // Cloudflare 构建环境限制为 1024 个文件句柄，为字体资源并行读取留出余量。
      maxParallelFileOps: 128,
      output: {
        // 依赖拆成稳定的长缓存块：业务代码更新时，React / 组件库的哈希不变。
        // motion 不在这里分组：它需要按「核心 + 异步 domMax」自动拆分。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('hls.js')) return 'hls';
          // Button 通过 Slot 组合子元素，首屏就要用；它只依赖 React 与 composeRefs
          if (id.includes('@radix-ui/react-slot') || id.includes('@radix-ui/react-compose-refs')) return 'react';
          if (
            id.includes('@radix-ui') || id.includes('@floating-ui') || id.includes('react-remove-scroll')
            || id.includes('use-callback-ref') || id.includes('use-sidecar') || id.includes('react-style-singleton')
            || id.includes('aria-hidden') || id.includes('get-nonce')
          ) return 'radix';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('sonner')) return 'sonner';
          if (
            id.includes('/react/') || id.includes('react-dom') || id.includes('react-router')
            || id.includes('@tanstack') || id.includes('zustand') || id.includes('scheduler')
          ) return 'react';
        },
      },
    },
  },
  server: {
    port: 5173,
    // 本地开发时把 /api 交给 wrangler dev
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
