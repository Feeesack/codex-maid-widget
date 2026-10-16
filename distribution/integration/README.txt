Codex 女仆挂件：安装版插件连接工具

本目录随安装包携带全部本地插件文件和连接脚本，不需要 Node.js、npm 或项目源码。
Windows：通过开始菜单或桌面的“连接 Codex 插件”快捷方式运行。
macOS：通过挂件菜单栏中的“连接 Codex 工具…”运行。

连接操作会在当前用户的 ~/.codex-maid-widget/integration 下创建本地插件来源，
再通过官方 Codex CLI 的 plugin marketplace add 和 plugin add 安装插件。
Codex 本身需要已安装；真实额度需要在 Codex 中登录自己的账号。
连接成功后重启 Codex 并新建聊天。使用工具时桌面挂件须保持运行。

本目录的 connect.cjs 默认只显示说明；只有 --install 才会连接插件。
所有本地 MCP 进程均使用安装包自带的 Electron Node 运行时，mcp.cjs 位于 ASAR 外。
安装包中的原始插件和 .app 签名资源不会被连接操作改写。
如 Codex 装在自定义位置，可设置 CODEX_CLI 为其命令行程序绝对路径后重试。
构建和打包过程不会调用连接操作，也不会修改当前开发者的 Codex 设置。
