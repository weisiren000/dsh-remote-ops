# dsh-remote-ops

让 DSH 通过 SSH 直连远端机器。输入服务器、端口、用户名和密码后，首次连接会确认服务器指纹，并在远端安装 DSH 专用密钥；之后由本机密钥自动重连。模型用 `host_bash` 在远端执行命令，手感接近本机 shell。

已经部署 `remote-hostd` 的环境仍可使用“高级配对”模式。

## 远端

已有 TLS：

```text
node src/hostd/cli.js --listen 0.0.0.0:7680 --tls-cert cert.pem --tls-key key.pem
```

前面已有反代时，只在本机回环听：

```text
node src/hostd/cli.js --listen 127.0.0.1:7680
```

终端会打印 pairing code。

## 本机安装

本机如果没有全局 `dsh` 命令（只用 `npx` 启动），先定义shell工具的函数比如：

```powershell
function dsh { npx @deepseek-ai/dsh @args }
```

Windows 上不要直接 `dsh plugin add D:\...`。`link:D:/...` 会被当成相对路径，装出来是坏链接，并报 `declares no dsh.bundle`。正确做法：

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.dsh\plugins | Out-Null
cmd /c mklink /J "$env:USERPROFILE\.dsh\plugins\dsh-remote-ops" "D:\codee\dsh\dsh-remote-ops"
```

然后让 web profile 依赖这个 C 盘 junction（相对路径 `file:../../plugins/dsh-remote-ops`），并把 `dsh-remote-ops` 写进 `dsh.profile.bundles`。装完重启 `dsh web`。

打开 DSH Web：设置 → 插件 → 远程主机，在页面里填写 SSH 服务器、端口、用户名和密码即可。

密码只用于首次连接，不会写入主机配置；SSH 连接会启用 keepalive，并在连接断开后由心跳自动恢复。

在对话里让模型调用 `host_pair` 效果相同，两边读写同一份本机主机表。

## 模型工具

- `host_pair`：地址 + 暗号
- `host_list`：主机与在线状态
- `host_use`：切换当前目标
- `host_bash`：在当前目标或指定主机执行命令
- `host_jobs` / `host_job_log`：查任务和日志
