# 发版流程(给开发者看的)

终端用户走 BRAT 一键安装(见 README.md),不需要看这个。

---

## 🚀 懒人速查(发新版就看这一段)

**第一步 · 走到这个目录**(发版必须在这个目录跑,别跑错):

```powershell
cd C:\Users\刘洋\Desktop\笔记拾荒者\plugin
```

**第二步 · 改版本号**

打开 `manifest.json`,把 `"version": "0.3.0"` 改成新版本(比如 `"0.4.0"`)。

**第三步 · 提交代码改动**

```powershell
git add -A
git commit -m "v0.4.0: <一句话讲改了啥>"
git push
```

⚠ `git commit` 如果报 "Please tell me who you are",用下面这条带身份的:
```powershell
git -c user.email="BenitaCashyin@salesperson.net" -c user.name="刘洋" commit -m "v0.4.0: ..."
```

**第四步 · 一键发版**(就一条,复制粘贴整行)

```bash
PATH="/c/Program Files/GitHub CLI:$PATH" GIT_AUTHOR_NAME="刘洋" GIT_AUTHOR_EMAIL="BenitaCashyin@salesperson.net" GIT_COMMITTER_NAME="刘洋" GIT_COMMITTER_EMAIL="BenitaCashyin@salesperson.net" npm run release
```

⚠ 这条**必须在 bash 里跑**(Claude Code 默认 bash;Git Bash 也行),PowerShell 不认 `PATH=... cmd` 这种内联环境变量语法。

**这条长命令为什么这么长?**
- `PATH="/c/Program Files/GitHub CLI:$PATH"`:gh CLI 没装到系统 PATH 里(winget 装的程序,新 shell 才能识别),临时塞进 PATH
- `GIT_AUTHOR_*` / `GIT_COMMITTER_*`:这个 repo 没设 git user(为了不动你的全局 git config),发版脚本里的 `git tag` 需要

**发版完事会输出**:
- `✓ 发版完成:v0.4.0`
- Release URL:`https://github.com/fanxing588-ux/obsidian-biji-huangzhe/releases/tag/0.4.0`

之后用户那边 BRAT 会在下一次检查更新时(默认 1 小时)拉到新版,自动提示更新。

---

## 仓库基本信息

| 项 | 值 |
|---|---|
| GitHub | https://github.com/fanxing588-ux/obsidian-biji-huangzhe |
| 本地路径 | `C:\Users\刘洋\Desktop\笔记拾荒者\plugin\` |
| gh CLI 路径 | `C:\Program Files\GitHub CLI\gh.exe` |
| BRAT 安装路径 | `fanxing588-ux/obsidian-biji-huangzhe` |
| 当前版本 | 见 `manifest.json` 的 `version` 字段 |

---

## 历史背景(下面是首次发版的完整步骤,以后不用看)

## 首次:把仓库放上 GitHub

```powershell
cd C:\Users\刘洋\Desktop\obsidian-biji-huangzhe

git init
git branch -M main
git add .
git status              # ← 看一眼,确认没有 data.json / embeddings.bin / API key 类文件被加进来
git commit -m "initial: 笔记拾荒者 v0.3.0"

# 装 gh CLI(只要一次):https://cli.github.com/  装完跑 `gh auth login`
gh repo create obsidian-biji-huangzhe --public --source=. --remote=origin --push
```

> ⚠ **隐私检查**:首次 commit 前,务必确认 `data.json` 没进 git(已 .gitignore)。
> data.json 里有明文 API key + 笔记 embedding,push 上 GitHub 会泄密。
>
> 检查命令:`git ls-files | findstr data.json`(应该没输出)

仓库可以选 public 或 private:
- **public**:BRAT 用户可以直接拉取,这是默认选择
- **private**:BRAT 也能拉,但用户需要登录 GitHub 才能装。门槛高,只推荐你想限制谁能用的时候选

repo 名可以自定义,但要跟 BRAT 装的时候用的路径一致(README 里那个例子)。

## 之后每次发版

```powershell
# 1. 改 manifest.json 里 "version": "0.3.0" → "0.4.0"
# 2. 改完你想发的代码,跑一遍本地验证
npm run build

# 3. commit
git add -A
git commit -m "v0.4.0: <一句话讲改了啥>"
git push

# 4. 一键发版
npm run release
```

`npm run release` 做了什么:

1. 检查 git working tree 干净(避免发出未提交的代码)
2. 检查没有重名 tag
3. 跑 `npm run build` 产出 main.js
4. 更新 versions.json(把当前 version 加进去)
5. 打 git tag + 推到 origin
6. 用 gh CLI 创建 GitHub Release,自动上传 `main.js / manifest.json / styles.css`

之后:用户那边 BRAT 在下一次自动检查(默认每小时一次,也可以手动点 "Check for updates")时会拉到新版,提示用户更新。

## 紧急回滚

如果某个 release 出了大问题:

```bash
# 删除 GitHub Release(BRAT 就拉不到这个版本了)
gh release delete 0.4.0 --yes --cleanup-tag

# 改 manifest.json 把 version 退回上一版,告诉用户在 BRAT 里 reinstall
```

BRAT 不会自动降级,需要用户手动 reinstall。所以**发版前一定本地实测一遍主路径**:索引一篇笔记 → 搜索 → 卡片正常显示。
