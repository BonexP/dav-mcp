# DAV-MCP STDIO 服务器实施指南

本文档详细说明了DAV-MCP服务器STDIO传输层实施的技术细节、配置方法和使用指南。

## 📋 目录

- [实施概览](#实施概览)
- [快速开始](#快速开始)
- [配置指南](#配置指南)
- [部署说明](#部署说明)
- [测试验证](#测试验证)
- [故障排除](#故障排除)
- [性能优化](#性能优化)

## 🚀 实施概览

### 核心特性

- ✅ **完整STDIO支持**: 基于`@modelcontextprotocol/sdk`的`StdioServerTransport`
- ✅ **双传输兼容**: 与现有SSE实现完全兼容
- ✅ **26个MCP工具**: CalDAV/CardDAV/VTODO完整功能集
- ✅ **生产级错误处理**: 完整的JSON-RPC错误响应
- ✅ **生命周期管理**: 优雅关闭和资源清理
- ✅ **性能监控**: 内置健康检查和性能指标

### 架构优势

```
┌─────────────────┐
│   MCP Client    │ ← Claude Desktop, 本地应用等
│   (STDIO)       │
└─────────┬───────┘
          │ stdio (process pipes)
          ▼
┌─────────────────┐
│  server-stdio.js│ ← 新的STDIO传输层
│  StdioServer    │
└─────────┬───────┘
          │ 复用核心逻辑
          ▼
┌─────────────────┐
│  共享组件        │ ← 26个工具、tsdav客户端、错误处理等
│  (与SSE共享)     │
└─────────────────┘
```

## ⚡ 快速开始

### 1. 环境要求

```bash
Node.js >= 18.0.0
npm >= 8.0.0
```

### 2. 安装依赖

```bash
cd dav-mcp
npm install
```

### 3. 环境配置

创建`.env`文件：

```env
# CalDAV/CardDAV服务器配置
CALDAV_SERVER_URL=https://dav.yourserver.com
CALDAV_USERNAME=your_username
CALDAV_PASSWORD=your_password

# MCP服务器标识
MCP_SERVER_NAME=dav-mcp
MCP_SERVER_VERSION=2.7.0

# 可选：调试配置
LOG_LEVEL=info
```

### 4. 启动服务器

```bash
# 启动STDIO模式
npm run start:stdio

# 或者直接执行
node src/server-stdio.js
```

### 5. 测试验证

```bash
# 运行测试套件
node tests/stdio-test.js
```

## ⚙️ 配置指南

### 环境变量详解

#### 必需变量

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `CALDAV_SERVER_URL` | CalDAV服务器URL | `https://dav.example.com` |
| `CALDAV_USERNAME` | 用户名 | `admin` |
| `CALDAV_PASSWORD` | 密码 | `password123` |

#### 可选变量

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| `MCP_SERVER_NAME` | `dav-mcp-stdio` | 服务器名称 |
| `MCP_SERVER_VERSION` | `2.7.0` | 服务器版本 |
| `LOG_LEVEL` | `info` | 日志级别 (error/warn/info/debug) |
| `NODE_ENV` | `production` | 运行环境 |
| `AUTH_METHOD` | `Basic` | 认证方式 (`Basic`/`OAuth`) |

#### OAuth2配置

```env
AUTH_METHOD=OAuth
GOOGLE_SERVER_URL=https://apidata.googleusercontent.com/caldav/v2/
GOOGLE_USER=your-email@gmail.com
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
GOOGLE_TOKEN_URL=https://accounts.google.com/o/oauth2/token
```

### Claude Desktop配置

在Claude Desktop配置文件中添加：

```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/dav-mcp/src/server-stdio.js"],
      "env": {
        "CALDAV_SERVER_URL": "https://dav.example.com",
        "CALDAV_USERNAME": "your_username",
        "CALDAV_PASSWORD": "your_password",
        "MCP_SERVER_NAME": "dav-mcp",
        "MCP_SERVER_VERSION": "2.7.0"
      }
    }
  }
}
```

配置文件位置：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

## 🚢 部署说明

### 本地开发部署

```bash
# 1. 设置开发环境
cp .env.example .env
# 编辑.env文件配置你的CalDAV服务器

# 2. 启动开发服务器
npm run start:stdio

# 3. 测试连接
# Claude Desktop会自动连接到进程
```

### 生产环境部署

#### Docker部署

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY .env ./

EXPOSE 3000
CMD ["node", "src/server-stdio.js"]
```

```bash
# 构建镜像
docker build -t dav-mcp .

# 运行容器
docker run -d \
  --name dav-mcp \
  -e CALDAV_SERVER_URL=https://dav.example.com \
  -e CALDAV_USERNAME=admin \
  -e CALDAV_PASSWORD=password \
  -v /host/logs:/app/logs \
  dav-mcp
```

#### 系统服务部署

创建`/etc/systemd/system/dav-mcp.service`：

```ini
[Unit]
Description=DAV-MCP STDIO Server
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/opt/dav-mcp
ExecStart=/usr/bin/node src/server-stdio.js
Environment=NODE_ENV=production
Environment=CALDAV_SERVER_URL=https://dav.example.com
Environment=CALDAV_USERNAME=admin
Environment=CALDAV_PASSWORD=password
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 远程服务器部署

```bash
# 1. 服务器设置
sudo apt update
sudo apt install nodejs npm

# 2. 部署应用
git clone https://github.com/PhilflowIO/dav-mcp.git
cd dav-mcp
npm install

# 3. 配置环境
cp .env.example .env
# 编辑.env文件

# 4. 设置为系统服务
sudo cp scripts/dav-mcp.service /etc/systemd/system/
sudo systemctl enable dav-mcp
sudo systemctl start dav-mcp

# 5. 检查状态
sudo systemctl status dav-mcp
```

## 🧪 测试验证

### 自动测试

```bash
# 运行完整测试套件
node tests/stdio-test.js
```

### 手动测试

#### 1. 启动测试

```bash
# 启动STDIO服务器
node src/server-stdio.js
```

#### 2. 发送测试请求

```bash
# 测试工具列表
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node src/server-stdio.js

# 测试日历列表（需要正确配置CalDAV服务器）
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_calendars","arguments":{}}}' | node src/server-stdio.js
```

#### 3. 验证响应

期望的工具列表响应：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "list_calendars",
        "description": "List all available calendars...",
        "inputSchema": { "type": "object", ... }
      },
      // ... 25 more tools
    ]
  }
}
```

### Claude Desktop集成测试

1. 在Claude Desktop中配置MCP服务器
2. 重启Claude Desktop
3. 尝试询问："列出我的日历"
4. 验证是否正确返回日历列表

## 🔧 故障排除

### 常见问题

#### 1. 服务器启动失败

**症状**: 
```
Error: Missing required environment variables: CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD
```

**解决方案**:
```bash
# 检查环境变量
echo $CALDAV_SERVER_URL
echo $CALDAV_USERNAME
echo $CALDAV_PASSWORD

# 设置环境变量
export CALDAV_SERVER_URL=https://dav.example.com
export CALDAV_USERNAME=admin
export CALDAV_PASSWORD=password
```

#### 2. CalDAV连接失败

**症状**:
```
Error: Failed to initialize tsdav clients
```

**解决方案**:
1. 检查CalDAV服务器URL是否正确
2. 验证用户名和密码
3. 测试网络连接
4. 检查CalDAV服务器状态

#### 3. 工具调用失败

**症状**:
```
Error: Unknown tool: invalid_tool_name
```

**解决方案**:
1. 检查工具名称是否正确
2. 验证工具是否在支持列表中
3. 查看可用工具列表

#### 4. 内存泄漏

**症状**:
```
Process memory usage持续增长
```

**解决方案**:
1. 检查工具调用日志
2. 重新启动服务
3. 监控内存使用情况

### 调试模式

```bash
# 启用详细日志
export LOG_LEVEL=debug
node src/server-stdio.js

# 启用开发模式
export NODE_ENV=development
node src/server-stdio.js
```

### 日志分析

日志输出格式：

```json
{
  "time": "14:23:15.123",
  "level": "INFO",
  "server": "dav-mcp-stdio",
  "version": "2.7.0",
  "transport": "stdio",
  "requestId": "uuid-1234",
  "msg": "Tool executed successfully"
}
```

## ⚡ 性能优化

### 性能特征

- **启动时间**: ~2-3秒（包含tsdav初始化）
- **内存使用**: ~50-100MB基础内存
- **工具响应时间**: 取决于CalDAV服务器（通常100-500ms）
- **并发支持**: 单进程（典型MCP客户端限制）

### 优化建议

#### 1. 内存优化

```javascript
// 定期强制垃圾回收（仅在开发环境）
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    if (global.gc) {
      global.gc();
    }
  }, 30000);
}
```

#### 2. 连接池优化

```javascript
// 复用tsdav客户端连接
const client = tsdavManager.getCalDavClient();
// 客户端会自动处理连接池
```

#### 3. 缓存策略

```javascript
// 缓存常用数据（建议在工具实现中添加）
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}
```

### 监控指标

```javascript
// 内置性能监控
const health = {
  status: 'healthy',
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  tools: {
    total: 26,
    categories: {
      calendar: 11,
      contacts: 8, 
      todos: 7
    }
  }
};
```

## 📊 与SSE对比

| 特性 | STDIO | SSE |
|------|-------|-----|
| **部署复杂度** | 低 | 中 |
| **网络依赖** | 无 | 有 |
| **客户端支持** | 本地应用 | 网络应用 |
| **并发连接** | 单进程 | 多客户端 |
| **性能** | 极快 | 快速 |
| **调试便利性** | 高 | 中 |
| **监控难度** | 低 | 中 |

## 🎯 使用场景

### 推荐使用STDIO的场景

- ✅ **Claude Desktop集成**
- ✅ **本地开发环境**
- ✅ **单用户应用**
- ✅ **需要离线运行**
- ✅ **追求最高性能**

### 继续使用SSE的场景

- ✅ **n8n工作流集成**
- ✅ **多用户环境**
- ✅ **网络化部署**
- ✅ **微服务架构**
- ✅ **负载均衡需求**

## 📞 技术支持

- **GitHub Issues**: [https://github.com/PhilflowIO/dav-mcp/issues](https://github.com/PhilflowIO/dav-mcp/issues)
- **文档**: [README.md](README.md)
- **MCP协议**: [https://modelcontextprotocol.io](https://modelcontextprotocol.io)

---

**注意**: 本实施遵循MCP 2025-03-26规范，确保与标准MCP客户端的完全兼容性。