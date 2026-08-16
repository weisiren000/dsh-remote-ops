# dsh-remote-ops

`dsh-remote-ops` 是 DeepSeek Harness 的远程主机插件。它为 DSH 增加 SSH 直连、`remote-hostd` 配对、远程命令执行、远程文件读写、任务管理和远程工作台。

插件不会替代 DSH 的本地工具：检查当前本地工作区时，应使用 DSH 自带的本地工具；只有用户明确要求远程、服务器或指定主机操作时，才使用 `host_*` 工具。

## 工作方式

- **SSH 直连**：在 DSH 设置中填写服务器、端口、用户名和首次登录密码。首次连接确认 SSH 指纹后，插件保存本机专用密钥，后续不再保存或使用密码。
- **高级配对**：远端运行 `remote-hostd`，本地输入地址和一次性配对码。适合已经部署 hostd 的机器。
- **远程工作台**：会话标题栏的“服务器”入口用于浏览远程文件、运行远程命令和审阅远程文件变更。

## 安装

### 前置条件

- 已安装 [Git](https://git-scm.com/)、Node.js 和 pnpm。
- DeepSeek Harness 已至少启动过一次，Web profile 已创建。

### Windows

在 PowerShell 中执行：

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pluginDir = Join-Path $dshHome 'plugins\dsh-remote-ops'

New-Item -ItemType Directory -Force -Path (Split-Path $pluginDir) | Out-Null
git clone https://github.com/weisiren000/dsh-remote-ops.git $pluginDir
pnpm --dir $pluginDir install
pnpm --dir $pluginDir build:client
npx @deepseek-ai/dsh plugin --profile web add file:../../plugins/dsh-remote-ops
```

### Linux / macOS

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="$DSH_HOME/plugins/dsh-remote-ops"

mkdir -p "$DSH_HOME/plugins"
git clone https://github.com/weisiren000/dsh-remote-ops.git "$PLUGIN_DIR"
pnpm --dir "$PLUGIN_DIR" install
pnpm --dir "$PLUGIN_DIR" build:client
npx @deepseek-ai/dsh plugin --profile web add file:../../plugins/dsh-remote-ops
```

然后打开 `<DSH_HOME>/profiles/web/package.json`，在已有的 `dsh.profile.bundles` 数组中加入 `dsh-remote-ops`；保留原有的其他 bundle：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-remote-ops"
      ]
    }
  }
}
```

上面的 JSON 只展示需要确认的结构，不要用它覆盖整个 profile 文件。

### 启动或重启 DSH

关闭旧的 DSH Web 进程后启动：

```powershell
npx @deepseek-ai/dsh web --port 3080
```

浏览器打开 <http://127.0.0.1:3080>，进入“设置 → 插件 → 远程主机”。看到远程主机面板，说明插件已加载。

### 连接远程机器

#### SSH 直连（推荐）

在远程主机面板填写服务器、SSH 端口、用户名和首次登录密码，点击“连接主机”。首次连接显示服务器指纹时，只有确认指纹属于你的服务器才继续。

#### 高级配对

在远端启动 `remote-hostd`，复制终端打印的一次性配对码，然后在面板切换到“高级配对”并填写地址和配对码。

### 验证安装

```powershell
Invoke-WebRequest 'http://127.0.0.1:3080/remote-ops/v1/hosts' | Select-Object StatusCode
```

预期状态码为 `200`。然后在对话中明确说“列出远程主机”或“在指定服务器执行命令”验证 `host_*` 工具；检查本地代码时不要用远程请求作为验证。

## 远端安装 `remote-hostd`

`remote-hostd` 只在使用“高级配对”时需要。它把自己的工作目录作为远程工作区，因此启动前应先切换到要开放的项目目录。

本机回环监听（已有反向代理或只允许本机访问）：

```bash
cd /path/to/remote-project
node /path/to/dsh-remote-ops/src/hostd/cli.js --listen 127.0.0.1:7680
```

直接对局域网或公网提供服务时必须使用 TLS：

```bash
cd /path/to/remote-project
node /path/to/dsh-remote-ops/src/hostd/cli.js \
  --listen 0.0.0.0:7680 \
  --tls-cert /path/to/fullchain.pem \
  --tls-key /path/to/privkey.pem
