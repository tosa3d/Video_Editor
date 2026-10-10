import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Packaged Electron pages load over file://, so production assets must be relative.
  base: './',
  plugins: [react()],
})
