// 把 lib/client-src.js 包成 __ModuleLoader__ 注册形态写入 lib/client.js。
// 工厂内只能 require 静态注册表模块(react),不能出现裸 import/export;
// apply/inject 声明留在 client-src.js 结尾,这里只负责包壳。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'lib/client-src.js'), 'utf8')

const bundle = `\
// 由 scripts/build-client.mjs 生成 —— 编辑 lib/client-src.js 后重跑构建。
window.__ModuleLoader__.load({
  id: 'dsh-vision-route',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
${src}
    return module.exports
  },
})
`

writeFileSync(join(root, 'lib/client.js'), bundle)
console.log('lib/client.js written:', bundle.length, 'bytes')
