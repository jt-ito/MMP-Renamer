import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // DISABLED for debugging - re-enable after fixing cache issue
        drop_debugger: false,
        pure_funcs: []
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'vendor': ['axios', 'react-window']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  }
})
