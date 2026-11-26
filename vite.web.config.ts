import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'website'),
  base: './',
  publicDir: path.resolve(__dirname, 'website/public'),
  build: {
    outDir: path.resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'website/index.html'),
        privacy: path.resolve(__dirname, 'website/privacy.html'),
      },
    },
  },
});
