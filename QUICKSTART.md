# HovAITV Web 演示版快速开始

HovAITV 是面向 AI 影视与短剧创作的工作台。本包是完整的前后端分离 Web 演示项目：

- `web/`：前端，Vite + React 19 + TypeScript（开发端口 2178）。
- `backend/`：后端，Go + Gin + GORM + SQLite（端口 8080，首次启动自动创建并迁移数据库）。
- `plugin-packages/`：声明式模型协议插件（内置 80+ 模型渠道）。
- `data/`（后端运行后生成）：SQLite 数据库文件 `open_ai_canvas.db`，含自动迁移 schema 与默认工作区。

## 环境要求

- Go 1.25+
- Bun（推荐）或 Node.js 20+ / npm
- Docker（可选，容器化部署时使用）

## 本地启动

```bash
# 终端 1：启动后端（默认 8080，自动迁移 SQLite）
cd backend
go run ./cmd/server

# 终端 2：启动前端开发服务器（默认 2178）
cd web
bun install --frozen-lockfile   # 或 npm install
bun run dev                     # 或 npm run dev

# 浏览器打开 http://localhost:2178
```

Vite 已把 `/api` 代理到 `http://127.0.0.1:8080`，前后端开发时无需额外配置。

## 数据库说明

- 后端使用 SQLite，数据文件为 `backend/data/open_ai_canvas.db`，由 `CANVAS_BACKEND_DATA_DIR` 指定目录。
- 启动时默认执行自动迁移（`CANVAS_AUTO_MIGRATE=true`），无需手工建表；迁移逻辑见 `backend/internal/database/local_schema.go`。
- 首次启动自动创建本地工作区与用户，打开页面即可直接进入工作台。
- 备份：停止后端后直接复制 `backend/data` 目录即可。

## 构建与部署

```bash
# 前端产物构建（输出 web/dist）
cd web && bun run build

# 容器化（nginx 托管前端 + Go 后端，端口 2178）
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

生产 Compose（PostgreSQL/Redis）见 `docker-compose.deploy.yml`；前端反向代理配置见 `nginx.conf`。

## 插件

内置模型协议插件位于 `plugin-packages/`。修改任意插件源目录后，在 `plugin-packages/` 下执行：

```bash
sh build-packages.sh
```

重新生成 `*.hovaitv-plugin` 包，后端重启后自动加载。

## 常用环境变量（后端）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CANVAS_BACKEND_ADDR` | `:8080` | 后端监听地址 |
| `CANVAS_BACKEND_DATA_DIR` | `data` | 数据目录（SQLite 数据库） |
| `CANVAS_AUTO_MIGRATE` | `true` | 启动时自动迁移数据库 |
| `CANVAS_CORS_ORIGINS` | 允许本地开发来源 | 跨域白名单 |
| `CANVAS_REGISTRATION_ENABLED` | `false` | 是否开放公开注册 |

## 测试与验证

```bash
cd backend && go test ./...     # 后端全量测试
cd web && bun run build         # 前端类型检查 + 构建
cd web && bun test              # 前端测试套件
```
