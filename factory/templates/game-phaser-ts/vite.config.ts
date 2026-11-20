import { defineConfig } from 'vite';
import { playgamaBridge } from '@playgama/bridge/vite';

// Playgama: relative paths (rule 1.3.2), Bridge injected by the official plugin
// (CDN with automatic local fallback; the runtime file ships inside the build).
export default defineConfig({
  base: './',
  plugins: [playgamaBridge()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
