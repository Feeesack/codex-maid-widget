# Codex 女仆额度挂件

[English](README.md) | **简体中文**

给 Codex 配一个桌面小伙伴，看看剩余额度和本机 token 用量。检测到一轮任务完成时，角色会“duang”地跳一下，提醒你放下手机，回来看看结果。

<img src="assets/icons/app-128.png" width="96" alt="Codex 女仆额度挂件应用图标">

<img src="docs/screenshots/widget-dragon-demo.png" width="228" alt="挂件预览，额度为明确标记的演示数据">

## 下载与安装

Windows 和 macOS 使用同一个发行版本 **v0.3.21**。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 Windows 安装包（.exe）](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.21/Codex-Maid-Widget-0.3.21-windows-x64-setup.exe) |
| macOS 13 及以上，Apple 芯片与 Intel | [下载 Mac 通用安装包（.pkg）](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.3.21/Codex-Maid-Widget-0.3.21-macOS-universal.pkg) |

更新说明和 SHA-256 校验值放在 [Releases](https://github.com/Feeesack/codex-maid-widget/releases)。安装包已带上运行环境和可选的本地 Codex 插件，不用另装 Node.js、npm，也不用下载源码。

1. 先安装官方 Codex 桌面应用并登录，挂件才有真实账号额度可读。
2. 运行安装包，从 Windows 开始菜单或 macOS“应用程序”中打开挂件。
3. 点击齿轮、右键角色，或使用系统托盘／菜单栏菜单调整设置。

软件界面目前是简体中文；中英文 README 对应同一个版本。

目前的安装包没有开发者分发证书。Mac 应用使用 ad-hoc 签名，安装包尚未经过 Apple 公证，安装时系统可能会要求确认来源。请从本仓库的 Releases 下载，并核对附带的校验值。

## 能做什么

- 查看额度剩余百分比和重置倒计时，选择不同额度桶，自动刷新或手动点一下刷新。
- 查看今日、本周和本机最近完成一轮的 token 用量，不用另开统计页面。
- 偶尔“duang”一下：检测到新完成一轮时，角色会弹跳并播放一声短音效；点击角色或使用快捷键也能触发。音效可以关闭，刷手机时听见了，记得回来看看。它按这些事件互动，没有单独的定时提醒服务。
- 跟着 Codex 自启动：登录助手在后台等待，打开 Codex 时显示挂件，完全退出 Codex 后挂件也会退出。这个功能可以在设置中关闭。
- 在两个内置角色之间切换，或把自己的图片导入本机形象库。台词可以自己写，气泡颜色会随角色匹配。
- 拖动挂件时保持人物大小，支持底角吸附、左右镜像、大小、透明度、置顶和鼠标穿透。人物拖过屏幕中线就会转向，位置会保存，下次打开不用重新摆。
- 可选窗口内显示：Windows 可将人物固定在 Codex 主窗口内，随窗口移动、收起和展开；macOS 使用独立挂件窗口跟随 Codex 的范围和显隐。
- 可选“底角吸附时只露头部”：停在两个底角时探头，向内拽出时逐渐露出全身，松手靠近底角后平滑吸附。
- 气泡自动收起支持 3、5、10、30、60 秒或始终显示，默认 5 秒；升级时保留已保存的选择。
- 带有呼吸、弹跳、数字滚动和额度流光动画，也会遵循系统的减少动画设置。
- 装上可选的本地 MCP 插件后，可以让 Codex 查询状态、刷新额度、显示／隐藏挂件、让角色弹跳或打开设置。

额度百分比对应当前登录的 Codex 账号。Token 用量则从本机各账号的可用会话日志中汇总，本周从本地时间周一零点算起；记录缺失或不完整时会标出来。这些数字只反映本机日志，不是金额账单，也不是账号在所有设备上的总用量。

## 日常操作

| 操作 | 方式 |
| --- | --- |
| 移动 | 拖动角色或气泡 |
| 刷新 | 点击气泡或刷新按钮 |
| 切换气泡 | 点击 `···`：额度、今日、本周、最近一轮、台词 |
| 弹跳／互动 | 点击角色或爱心；窗口获得焦点后按 `Q` 或空格 |
| 设置 | 齿轮、右键或托盘／菜单栏 |
| 显示／隐藏 | Windows `Ctrl+Alt+M`；Mac `Control+Option+M` |
| 弹跳 | Windows `Ctrl+Alt+Q`；Mac `Control+Option+Q` |
| 切换鼠标穿透 | Windows `Ctrl+Alt+Shift+M`；Mac `Control+Option+Shift+M` |
| 重置位置／退出 | 托盘／菜单栏菜单 |

如果快捷键有冲突，可以用托盘／菜单栏操作。气泡自动收起后，把鼠标移到角色上就会重新显示。

### 窗口内显示与底角探头

这两个选项默认关闭。Windows 在设置中开启 **固定在 Codex 窗口内** 后，人物会随 Codex 主窗口移动，并参与系统的收起、展开动画。其他应用和弹窗按正常窗口层级遮挡人物，人物不会浮在它们上面。关闭后恢复已保存的桌面位置和置顶偏好。

macOS 对应选项名为 **仅在 Codex 窗口内显示**，使用独立窗口跟随，在切换到其他应用或 Codex 最小化时隐藏；没有采用 Windows 的原生子窗口嵌入。Mac 的 Spaces 和全屏行为仍需人工实机验证。

开启 **底角吸附时只露头部** 后，人物停靠左下或右下角时会从侧边和下方收起。向内拖动时逐渐露出全身，向外拖动时继续跟随鼠标；松手靠近底角后，会通过短暂动画回位。其他边缘不再吸附。桌面模式与 Codex 窗口内模式都可使用。

### 自动启动

安装后第一次打开挂件，会为当前用户登记登录助手。**跟随 Codex 桌面端**默认开启：系统登录后，助手会在后台等着，等 Codex 启动再打开挂件。只把 Codex 窗口关到后台，挂件不会跟着退出。如果从托盘手动退出挂件，这次 Codex 运行期间它会保持关闭，直到下次重新启动 Codex。

关闭跟随设置时，也会移除助手的登录登记。系统如果阻止后台启动，设置页会显示原因；也可以检查 Windows 的“启动应用”或 macOS 的“登录项与扩展”。

### 连接可选 Codex 工具

- **Windows：**安装结束时勾选“连接 Codex 插件”，或使用开始菜单中的连接快捷方式。
- **macOS：**在挂件菜单栏选择 **连接 Codex 工具…**，也可使用随安装包提供的连接启动器。

连接器会通过官方 Codex CLI 注册本地插件。连接完成后，重启 Codex 并新建聊天；使用工具时，请让挂件保持运行。连接器也使用安装包自带的运行环境，不用另装 Node.js。本机插件设置只会在你主动运行连接器时修改。

如果连接过插件，卸载挂件前请先运行 Windows 开始菜单中的 **Disconnect Codex plugin**，或 Mac“应用程序”中的 **Codex-Maid-Widget-断开 Codex.command**，然后重启 Codex。断开只移除挂件自己的本地插件，保留形象和设置，也不影响其他插件。Windows 卸载时也会询问是否先断开；静默卸载请提前手动断开。

## 数据与隐私

挂件从本机 Codex app-server 读取额度，从本机会话和归档日志中读取 token 计数事件。登录认证交给 Codex 处理，挂件不读取 `auth.json` 正文，不需要你填写 API key，不发送模型提示词，也没有接入应用分析统计。

导入图片仍默认用文件名命名，自己改的名称也会照常保留在本地。MCP 工具不会带出这些名称，只返回固定的内置形象名或“自定义形象”。

设置、导入的形象和本地插件文件保存在 `~/.codex-maid-widget`。可选控制接口只监听本机回环地址，每次启动都会换一个随机令牌。接口只支持固定的挂件操作，不能执行任意命令或请求任意 URL。

提交问题或截图前，请先去掉账号信息、凭据、个人路径和聊天内容。安全问题的反馈方式见 [SECURITY.md](SECURITY.md)。

## 从源码构建

请准备 **Node.js 22.12 或更新版本**和目标系统的开发环境。依赖版本已写入锁文件。

Windows，在仓库根目录运行：

```powershell
npm ci
npm test
npm run build
node distribution/windows/build.cjs
```

macOS，在 Mac 上运行：

```sh
cd macos
npm ci
npm test
npm run build:installer
```

两端使用同一个发布版本号；版本清单不一致时，构建会报错。打包细节见 [distribution/README.md](distribution/README.md)，想参与开发可以看看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 验证范围

Windows 已在本机检查安装、启动、本地控制、MCP、升级、卸载、分数显示缩放下的拖动和原生窗口内显示。界面渲染、设置、数据解析、底角探头及随 Codex 启动和退出的行为也有自动化检查。Mac 工作流会构建通用安装包，并在 Apple 芯片和 Intel runner 上检查安装、启动、MCP 和 launchd 助手。

这些自动化检查还不能覆盖每个人的使用环境。真实登录账号，以及 Mac 的多屏、Spaces、Retina、声音和退出后重新登录系统等场景，还需要更多实际使用反馈。

## 致谢与许可

- 所有角色插画和应用图标都由 **GPTimage2.5** 生成，图标的不同尺寸和平台格式由这些图片转换而来。项目中的原创图片采用 [CC BY 4.0](licenses/CC-BY-4.0.txt)，复用时请署名 **Codex Maid Widget contributors** 并链接本仓库。具体说明见[素材来源](docs/asset-provenance.md)。
- 感谢 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DeepSeek／DSH 小鲸鱼挂件）的维护者和贡献者。这个挂件的桌面陪伴、气泡、拖动吸附和互动设计，借鉴了他们的项目。
- 也参考了 [Yang-huai406/Codex-Whale-Public](https://github.com/Yang-huai406/Codex-Whale-Public) 的 Codex 桌面伴随方案。显隐恢复模块适配其 MIT 实现并保留许可；界面、形象与额度读取分别实现，未分发这两个参考项目的小鲸鱼图片、动图或音频。
- 感谢 [Electron](https://www.electronjs.org/)、[Node.js](https://nodejs.org/)、[Inno Setup](https://jrsoftware.org/isinfo.php)，以及 Codex app-server 和插件接口。各项依赖保留各自的许可证。
- 随附的 OpenAI 标志来自 [OpenAI Agents 官方仓库](https://github.com/openai/openai-agents-python/blob/main/docs/assets/logo.svg)，不属于本项目图片许可的范围，不授予商标权，也不代表 OpenAI 为本项目背书。

本项目原创代码采用 [MIT](LICENSE) 许可。图片与第三方说明见 [NOTICE](NOTICE) 及[素材来源](docs/asset-provenance.md)。本项目由社区独立开发，不是 OpenAI 官方产品。
