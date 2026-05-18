import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function assertProductionEnv(env) {
  return {
    name: 'assert-production-env',
    buildStart() {
      if (env.VITE_APP_ENV === 'production' && !env.VITE_API_BASE) {
        throw new Error(
          'VITE_API_BASE must be set in .env.production — refusing to build without a backend URL'
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
  plugins: [react(), assertProductionEnv(env)],
  server: { port: 3000, open: true },
  build: {
    target: 'es2020',
    outDir: 'dist',
    // Never ship source maps in production — they expose business logic to clients
    sourcemap: mode === 'development',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: mode === 'production',
        passes: 2,
      },
    },
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
  }
})
