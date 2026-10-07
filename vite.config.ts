import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,      // 👈 expone a la red
    port: 1420,      // 👈 puerto fijo
    strictPort: true // 👈 no cambie automáticamente
  }
})
