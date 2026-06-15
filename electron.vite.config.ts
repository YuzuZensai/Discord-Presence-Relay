import { execSync } from 'child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function getCommitHash(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim()
    const dirty = execSync('git status --porcelain').toString().trim().length > 0
    return dirty ? `${hash}-dirty` : hash
  } catch {
    return 'unknown'
  }
}

const commitHash = JSON.stringify(getCommitHash())

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __COMMIT_HASH__: commitHash
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [tailwindcss(), react()]
  }
})