```

只有在临时隔离网络中，才使用不安全的明文监听：

```bash
node /path/to/dsh-remote-ops/src/hostd/cli.js --listen 0.0.0.0:7680 --allow-insecure
```

终端会打印监听地址和配对码。不要把配对码提交到代码仓库或写入公开日志。

## 让 Agent 自动安装

不想手动执行上面的命令时，把下面整段提示词复制给本地编码 Agent。它会自行检测系统和 DSH profile，安装插件、重启 DSH 并做验收；执行本地安装时不能调用任何 `host_*` 远程工具。

```text
请在这台电脑上自动安装并启用 GitHub 仓库 https://github.com/weisiren000/dsh-remote-ops.git 的 DeepSeek Harness 插件。

目标：
1. 安装插件源码和依赖。
2. 构建客户端 bundle。
3. 把插件加入当前 DSH Web profile 的 dependencies 和 dsh.profile.bundles。
4. 重启实际运行中的 DSH Web 服务。
5. 用 HTTP 和文件哈希验证运行中的服务加载的是刚安装的源码。

执行规则：
- 这是本地安装任务，只使用当前机器的本地终端、文件系统和 Git。
- 禁止调用 host_pair、host_list、host_use、host_bash、host_jobs、host_list_files、host_read_file、host_write_file、host_review_changes 或任何其他 host_* 工具。
- 先检测操作系统、Node.js、pnpm、Git、DSH_HOME 和 DSH Web profile 的实际位置，不要猜路径、盘符、端口或进程。
- DSH_HOME 优先使用环境变量 DSH_HOME；未设置时使用用户目录下的 .dsh。
- 插件目录使用 <DSH_HOME>/plugins/dsh-remote-ops。目录不存在就 git clone；已经是该仓库就保留本地改动并更新依赖，不要删除整个目录。
- 在插件目录执行 pnpm install 和 pnpm build:client。
- 在 <DSH_HOME>/profiles/web 中安装 file:../../plugins/dsh-remote-ops，并用结构化 JSON 修改 package.json，确保 dsh.profile.bundles 包含 dsh-remote-ops；保留其他依赖和字段。
- Windows 不要使用 `link:` 加本机绝对路径的依赖写法，也不要把 Bash 当作 PowerShell。使用 PowerShell 和原生 Windows 路径。
- 找到真正运行 DSH Web 的进程后只重启该进程；不要杀掉所有 node 进程。若服务未运行，使用当前 profile 启动它并报告实际 URL、PID 和日志位置。
- 不要提交、推送或重置仓库中的用户改动。

验收要求：
- 运行 node --test test/plugin-tools.test.js test/plugin-config.test.js test/client-bundle.test.js，并报告通过数。
- 运行 git diff --check。
- 检查 DSH 首页返回 HTTP 200，以及 /remote-ops/v1/hosts 返回 HTTP 200。
- 检查 profile/node_modules/dsh-remote-ops/src/plugin/tools.js 与源码 src/plugin/tools.js 的 SHA-256 一致。
- 创建一个新会话，确认 host_* 工具描述包含 Remote-only，且本地代码任务的默认工具仍是本地工具。
- Windows 上不要用“极简模式”做验收；DSH 0.1.0-rc.6 的极简 preset 固定使用 Bash PTY，在 Win32 会报 terminal inspection is unsupported on platform win32。使用标准模式或创造模式。

完成后只汇报：安装目录、profile、服务 URL/PID、验证结果和遇到的阻塞；不要只说“安装完成”而不提供证据。
```

## 模型工具

- `host_pair`：配对一个远程主机。
- `host_list`：列出已配对主机和在线状态。
- `host_use`：切换当前远程目标。
- `host_bash`：在远程主机执行前台或后台命令。
- `host_jobs` / `host_job_log`：查询远程任务和日志。
- `host_list_files` / `host_read_file`：浏览、读取远程文件。
- `host_write_file`：按版本校验写入远程文件并创建待审阅变更。
- `host_review_changes`：查看或处理远程文件变更。

所有远程工具都是显式远程能力。用户没有明确指定远程操作时，Agent 不应调用它们。
