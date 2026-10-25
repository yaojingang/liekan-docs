# 猎看文档系统

上传 HTML、PDF 和 Word，生成可分享的文档短链接，集中管理阅读、编辑与访问权限。

本项目独立发展自 [TokDoc](https://github.com/yaojingang/yao-open-tools/tree/main/tools/TokDoc)，使用 [MIT 许可证](LICENSE)。仓库地址：[yaojingang/liekan-docs](https://github.com/yaojingang/liekan-docs)。

## 功能

- **文档首页**：顶部 LOGO 与导航、居中搜索、可点击分类的公开文档统计和最近更新的 6 份文档。
- **资源列表**：按名称或文件名搜索，支持分类、排序和分页；显示资源名称、更新日期、类型、操作，日期格式为 `YYYY-MM-DD`，整行可点击阅读。
- **上传工作区**：上传单个或多个文件，或导入含图片、CSS、JS 的目录；在当前页的居中宽屏弹窗内核对信息、设置权限并确认入库，完成后可直接打开文档或继续上传。单个文件最大 20 MiB。
- **HTML 编辑**：在原文页面内编辑、自动保存、记录版本并恢复历史内容。
- **PDF 和 Word 阅读**：PDF 直接打开阅读器，Word 先转换为 PDF；这两类文档不提供 HTML 在线编辑和版本恢复。
- **访问控制**：首页可见、仅链接可见、私有三种访问方式，公开文档可另设阅读密码。
- **后台管理**：目录监听、回收站与恢复、站点与 SEO 设置、统计代码、自定义后台地址，以及 HTML 向同类服务同步。
- **数据分析**：后台首页展示今日与累计浏览量；左侧“数据分析”提供近 7、30、90 天浏览趋势、每日明细、累计与今日 Top 10、类型分布及核心指标。两个排行均提供独立的完整明细页，每页 20 条，显示精确次数并支持分页。

## Docker 启动

需要 Docker Engine 和 Docker Compose v2。镜像包含 Word 转 PDF 所需的 LibreOffice Writer 和中文字体。

```bash
git clone https://github.com/yaojingang/liekan-docs.git
cd liekan-docs
cp .env.example .env
```

首次启动前，编辑 `.env` 中的 `TOKDOC_INITIAL_PASSWORD`，然后启动：

```bash
docker compose up -d --build
```

| 入口 | 默认地址 |
| --- | --- |
| 文档首页 | http://127.0.0.1:18082/ |
| 全部资源 | http://127.0.0.1:18082/?view=resources |
| 后台上传工作区 | http://127.0.0.1:18082/admin |
| 健康检查 | http://127.0.0.1:18082/healthz |

默认只绑定本机地址。通过域名访问时，用 Nginx 或宝塔反向代理到该端口，按[部署指南](docs/deploy-docker.md)配置 HTTPS 和受信代理。

默认持久化目录：

- `data/`：SQLite、原文件、附件、生成页面、版本和回收站。
- `html-inbox/`：默认监听目录，容器内地址为 `/watch/html-inbox`。

## 本机 Node.js 启动

使用 Node.js 22.13 或更新版本。Word 转换还需安装 LibreOffice，并确保 `soffice` 在 PATH 中，或通过 `TOKDOC_SOFFICE_BIN` 指定路径。

```bash
npm ci
npm run dev
```

本机默认首页为 http://127.0.0.1:8080/，后台为 http://127.0.0.1:8080/admin。

开发命令通过进程环境读取配置，不会自动加载 `.env`。可通过环境变量设置首次登录信息：

```bash
TOKDOC_INITIAL_USERNAME=admin TOKDOC_INITIAL_PASSWORD='replace-with-a-long-password' npm run dev
```

未设置初始账号时，空数据库默认使用 `admin` / `tokdoc`。已有数据库继续使用原账号，初始账号环境变量不会重置旧密码。登录后可在“系统设置 → 账号与安全”中修改账号和后台地址。

## 上传和阅读

1. 进入后台默认的“上传文档”页，选择文件或导入目录。
2. 在当前页弹窗中核对标题、文件名与访问设置，点击“确认入库”。取消会清理本次暂存；若提示结果需要核对，先检查已入库列表。
3. 入库完成后，弹窗显示结果，可打开文档、继续上传，或点击“查看文档”进入管理列表并复制短链接。关闭结果弹窗会返回原页面。前台列表和推荐只包含首页可见的公开文档。
4. HTML 可从后台进入编辑模式，编辑后自动保存并保留版本。PDF 和 Word 使用阅读器打开。
5. “移入回收站”会暂停原链接访问；恢复文档后可继续访问。删除和恢复不等同于恢复编辑版本。

“系统设置”使用顶部 Tab 分组，保存按钮会保存各分组的当前设置。目录添加、扫描和移除独立执行，移除监听不会删除已经生成的文档。

“系统设置 → 前台导航”支持添加、编辑、停用、删除自定义菜单，通过上移、下移调整顺序，并预览启用菜单的排列。菜单支持站内路径、HTTP/HTTPS 外部链接及新标签页打开，包含内置“全部文档”在内最多 10 项。保存后刷新前台生效；内置入口保持显示并可排序，打开时清除关键词和分类。电脑端空间不足或使用手机时，其余菜单按配置顺序收进右上角“更多”。“站点信息与 SEO”可修改 LOGO 文字、副标题和图片；支持上传 PNG、JPG、WebP（最大 2 MiB）或填写图片地址，提供即时预览和恢复默认图标，保存后刷新前台生效。副标题留空可隐藏。

浏览量（PV）按成功打开文档的 GET 阅读请求累计，刷新和重复阅读会计数；编辑模式、密码验证页、HEAD、附件和失败请求排除。每日统计按浏览器时区划分，开始记录前的日期显示“未记录”，历史累计浏览次数继续保留。日均按所选时段内已记录的自然日计算，开始记录当天为部分时段。统计包含私有、仅链接及回收站文档的历史阅读，文档移入回收站后仍保留次数。不采集访客身份或 IP，不提供访客人数（UV）。

## 访问方式与阅读密码

| 访问方式 | 首页、搜索和统计 | 短链接访问 |
| --- | --- | --- |
| 公开 · 首页可见 | 显示 | 可访问，可另设密码 |
| 公开 · 仅链接可见 | 隐藏 | 获得链接的人可访问，可另设密码 |
| 私有 · 管理员可见 | 隐藏 | 需要管理员登录 |

仅链接可见用于控制展示范围。限制阅读时，另设访问密码或选择私有。关闭“公开首页”会关闭首页、分类和公开列表 API，文档短链接继续按各自权限访问。

阅读密码为 6 至 128 个字符，服务器保存加盐哈希。正确验证后，浏览器保存随机 HttpOnly 授权 Cookie。选择记住时可保留 400 天并在阅读时续期，取消记住时有效期为 2 小时。密码原文不保存在 Cookie 中。更换密码、转私有、删除文档或管理员撤销授权后，需要重新验证。

HTML、PDF、Word、原始文件和附件都检查文档权限。共享附件的访问限制冲突时，需要统一权限，或整理独立目录后重新导入。受限文档暂不支持上传线上。

导入的 HTML 可包含脚本，并保留原文排版。请在受信任的团队和文档来源范围内使用；公开域名承载的 HTML 与管理工作台共享站点来源。

## 数据与兼容

环境变量沿用 `TOKDOC_*`，并兼容部分旧 `TOKHTML_*` 配置。数据库、Cookie 和编辑标记保留旧协议兼容。

```text
data/tokdoc.db        数据库；已有 tokhtml.db 时可继续使用旧库
data/brand/         上传的 LOGO 图片
data/uploads/       原文件和目录附件
data/pages/         生成的 HTML、PDF 或 Word 阅读版本
data/versions/      HTML 版本快照
data/trash/         回收站
html-inbox/          默认监听目录
```

本机启动会兼容探测同级 `TokHtml/data/tokhtml.db`；Docker 只读取实际挂载的数据目录。迁移时保留容器内路径，并在数据副本上验证。备份与回滚要求见[部署指南](docs/deploy-docker.md#备份与恢复)。

## 开发与测试

```bash
npm ci
npm test
docker compose --env-file .env.example config --quiet
```

GitHub Actions 会在推送 `main` 或提交 Pull Request 时运行 Node.js 22 测试、校验 Compose 配置并构建 Docker 镜像。

- [维护说明](docs/maintaining.md)：代码结构、测试和提交范围。
- [部署指南](docs/deploy-docker.md)：参数、代理、备份、升级与回滚。
- [UI 规范](DESIGN.md)：页面布局、控件、日期、移动端和交互要求。

## API

后台 API 前缀为 `/<后台目录>/api`，默认 `/admin/api`。文档、设置和目录等管理操作需要登录 Cookie。自定义后台目录后，旧 `/admin` 和旧 `/api/*` 管理入口会隐藏。

| 范围 | 主要接口 |
| --- | --- |
| 登录 | `POST /admin/api/login`、`POST /admin/api/logout` |
| 文档 | `GET /admin/api/pages`、`GET /admin/api/pages/:id` |
| 上传 | `POST /admin/api/pages/upload/prepare`、`POST /admin/api/pages/upload/:uploadId/confirm` |
| 访问设置 | `PATCH /admin/api/pages/:id/access`、`POST /admin/api/pages/:id/access/revoke` |
| 编辑与版本 | `PATCH /admin/api/pages/:id/content`、`GET /admin/api/pages/:id/versions` |
| 设置与目录 | `/admin/api/settings`、`/admin/api/watch-dirs` |
| 浏览分析 | `GET /admin/api/analytics?days=30&timeZone=Asia%2FShanghai`；完整排行使用 `GET /admin/api/analytics/rankings?mode=total&page=1&timeZone=Asia%2FShanghai`，`mode` 支持 `total`、`today` |
| 公开列表 | `GET /public/api/pages` |
| 阅读 | `GET /:slug`、`GET /:slug?edit=1` |

旧阅读地址 `/pages/:slug.html` 继续兼容。编辑模式需要管理员登录。
