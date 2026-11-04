# 砚台 · Inkstone

**本地起笔，云端成书。**

把 DSH 里正在写的 LaTeX 项目同步到 [中国科技云论文协同编辑服务](https://latex.cstcloud.cn)（CSTCloud Overleaf），在服务器上编译，把编译诊断原样带回 DSH——本地**不需要安装任何 TeX 环境**。

> 砚台不替人执笔，只把素材研成可用的样子。

> **两个形态**：这是带可视化面板的 **DSH 插件**。如果你希望智能体直接读写编译诊断、不需要点按钮，用 [inkstone-skill](https://github.com/KeNan2025/inkstone-skill)（skill 形态，零依赖 CLI）。两者可以同时装，共用同一个 Overleaf 账号。

---

## 安装

```sh
dsh plugin --profile web add github:KeNan2025/inkstone
```

装好后刷新 DSH 页面，左侧面板栏会出现一方石砚图标，点开即是工作台。

**环境要求**：DSH `>= 0.2.1-rc.2`，Node `^22.19` 或 `>= 24`。

---

## 它做什么

一条闭环：

```
本地编辑 .tex  →  同步并编译  →  服务器编译  →  错误回传  →  智能体修改  →  再同步
```

- **同步**：把项目文件夹打包上传到指定的 Overleaf 项目。
- **编译**：在服务器上编译，本地无需 TeX。
- **回传**：编译日志被解析成结构化错误（类型、原文、上下文行），面板直接展示，智能体也能读取同一条响应。
- **替换**：同名项目会被新版本替换，仪表盘上始终只有一个，不会越积越多。

---

## 第一次使用

### 1. 接入云端

latex.cstcloud.cn 使用 **CSTCloud 统一身份认证（SSO）**。这类账号通常**没有本地密码**（重置密码页面会提示 *your group or organization uses SSO*），所以插件复用浏览器的登录态：

1. 浏览器打开 <https://latex.cstcloud.cn/project>，确认已登录
2. `F12` → **Application** → **Cookies** → `https://latex.cstcloud.cn`
3. 找到 **`overleaf.sid`**，双击 Value 全选复制
4. 粘贴进面板，点「保存并验证」

只复制 Value、整行 `overleaf.sid=…`、或带属性的完整行都可以。保存前插件会**真实访问一次站点验证**，失效当场报错，不会覆盖原来能用的那份。

> Cookie 只保存在本机 DSH 进程（`credentials` 服务，或 `~/.dsh/overleaf-workbench/session.json`，权限 0600）。不回传浏览器，不写进对话记录。有效期约 **5 天**。

### 2. 选材并研墨

1. 选择 LaTeX 项目文件夹（可用「浏览…」，或从已打开的工作区里选）
2. 面板会显示识别到的文件数、体积与主文件
3. 点「**同步并编译**」，等待约一分钟

主文件（`main.tex` 优先）与编译器（XeLaTeX）由插件自动识别，不需要手动设置。

### 3. 看结果

成功：显示「编译成功」、用时、远端项目名，并可「在 Overleaf 打开」。

失败：按类型列出错误，例如

```
ERROR     ! Undefined control sequence.
          ctx: l.113  \setCJKmainfont {SimSun}[AutoFakeBold=3,ItalicFont=KaiTi]
WARNING   LaTeX Warning: There were undefined references.
```

把这份诊断交给 DSH 里的智能体，它会改源文件；改完再点一次「同步并编译」。

---

## 实现要点

- **同源反向代理已弃用**：这个部署的 WebSocket upgrade 注册表在插件重载后返回 `duplicate`，注入脚本也被页面策略拦截，因此不内嵌编辑器，只做同步与编译。
- **编译器必须单独设置**：从 zip 创建的项目继承站点默认编译器（pdfLaTeX）。编译请求 body 里的 `compiler` 只是建议值，必须 `POST /project/:id/settings {compiler:"xelatex"}` 才会真正切换——否则所有中文字体集都会报 `!pdfTeX error`。
- **同步是重建而非增量**：`POST /Project/:id/upload` 需要任何 API 都不暴露的根目录 id（返回 422 `folder_not_found`），逐文件删除路由也不存在，Git Bridge 未配置公开地址。所以采用「同名重建 + 删旧」，新项目创建成功后才删除旧项目。

---

## 已知限制

- **同步是重建**：每次同步生成新的项目 id（名字不变）。若在网页上手动改过内容，下次同步会被本地覆盖。
- **产物不落本地**：PDF 留在远端，面板提供「在 Overleaf 打开」。
- **耗时**：单次同步约 30–60 秒（上传 + 编译），编译超时上限 5 分钟。
- **仅支持 latex.cstcloud.cn**：上游地址固定在 Host 半，不对用户开放，避免把代理变成任意目标。

---

## 结构

| 路径 | 说明 |
|---|---|
| `index.js` | Host 半：`/api/dsh-overleaf` 路由、会话存储、同步编排 |
| `client.js` | Client 半：侧栏图标 + 工作台面板 |
| `lib/sync-client.js` | 建项目、设编译器、socket 级读取编译结果、日志解析 |
| `lib/overleaf-client.js` | 协议客户端（会话导入、zip 上传、项目 CRUD） |
| `cordis.patch.yml` | Bundle patch，插入 `inkstone` 插件行 |
| `tests/` | 单元与集成测试 |

### 测试

```sh
node tests/sync-test.mjs        # 日志解析与响应拆分
node tests/host-test.mjs        # Host 路由与围栏
node tests/session-e2e.mjs      # 会话导入 → 编译 → 取回
node tests/contrast-audit.mjs   # 配色对比度
node tests/probe.mjs --all      # 协议层自测
```

---

## License

MIT © KeNan2025