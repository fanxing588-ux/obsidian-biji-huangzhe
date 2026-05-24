#!/usr/bin/env node
// ============================================================================
// release.mjs — 一键发版
//
// 流程:
//   1. 读 manifest.json 拿 version  → 用作 tag
//   2. 检查 git working tree 干净(避免发出未提交的代码)
//   3. 跑 npm run build               → 产出 main.js
//   4. 检查 main.js / manifest.json / styles.css 三件套存在
//   5. 用 gh CLI 创建 GitHub Release,上传三件套
//   6. (可选)更新 versions.json,加入当前版本 → Obsidian 兼容性元数据
//
// 用法:
//   1. 改 manifest.json 里的 version(如 0.3.0 → 0.4.0)
//   2. git commit
//   3. npm run release
//
// 依赖:
//   - 已 git init + 关联到 GitHub remote
//   - 已装 GitHub CLI(gh)并 `gh auth login` 过
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) die(`命令失败: ${cmd} ${args.join(" ")}`);
  return r;
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: true });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// ─── 1. 读 version ────────────────────────────────────────────────────
if (!existsSync("manifest.json")) die("manifest.json 不存在(请在插件根目录跑)");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const minAppVersion = manifest.minAppVersion;
if (!version) die("manifest.json 缺 version 字段");
console.log(`◇ 准备发版:v${version}(minAppVersion ${minAppVersion})`);

// ─── 2. 检查 git ──────────────────────────────────────────────────────
const git = runCapture("git", ["rev-parse", "--is-inside-work-tree"]);
if (!git.ok) die(
  "当前目录不是 git repo。先跑:\n" +
  "    git init\n" +
  "    git add .\n" +
  "    git commit -m \"initial\"\n" +
  "    gh repo create obsidian-biji-huangzhe --public --source=. --remote=origin --push\n"
);

const status = runCapture("git", ["status", "--porcelain"]);
if (status.stdout) {
  console.log("\n⚠ 有未提交改动:\n" + status.stdout);
  die("请先 commit 再发版(避免发出未提交的代码)");
}

const remote = runCapture("git", ["remote", "get-url", "origin"]);
if (!remote.ok) die("没有 origin remote。先 `gh repo create ... --push` 或 `git remote add origin <url>`");
console.log(`◇ remote: ${remote.stdout}`);

// 已经存在的 tag 拒绝重复发(避免 tag 冲突)
const tags = runCapture("git", ["tag", "-l", version]);
if (tags.stdout) die(`tag v${version} 已存在。先改 manifest.json 的 version 字段再发`);

// ─── 3. 检查 gh CLI ───────────────────────────────────────────────────
const ghVer = runCapture("gh", ["--version"]);
if (!ghVer.ok) die(
  "找不到 gh CLI。装一下:https://cli.github.com/\n" +
  "装完后跑 `gh auth login`"
);

const ghAuth = runCapture("gh", ["auth", "status"]);
if (!ghAuth.ok) die("gh CLI 未登录。跑:gh auth login");

// ─── 4. build ──────────────────────────────────────────────────────────
console.log("\n◇ 构建中...");
run("npm", ["run", "build"]);

for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(f)) die(`产物缺失:${f}`);
}
console.log("◇ 三件套就绪:main.js / manifest.json / styles.css");

// ─── 5. 更新 versions.json(Obsidian 用来知道每个版本要求的最低 app version) ───
const versionsPath = "versions.json";
let versions = {};
if (existsSync(versionsPath)) versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (!versions[version]) {
  versions[version] = minAppVersion;
  writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
  console.log(`◇ versions.json 加了 ${version} → ${minAppVersion}(需要 commit 进下一版)`);
}

// ─── 6. 打 tag + 推 ───────────────────────────────────────────────────
console.log(`\n◇ 打 tag ${version}...`);
run("git", ["tag", "-a", version, "-m", `v${version}`]);
run("git", ["push", "origin", version]);

// ─── 7. 创建 Release(上传三件套) ────────────────────────────────────
// 注意:BRAT 要求 release tag 名 = manifest version,assets 直接是 main.js / manifest.json / styles.css
console.log(`\n◇ 创建 GitHub Release v${version}...`);
run("gh", [
  "release", "create", version,
  "main.js", "manifest.json", "styles.css",
  "--title", `v${version}`,
  // 注意:--notes 不能有真换行,否则 Windows 下 shell:true 会把命令切断。
  "--notes", `自动发版 v${version}。通过 BRAT 安装的用户会自动收到更新。`,
]);

console.log(`\n✓ 发版完成:v${version}`);
console.log(`  用户那边 BRAT 会在下一次检查更新时拉到这个版本。`);
console.log(`  Release URL:`);
runCapture("gh", ["release", "view", version, "--web"]); // 不阻塞,只打印
console.log("\n下一步:");
console.log(`  1. 改 manifest.json 的 version(如 ${version} → ${bumpVersion(version)})`);
console.log(`  2. git add manifest.json versions.json && git commit -m "bump to ${bumpVersion(version)}"`);
console.log(`  3. 改代码、commit、再跑 npm run release`);

function bumpVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return v + ".1";
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;
}
