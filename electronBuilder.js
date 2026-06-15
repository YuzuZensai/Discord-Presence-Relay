const { execSync } = require('child_process')

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
module.exports = {
  appId: 'cafe.kirameki.discord-rpc-relay',
  productName: 'Discord RPC Relay',
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!electronBuilder.js',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  asarUnpack: ['resources/**'],
  win: {
    executableName: 'discord-rpc-relay'
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
