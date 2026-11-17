# 轻量云服务器部署指南

云端书库同步服务非常轻量（单进程 Node.js，日常内存约 30–50 MB），支持 **Docker 部署（推荐，内置单页 PDF 高清渲染）** 与 **直接 Node.js 运行** 两种方式。

---

## 方式一：Docker Compose 一键部署（推荐）

内置 Node 24 与 `pypdfium2`，手机/汉王墨水屏点击「查看原 PDF 第 N 页」时可按需秒级渲染单页高清 PNG。

```bash
cd dsh-paper-reader/sync-server
# 生成并写入强随机同步密钥
echo "SYNC_TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d --build
```

- 查看生成的 Token 与运行日志：
  ```bash
  cat .env
  docker compose logs -f paper-reader-sync
  ```
- 如果你有域名并希望自动启用 HTTPS：
  1. 修改 `sync-server/Caddyfile` 中的域名；
  2. 取消 `docker-compose.yml` 中 `caddy` 服务的注释并运行 `docker compose up -d`。

---

## 方式二：直接 Node.js + systemd 运行（无 Docker）

1. 在云主机安装 Node.js 22+（以及可选 `pip3 install pypdfium2 pillow` 用于单页 PDF 渲染）：
   ```bash
   cd dsh-paper-reader
   npm ci --omit=dev
   ```
2. 启动测试：
   ```bash
   SYNC_TOKEN="你的强随机密钥" PORT=4180 node sync-server/server.mjs
   ```
   （若未传 `SYNC_TOKEN`，首次启动会在 `sync-server/data/sync-token.txt` 自动生成。）
3. 配合现有 Nginx 反向代理（建议设置 `client_max_body_size 0;` 与 `proxy_request_buffering off;` 以支持超大原书 PDF，同时服务端内置 8 MB 分片上传）。

---

## 在 PC 端与移动端接入

1. **PC 端 DSH 插件**：打开文献库右上角「**云同步**」，填入 `https://你的域名`（或 `http://IP:4180`）与 `SYNC_TOKEN`，点击「**立即双向同步**」。
2. **手机 / 汉王 APK**：打开 App「**设置**」Tab，填入相同的地址与密钥并保存，即可拉取书库并离线精读。
