import { execSync } from 'child_process'

function getBuildVersion() {
  if (process.env.BUILD_VERSION) return process.env.BUILD_VERSION
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

process.env.BUILD_VERSION = getBuildVersion()

/**
 * @type {import('electron-builder').Configuration}
 */
export default {
  appId: 'cafe.kirameki.discord-presence-relay',
  productName: 'Discord Presence Relay',
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!Casks/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!electronBuilder.mjs',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml,pnpm-workspace.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  asarUnpack: ['resources/**'],
  win: {
    executableName: 'discord-presence-relay'
  },
  nsis: {
    artifactName: '${name}-${env.BUILD_VERSION}-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
    notarize: false
  },
  dmg: {
    artifactName: '${name}-${env.BUILD_VERSION}.${ext}'
  },
  linux: {
    target: ['AppImage', 'deb'],
    maintainer: 'electronjs.org',
    category: 'Utility',
    artifactName: '${name}-${env.BUILD_VERSION}.${ext}'
  },
  npmRebuild: false,
  publish: {
    provider: 'generic',
    url: 'https://example.com/auto-updates'
  }
}
