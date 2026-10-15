# 维护说明

## 代码结构

```text
src/                  Fastify 服务、SQLite、文档存储、权限和编辑桥
public/               前后台 HTML、JavaScript 和系统样式
test/                 Node.js 测试及前端 DOM 交互测试
.github/workflows/    GitHub Actions 自动测试
docs/                 部署与维护说明
DESIGN.md             UI 规范
Dockerfile            Node.js 22 与 LibreOffice 运行镜像
docker-compose.yml    本地持久化部署配置
```

项目使用原生 JavaScript 和 HTML，无前端编译步骤。系统 UI 样式不注入用户的原始文档正文。

## 开发检查

```bash
npm ci
npm test
docker compose --env-file .env.example config --quiet
docker build -t liekan-docs:check .
```

测试使用独立临时数据库及目录。Word 转换单元测试使用可控的转换器替身；验证真实 Word 阅读时，另用新建的 Docker 数据目录上传测试 DOCX，确认生成 PDF。

涉及权限、原文件或附件路由时，还需核对公开、仅链接、密码、私有、删除文档，以及 GET、HEAD、Range 和非规范路径。UI 变更遵循 [DESIGN.md](../DESIGN.md)，检查电脑和手机布局。

## 提交范围

Git 中保留源代码、测试、锁文件、许可证、配置示例和维护文档。

以下内容留在本机，已通过 `.gitignore` 排除：

- `.env`、本地密钥、SQLite 及其 WAL/SHM 文件。
- `data/`、`html-inbox/` 中的业务数据，仅保留空目录占位文件。
- `tmp/`、`.codex-backups/`、日志、压缩包、依赖目录和构建产物。
- `docs/` 中的历史方案、评审截图和本机验收资料，公开文档仅包含部署和维护说明。

Docker 构建使用独立允许清单，只复制应用源码、测试、锁文件和许可证。新增运行时资源时，要同步检查 `.dockerignore`，从干净的源码副本构建验证。

## 依赖与 CI

`package.json` 和 `package-lock.json` 一起维护。使用 `npm ci` 验证锁文件，依赖安全检查可执行：

```bash
npm audit --omit=dev
```

CI 以只读仓库权限运行，GitHub 官方 Actions 固定到提交 SHA。更新 Actions 时同时核对版本注释和实际 SHA。工作流只运行测试和 Docker 构建，不自动部署、推送镜像或创建 Release。

## 数据与兼容约束

- 首次账号变量仅初始化空数据库，已有账号通过系统设置维护。
- `TOKDOC_*`、旧 `TOKHTML_*`、数据库文件名、Cookie 和编辑标记存在兼容用途，修改前检查相应测试。
- 公开列表仅返回允许的摘要字段，管理数据和磁盘路径需要登录。
- 阅读密码保存哈希，浏览器保存随机授权 Cookie。原文件和附件必须使用同一文档权限。
- 数据库与原文件、附件、版本应整体备份，迁移时保留容器内路径。
- 回滚访问控制之前的旧版本前，先处理旧版无法识别的限制，详见[部署指南](deploy-docker.md#升级与回滚)。

## 提交和发布

使用功能分支和 Pull Request，描述具体变更、用户影响与验证结果。合并前确认 CI 通过，检查暂存区没有数据库、文档原件、Token 或本机路径。

安全问题涉及访问绕过或凭据泄露时，先联系维护者确认私密沟通方式；公开 Issue 中只放脱敏后的复现信息。

本项目从 TokDoc 独立发展，保留 [MIT 许可证](../LICENSE) 和 README 来源说明。`package.json` 的 `private: true` 用于防止误发布到 npm，GitHub 仓库可以公开。
