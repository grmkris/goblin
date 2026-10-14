import type { ElectrobunConfig } from './.hutch/devkit/api/config/ElectrobunConfig'
export default {
  app: { name: 'Goblin Electrobun Spike', identifier: 'dev.goblin.desktop.electrobun', version: '0.1.0' },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'src/bun/index.ts' },
    copy: {},
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
