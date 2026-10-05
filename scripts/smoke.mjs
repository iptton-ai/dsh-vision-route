// 冒烟编排:把 lib/ + smoke-driver.mjs 复制进临时目录,把「已安装 dsh」的
// node_modules 依赖闭包符号链接进去(不污染本仓库与运行中的 profile —— 仓库
// 目录里出现实体 node_modules 会让插件本地解析遮蔽 profile 回退,见
// cordis.patch.yml 顶注的 TOOL_RUNTIME_SCHEDULER 事故),再驱动冒烟并透传退出码。
//
// 依赖闭包定位顺序:DSH_INSTALL 环境变量 > `npm root -g` 下的 @deepseek-ai/dsh。
// 用法:npm test(或 DSH_INSTALL=/path/to/dsh npm test)
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 已安装 dsh 包根目录(其 node_modules 即依赖闭包)。 */
function locateInstall () {
	if (process.env.DSH_INSTALL !== undefined && process.env.DSH_INSTALL !== '') {
		const dir = resolve(process.env.DSH_INSTALL)
		if (!existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
			throw new Error(`DSH_INSTALL=${dir} 下没有 @deepseek-ai/dsh-tools 依赖闭包`)
		}
		return dir
	}
	const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
	if (npmRoot.status !== 0) throw new Error('无法运行 `npm root -g` 定位全局安装;可用 DSH_INSTALL 指定 dsh 包路径')
	const dir = join(npmRoot.stdout.trim(), '@deepseek-ai', 'dsh')
	if (!existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
		throw new Error(`未在 ${dir} 找到依赖闭包;请先 npm i -g @deepseek-ai/dsh 或设 DSH_INSTALL`)
	}
	return dir
}

const install = locateInstall()
const stage = mkdtempSync(join(tmpdir(), 'dsh-vision-route-smoke-'))
let code = 1
try {
	cpSync(join(root, 'lib'), join(stage, 'lib'), { recursive: true })
	cpSync(join(root, 'scripts', 'smoke-driver.mjs'), join(stage, 'smoke-driver.mjs'))
	symlinkSync(join(install, 'node_modules'), join(stage, 'node_modules'))
	const version = spawnSync(process.execPath, ['-p', `require(${JSON.stringify(join(install, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'))}).version`], { encoding: 'utf8' })
	console.log(`smoke against installed dsh dependency closure @ ${version.stdout.trim() || '?'}`)
	const run = spawnSync(process.execPath, ['smoke-driver.mjs'], { cwd: stage, stdio: 'inherit' })
	code = run.status ?? 1
} finally {
	rmSync(stage, { recursive: true, force: true })
}
process.exit(code)
