import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import basicSsl from "@vitejs/plugin-basic-ssl";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    basicSsl()
  ],
  server: {
    host: "0.0.0.0",
    https: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        // target: "http://localhost:8000",
        // target: "http://10.227.27.212:8000",
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/socket.io": {
        // target: "http://localhost:8000",
        // target: "http://10.227.27.212:8000",
        target: "http://127.0.0.1:8000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
})