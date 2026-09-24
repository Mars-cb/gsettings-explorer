# GSettings Explorer

一个 Electron 桌面程序，用于浏览本机或 SSH 目标当前用户的 GSettings schema 和键，按 schema、键、值、说明搜索，并监听单个键的变化。可把本次运行期间收集的变更记录导出为 JSON；默认保存到 AppImage 所在目录，也可编辑路径或使用目录选择器更改。程序没有常驻服务；远程查询通过 SSH 临时运行内置的只读 helper。

## 运行与构建

开发环境需要 Node.js 20+、npm、Python 3、`python3-gi`、GSettings。远程主机需要 Python 3、`python3-gi`、GSettings。SSH 支持公钥/agent 登录，也可在连接面板输入密码；密码仅保留在当前进程内，不会写入磁盘。`dbus-monitor` 可用于尝试识别写入进程。

```bash
npm install
npm start
npm run build
```

`npm run build` 只生成 `release/GSettings Explorer-<版本>-x86_64.AppImage`。运行 AppImage 不需要安装 Node.js 或 npm；本机与远程机器仍需提供 GSettings 和 Python GI，且目标用户会话的 D-Bus 可访问。SSH 连接使用系统 SSH 配置及已知主机检查；首次连接请先在终端确认主机密钥。应用图标包含在 AppImage 中。

## 数据含义

- 固定路径 schema 显示当前值、默认值、是否有用户值及可写状态。
- 可重定位 schema 无法仅凭 schema 确定实例路径。界面列出其键；输入实例路径后可监听。GSettings 没有枚举所有实例路径的通用接口。
- 监听中的“前值观测时间”是监听开始或上次事件的读取时间，“新值观测时间”是收到变化通知的时间。它们不是底层存储的精确写入时间。
- GSettings 变化通知不携带修改者。程序尝试监听同一用户会话中的 dconf D-Bus 写入调用，把时间接近的进程显示为“可能关联”；无法匹配时显示“无法确定”。这项归因不能作为审计证据。
- 只记录监听开始后的变化；程序关闭后记录不会保留。

实现依据：[Gio.Settings 文档](https://docs.gtk.org/gio/class.Settings.html)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。
