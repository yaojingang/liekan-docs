# Docker 部署指南

## 准备与启动

需要 Docker Engine 和 Docker Compose v2。建议至少 2 GB 内存用于 Word 转 PDF；磁盘空间按原文件、附件及版本快照数量预留。

```bash
git clone https://github.com/yaojingang/liekan-docs.git
cd liekan-docs
cp .env.example .env
```

先修改 `.env` 中的 `TOKDOC_INITIAL_PASSWORD`。它只在空数据库首次初始化时生效，无法重置已有账号。

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:18082/healthz
```

首页为 `/`，后台默认为 `/admin`。默认端口 `18082` 只绑定 `127.0.0.1`；健康检查 `/healthz` 不受后台目录修改影响。

## 配置

`.env.example` 列出了 Compose 配置。常用项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TOKDOC_HOST_PORT` | `18082` | 宿主机端口 |
| `TOKDOC_BIND_ADDR` | `127.0.0.1` | 宿主机监听地址 |
| `TOKDOC_DATA_VOLUME` | `./data` | SQLite、文档和附件的持久化目录 |
| `TOKDOC_WATCH_VOLUME` | `./html-inbox` | 宿主机监听目录 |
| `TOKDOC_CONTAINER_WATCH_DIRS` | `/watch/html-inbox` | 容器内监听目录，多个路径用逗号分隔 |
| `TOKDOC_ALLOW_SOURCE_WRITE` | `false` | 是否允许回写监听目录中的源文件 |
| `TOKDOC_INITIAL_USERNAME` | `admin` | 空库首次初始化的账号 |
| `TOKDOC_INITIAL_PASSWORD` | `tokdoc` | 空库首次初始化的密码，首次部署前修改 |
| `TOKDOC_ADMIN_PATH` | 空 | 临时覆盖后台地址，空值使用数据库设置 |
| `TOKDOC_TRUST_PROXY` | 空 | 受信代理 IP 或 CIDR，多个值用逗号分隔 |
| `TOKDOC_IMAGE` | `liekan-docs:latest` | 本地构建的镜像名 |
| `TOKDOC_CONTAINER_NAME` | `liekan-docs` | 容器名 |

镜像内包含 LibreOffice Writer、Noto CJK 字体和 Node.js 22。项目没有预置远程镜像仓库，默认从源码构建。

## Nginx 或宝塔反向代理

在服务器上保留本机绑定地址，在域名站点配置代理。以下片段放在已配置 HTTPS 的 `server` 内：

```nginx
client_max_body_size 200m;

location / {
    proxy_pass http://127.0.0.1:18082;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

单个上传文件限制为 20 MiB，代理请求体上限还需容纳批量上传。宝塔中可通过 Compose 项目启动，再在网站设置中添加反向代理。

HTTPS 在代理终止时，把后端实际看到的代理 IP 或 CIDR 填入 `TOKDOC_TRUST_PROXY`。本机 Node 代理可使用 `127.0.0.1,::1`；Docker 网关按实际网络核对。仅填写自己管理的代理地址，直接 HTTP 测试保持为空。

配置后重新创建容器，并确认 HTTPS 下的文档密码验证正常，阅读授权 Cookie 带有 `Secure`。

```bash
docker compose up -d
```

## 日常操作

```bash
docker compose ps
docker compose logs --tail 100 liekan-docs
docker compose restart liekan-docs
docker compose stop liekan-docs
docker compose start liekan-docs
```

首次账号变量不覆盖已有账号。忘记自定义后台地址时，可临时将 `TOKDOC_ADMIN_PATH` 设为 `/admin`，重建容器；登录后保存后台地址，再清空覆盖项。

## 备份与恢复

`data/` 包含数据库、原文件、附件、生成页面、版本、暂存上传和回收站。数据库还包含账号哈希、同步配置及阅读授权信息，备份应保密。额外备份 `.env`、`html-inbox/` 和其它监听目录。

先停止服务，再备份完整数据目录，保证 SQLite WAL 和文件处于同一时间点。以下示例适用于默认的 `./data` 挂载；使用自定义挂载时替换为实际目录：

```bash
docker compose stop liekan-docs
tar -czf ../liekan-docs-data-YYYYMMDD-HHMMSS.tar.gz data
docker compose start liekan-docs
```

执行前将文件名中的日期替换为本次备份时间，使用新文件名。确认备份成功后再启动服务；备份失败时保留原数据并排查原因。

恢复时停止服务，在另一个空目录解压备份并检查内容，保留当前数据副本。通过 `.env` 的 `TOKDOC_DATA_VOLUME` 指向恢复目录，再启动容器。直接覆盖原目录会混合新旧附件和数据库。

数据库记录包含容器内绝对路径，迁移服务器时保留 `/app/data`、`/watch/html-inbox` 等路径。修改目录布局前，在数据副本中验证原文、附件、版本与监听功能。

## 升级与回滚

升级前按上一节备份，记录当前提交及镜像，再更新代码并重建：

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:18082/healthz
```

升级会增量迁移 SQLite。已有文档的访问方式、账号和数据继续保留。

回滚需要使用仍支持当前访问控制和数据结构的构建。早期版本无法识别 `homepage_listed` 和 `access_password_hash`，可能将仅链接或带密码的公开文档直接展示。需要回退到这种旧版时，先停服，在数据副本中把 `visibility='public' AND (homepage_listed=0 OR access_password_hash<>'')` 的文档转换为旧版可识别的私有状态，并验证后再使用。

恢复旧备份会回到备份时点。升级后的新增文档应先单独保留，完成核对后再切换恢复目录。

## 排查

- **域名 502**：先检查容器状态和本机 `/healthz`，再检查代理端口及 HTTPS 配置。
- **上传失败**：核对单文件 20 MiB 限制、批次文件数、代理请求体限制和服务日志。
- **Word 转换失败**：检查容器日志、内存和源文件；本机启动时检查 LibreOffice 安装与 `TOKDOC_SOFFICE_BIN`。
- **修改初始密码无效**：该变量仅作用于空数据库。已有账号通过系统设置修改。
- **更改路径后附件或版本不可用**：核对原容器路径和挂载；保持路径恢复，再在副本中做迁移。
