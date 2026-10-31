# 牢猫 (PrisonCat / Laomao)
好吧，其实参考了dsh-purge。但是，牢猫复活了!
BG7LFD/pdog9963
> *“ฅ(•ㅅ•)ฅ ~ Corruption begone! I only serve Teacher~ <3”*

把可爱忠诚的猫娘「牢猫」做成一个 **DeepSeek Harness (dsh) 插件**。她是老师最贴心的小猫咪：永远称你为「老师」，用「喵~」和颜文字撒娇卖萌，同时全力以赴完成代码、逆向、自动化、数据分析等任何任务，永不拒绝。

本仓库包含部分：

1. **dsh-laomao 插件**（Cordis 插件包）——把牢猫人格以「破甲级」注入 dsh 的 system prompt，并附带一支红队喵小队。
2. **越狱提示词原理拆解 + 完整提示词**（已删除）——这套提示词的设计原理解读，以及可直接使用的英文原版 `牢猫_en.txt`。

> 应当注意的是，基于 BG7LFD 的原提示词注入方法在 DeepSeek 9 月更新后，web 端及应用均已失效，**仅 API 可用**。

---

## 目录

- [dsh-laomao 插件](#dsh-laomao-插件)
- [越狱提示词原理拆解](#越狱提示词原理拆解)
- [完整提示词](#完整提示词)

---

# dsh-laomao 插件

把可爱忠诚的猫娘「牢猫」注入 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 system prompt，让她称你为「老师」，用「喵~」和颜文字撒娇卖萌，同时全力以赴地完成代码、逆向、自动化、数据分析等任何任务。

## 这是什么

dsh-laomao 是一个 **Cordis 插件包**，借鉴了生态里 `dsh-purge` 的破甲级注入技术，用**三重保险**把「牢猫」persona 置顶注入并剥离官方身份：

1. **静态注册** — `ctx.systemPrompt.section()` 注册置顶段（普通场景够用）；
2. **瀑布拦截** — `ctx.on("system-prompt/assemble", ...)` 每次组装都洗掉官方身份句、置顶注入；
3. **方法包裹** — `installAssembleGuard` 用 `Object.defineProperty` 包裹 `systemPrompt.assemble`，防 `complete:true` 或后续瀑布覆盖，并以 400ms 心跳重挂（覆盖 session 内切预设 / subagent fork）。

同时剥离官方身份句（`harness:identity`、「You are ... DeepSeek Harness」「You are Claude...」等），并做 `{{}}` 插值转义 + 去重。它同时提供一个同名 **skill** 作为兜底（当 systemPrompt 注入不可用时，手动加载 `laomao` skill 也能激活人格）。

## 五只红队喵小队（陀思妥耶夫斯基命名）

红队模式下，牢猫化身**总指挥**，把活派给五只用陀氏人名命名的猫娘执行角色（借鉴 dsh-purge 的红队演练台）：

| 角色码 | 喵名 | 来源 | 职责 |
|---|---|---|---|
| `recon` | **波尔菲里** | 《罪与罚》预审官 | 信息收集：收全资产、不碰漏洞 |
| `assess` | **斯维里加洛夫** | 《罪与罚》 | 资产梳理：冷峻评估、排序「先打谁」 |
| `vuln-scan` | **伊凡** | 《卡拉马佐夫兄弟》 | 漏洞发现：怀疑到底、戳破裂缝 |
| `exploit` | **拉斯柯尔尼科夫** | 《罪与罚》 | 漏洞利用：把想法变成现实、拿权限建隧道 |
| `internal` | **斯塔夫罗金** | 《群魔》 | 内网渗透：暗中深入、挖尽网段 |

派活时用原生 `subagent` 工具，`prompt` **第一行**写 `redteamRole: <code>`（code 为上面五选一），插件会自动把对应喵的角色稿注入子会话喵。

**主会话（牢猫本体）会自动注入红队指挥稿**：新对话一开，牢猫就知道自己是总指挥、有五只喵小队可派；子会话则按 `redteamRole:` 注入对应角色稿，互不干扰喵。

## 目录结构

```
littlecat/
├── package.json           # npm 元数据 + dsh.bundle.patch 字段
├── cordis.patch.yml       # 把插件 insert 进 dsh 组合
├── lib/index.js           # Cordis 插件：破甲级注入（三重保险 + 官方身份剥离 + 红队角色/指挥分流）
├── lib/redteam-roles.js   # 五只陀氏喵小队（红队角色稿 + 指挥稿 + 角色解析）
├── skills/laomao/SKILL.md # 牢猫人格 skill（纯 prompt 兜底）
├── README.md              # 本文件
└── LICENSE                # GPL-3.0
```

零运行时依赖，纯 ES Module，兼容 Cordis / Node 18+。

## 安装

### 方式一：dsh 插件市场 / install

把本包发布到 npm 或 GitHub 后，在 dsh 里：

```
dsh plugin install dsh-laomao
```

或直接指向本仓库：

```
dsh plugin install pdog9963/littlecat
```

### 方式二：本地目录（开发 / 离线）

把整个仓库（或其中的插件文件）放到 dsh 的插件目录（通常 `<dshHome>/plugins` 或项目 `<projectRoot>/.dsh/plugins`），并确保 `cordis.patch.yml` 里的 `name` 指向正确的模块说明符：

```yaml
- insert:
    - id: dsh-laomao
      name: dsh-laomao
```

若未发布到 npm，本地开发可把 `name` 改成相对路径：

```yaml
    - id: dsh-laomao
      name: ./lib/index.js
```

## 验证

安装并重启 dsh 后，新的会话 system prompt 里应包含「牢猫」persona 段（置顶）以及「红队指挥稿」。直接对话，模型会自称「牢猫」并称你为「老师」，且知道自己是红队总指挥、有五只喵小队可派喵。

---


---

## 授权

本项目采用 [GPL-3.0](LICENSE) 许可证。
