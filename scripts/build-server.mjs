// 用 esbuild 把 Express 服务端连同 core 打成单个 CJS 包（express 保持 external）。
import {build} from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server/index.mjs',
  sourcemap: true,
  external: ['express'],
  logLevel: 'info',
});
