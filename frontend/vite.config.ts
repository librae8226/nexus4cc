import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../frontend/dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('react') || id.includes('react-dom')) {
            return 'vendor'
          }
          if (id.includes('@xterm/xterm') || id.includes('@xterm/addon-fit') || id.includes('@xterm/addon-web-links')) {
            return 'xterm'
          }
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:59000',
      '/ws': {
        target: 'ws://localhost:59000',
        ws: true,
      },
    },
  },
})
