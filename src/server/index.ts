import express from 'express';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from './routes';
import {AnalyzerService} from './analyzer';
import {Store, defaultDBPath} from './store';
import {seedIfEmpty} from './seed';

const PORT = Number(process.env.PORT ?? 4174);
const HOST = process.env.HOST ?? '127.0.0.1';

export function buildServer(dbFile?: string) {
  const file = dbFile ?? process.env.STUDIO_DB ?? defaultDBPath();
  const store = new Store(file);
  seedIfEmpty(store);
  const analyzer = new AnalyzerService(store);
  const app = createApp({store, analyzer});

  // 生产环境把 vite build 的产物直接挂出来（相对本文件定位，与启动目录无关）
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '..', 'client');
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }
  return {app, store};
}

// 同时兼容 tsx 直跑（src/server/index.ts）和 ESM 产物（dist/server/index.mjs）
const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('src/server/index.ts') || entry.endsWith('dist/server/index.mjs')) {
  const {app} = buildServer();
  app.listen(PORT, HOST, () => {
    console.log(`Schema Evolution Studio: http://${HOST}:${PORT}`);
  });
}
