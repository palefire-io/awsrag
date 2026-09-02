import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// served at the orchestrator's app root ("/"), not a sub-path
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
