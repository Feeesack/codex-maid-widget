# Codex 女仆额度挂件

[English](README.md) | **简体中文**

联系邮箱：[feeesack9449@gmail.com](mailto:feeesack9449@gmail.com)

给 Codex 配一个桌面小伙伴，看看剩余额度和本机 token 用量。检测到一轮任务完成时，角色会“duang”地跳一下，提醒你放下手机，回来看看结果。

<img src="assets/icons/app-128.png" width="72" alt="Codex 女仆额度挂件应用图标">

## 界面预览

以下为 0.3.48 Windows 界面的实际渲染截图，使用**合成演示数据**。账号名、对话名、额度及仓库计数均为示例；当前设置与桌宠聊天界面已有更新。点击图片可查看原图。

| 新小龙娘与额度倒计时 | 对话上下文与 Git 状态 | 多账号独立倒计时 |
| --- | --- | --- |
| [<img src="docs/screenshots/release-0.3.48-quota.png" width="270" alt="新小龙娘与额度、重置倒计时，演示数据">](docs/screenshots/release-0.3.48-quota.png) | [<img src="docs/screenshots/release-0.3.48-conversation.png" width="270" alt="上下文占用、未提交文件与压缩次数，演示数据">](docs/screenshots/release-0.3.48-conversation.png) | [<img src="docs/screenshots/release-0.3.48-accounts.png" width="270" alt="多账号独立重置倒计时，虚构账号">](docs/screenshots/release-0.3.48-accounts.png) |

| 气泡页面顺序与显隐 | 外观、探头宽度与音色 | 内置与导入形象库 |
| --- | --- | --- |
| [<img src="docs/screenshots/release-0.3.48-pages.png" width="270" alt="气泡页面顺序、显示与默认页设置">](docs/screenshots/release-0.3.48-pages.png) | [<img src="docs/screenshots/release-0.3.48-appearance.png" width="270" alt="底边与侧边藏入宽度滑块及音色选择">](docs/screenshots/release-0.3.48-appearance.png) | [<img src="docs/screenshots/release-0.3.48-characters.png" width="270" alt="形象库展示两种新小龙娘姿态与原有角色">](docs/screenshots/release-0.3.48-characters.png) |

## 下载与安装

**v0.5.14 已发布。** Windows x64 与 macOS 13+ 通用安装包均已提供；本次新增桌宠聊天与持久记忆、归档和用量管理、设置分类、聊天恢复，以及重置预测与公告提醒接入。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [Windows 安装包（.exe）](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.5.14/Codex-Maid-Widget-0.5.14-windows-x64-setup.exe) |
| macOS 13 及以上，Apple 芯片与 Intel | [Mac 通用安装包（.pkg）](https://github.com/Feeesack/codex-maid-widget/releases/download/v0.5.14/Codex-Maid-Widget-0.5.14-macOS-universal.pkg) |

更新说明和 SHA-256 校验值放在 [Releases](https://github.com/Feeesack/codex-maid-widget/releases)。安装包已带上运行环境和可选的本地 Codex 插件，不用另装 Node.js、npm，也不用下载源码。

当前源码维护版本为 **0.5.15**，修复聊天项目目录迁移并更新 CI 测试夹具；上方下载仍是已发布的 **v0.5.14** 安装包。详见[更新记录](CHANGELOG.md)。

[0.3.48 发布说明](docs/releases/0.3.48.md)汇总了 0.3.21 以来的更新：按下／抬起两段互动，含「DSH 小黄鸭」的五套音色，多账号重置提醒，两种新小龙娘形象，对话上下文、压缩次数与 Git 状态，Motion 镜像动画，Hugeicons 图标，页面排序与显隐，外观及探头宽度实时预览，以及 Windows 安装路径修复。各音效来源与独立许可范围见[音频资料](docs/interaction-audio.md)。

[0.5.14 发布说明](docs/releases/0.5.14.md)介绍本次更新，前置本地更新见[更新记录](CHANGELOG.md)。Windows 设置、导入形象和原始素材保留；macOS 通用安装包已在 Apple Silicon 与 Intel 环境完成安装启动验证。Spaces、全屏、多屏、Retina、声音和登录会话的人工体验仍需单独验收。

1. 先安装官方 Codex 桌面应用并登录，挂件才有真实账号额度可读。
2. 运行安装包，从 Windows 开始菜单或 macOS“应用程序”中打开挂件。
3. 点击齿轮、右键角色，或使用系统托盘／菜单栏菜单调整设置。

0.3.49 起可在设置顶部的 **界面语言** 中选择 **简体中文 / English**，立即生效并在下次启动时保留。默认保持中文；英文针对长单词和说明文字调整排版，自定义名称、台词及项目名称保留原文。

目前的安装包没有开发者分发证书。Mac 应用使用 ad-hoc 签名，安装包尚未经过 Apple 公证，安装时系统可能会要求确认来源。请从本仓库的 Releases 下载，并核对附带的校验值。

## 能做什么

- 查看额度剩余百分比和重置倒计时，选择不同额度桶，自动刷新或手动点一下刷新。
- 查看今日、本周和本机最近完成一轮的 token 用量，不用另开统计页面。
- 偶尔“duang”一下：检测到新完成一轮时，角色会弹跳并播放一声短音效；点击角色或使用快捷键也能触发。音效可以关闭，刷手机时听见了，记得回来看看。
- 跟着 Codex 自启动：登录助手在后台等待，打开 Codex 时显示挂件，完全退出 Codex 后挂件也会退出。这个功能可以在设置中关闭。
- 在四个内置角色之间切换，或把自己的图片导入本机形象库。台词可以自己写，气泡颜色会随角色匹配。
- 可选桌宠图文聊天：通过已登录的 Codex 账号发送，支持流式回答、中断、模型选择和专用聊天项目。聊天及模型维护会消耗账号额度，不需要另配 API key。
- 持久保存人设、用户偏好与事实档案，支持带原图的检查点归档、离线历史检索及受控换聊。归档标题、标签、收藏和隐藏状态写入独立元数据，原始记录保留。
- 聊天管理分为当前聊天、用量记录、归档历史、记忆档案、换聊与维护、做梦维护、项目与模型七页。聊天原生 token 账本与全设备日志用量分开，缺失计量保持未知。
- 聊天气泡和展开书写卡片共用输入框，保留草稿、选区、输入法组合状态及发送期间的新输入。Enter 换行，Ctrl/Cmd+Enter 发送，Escape 收起。
- 设置按五类导航，中英切换保留编辑草稿。聊天核对显示进度与具体错误；兼容的容量证明可在程序或 CLI 升级后恢复，不重发未知请求或擅自换聊。
- 重置预测页优先醒目显示 Tibo 明确信号与真实目标倒计时，24/48 小时概率作为次要信息，常驻上次重置时间与数据新鲜度，数据来自 [codex-reset.com](https://codex-reset.com/)。社区预测不保证重置，也不替代真实账号额度。详见 [0.5.14 发布说明](docs/releases/0.5.14.md)。
- 重置提醒接入 `codex-reset.com` 的受限公开公告与观察数据，显示来源引用、公告/观察截止时间和 stale/offline 状态；公告、观察、Tibo 自述与真实额度确认保持分层。每个本机观察账号的五小时窗口到期后，用挂件文字、一秒四次弹跳和一次短音提醒，去重且可关闭，历史估算标记为待登录确认，网络失败不阻塞启动。
- 拖动挂件时保持人物大小，支持底角吸附、左右镜像、大小、透明度、置顶和鼠标穿透。人物拖过屏幕中线就会转向，位置会保存，下次打开不用重新摆。
- 可选窗口内显示：Windows 可将人物固定在 Codex 主窗口内，随窗口移动、收起和展开；macOS 使用独立挂件窗口跟随 Codex 的范围和显隐。
- 可选“底角吸附时只露头部”：停在两个底角时探头，向内拽出时逐渐露出全身，松手靠近底角后平滑吸附。
- 气泡自动收起支持 3、5、10、30、60 秒或始终显示，默认 5 秒；升级时保留已保存的选择。
- 呼吸、弹跳、数字滚动和额度流光动画始终开启，音效可单独关闭。
- 装上可选的本地 MCP 插件后，可以让 Codex 查询状态、刷新额度、显示／隐藏挂件、让角色弹跳或打开设置。
- 对话页显示所选对话名称、项目、上下文使用进度、Git 未提交文件数与压缩次数。翻到该页或点击气泡时读取，不新增对话后台轮询；支持自动识别与手动回退，手选列表最多显示最近 30 条符合条件的本地对话。压缩次数是本地检查点确认的自动与手动合计，历史不完整时会标注。Git 数字为工作区未提交文件数，包括未跟踪文件，不是尚未推送的提交数。
- 第三页为账号管理：自动名称采用真正的资料昵称，确切工作空间名存在时附带显示；邮箱、账户名和 `@` 用户名只作辅助资料，不充当昵称。手动别名始终保留，清空别名可恢复自动。读取不到时明确显示“昵称未读取”，旧记录需重新登录观察才可补齐。经用户授权，可在本机进程内只读现有登录凭据向官方资料接口获取昵称和工作空间名，不刷新登录、不保存令牌；显示资料仅留本机、不进入 MCP。每项显示已观察五小时窗口的重置进度与倒计时，到期仅用挂件文字、一秒连续四次弹跳和一次短音提醒，不弹系统通知。历史记录到期标注预计恢复、待登录确认；提醒和声音可关闭。
- 按下与抬起分别搭配动作和声音，连点从当前姿态自然续接，拖动时保持按下、松手后回弹。设置中提供五套音色与遵循静音开关的试听。
- 气泡页面支持拖拽排序、显隐与启动默认页，使用 SortableJS，并保留键盘排序。上一页／下一页箭头按设置中的可见顺序双向循环。
- 大小与不透明度支持拖动实时预览。底角探头可分别调节底边、侧边藏入宽度（0%–200%），默认 50% 和 100%，保留原有选择。Motion 负责镜像动画，Hugeicons 统一工具栏与页面编辑图标。

额度百分比对应当前登录的 Codex 账号。Token 用量则从本机各账号的可用会话日志中汇总，本周从本地时间周一零点算起；记录缺失或不完整时会标出来。这些数字只反映本机日志，不是金额账单，也不是账号在所有设备上的总用量。

## 日常操作

| 操作 | 方式 |
| --- | --- |
| 移动 | 拖动角色或气泡 |
| 刷新 | 点击气泡或刷新按钮 |
| 切换气泡 | 上一页／下一页箭头：额度、对话、账号、今日、本周、最近一轮、台词、重置预测及可选聊天；顺序与显隐可设置 |
| 桌宠聊天 | 在设置中开启聊天页，建立或恢复聊天项目，再使用编辑按钮或聊天管理窗口 |
| 书写／发送 | Enter 换行；Windows Ctrl+Enter、Mac Cmd+Enter 发送；Escape 收起书写卡片 |
| 弹跳／互动 | 点击角色或爱心；窗口获得焦点后按 `Q` 或空格 |
| 设置 | 齿轮、右键或托盘／菜单栏 |
| 显示／隐藏 | Windows `Ctrl+Alt+M`；Mac `Control+Option+M` |
| 弹跳 | Windows `Ctrl+Alt+Q`；Mac `Control+Option+Q` |
| 切换鼠标穿透 | Windows `Ctrl+Alt+Shift+M`；Mac `Control+Option+Shift+M` |
| 重置位置／退出 | 托盘／菜单栏菜单 |

如果快捷键有冲突，可以用托盘／菜单栏操作。气泡自动收起后，把鼠标移到角色上就会重新显示。

### 窗口内显示与底角探头

这两个选项默认关闭。Windows 在设置中开启 **固定在 Codex 窗口内** 后，人物会保持在 Codex 窗口范围内，随主窗口移动、收起和展开。桌宠仍是独立顶层窗口，由 Codex 主窗口作为 owner 维持关系，可正常接收文字输入；其他应用按正常窗口层级遮挡。关闭后恢复已保存的桌面位置和置顶偏好。

macOS 对应选项名为 **仅在 Codex 窗口内显示**，使用独立窗口跟随，在切换到其他应用或 Codex 最小化时隐藏。Mac 的 Spaces 和全屏行为仍需人工实机验证。

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

额度与全设备用量显示从本机 Codex app-server 和会话记录读取数值元数据，这些显示功能不发送模型提示词。挂件不需要单独的 API key，也没有应用分析统计。

桌宠聊天为可选功能，通过 Codex 使用已登录的 ChatGPT 账号。发送消息时，文字、附件图片和必要的项目记忆会发送到模型服务；检查点整理和做梦维护同样会调用模型、消耗账号额度。建立聊天项目后，请在维护页查看做梦模式：自动模式在空闲、额度与维护条件满足时可启动；希望自行启动时请选择手动模式。界面中的做梦预算是估算目标，不是绝对费用上限。

桌宠归档、原图、记忆修订、检索索引和聊天原生 token 账本存放在你选择的项目目录。模型请求可包含从该项目选取的有界上下文；隐藏思考不归档，用量账本不保存消息正文。同设备切换登录账号时仍共用该桌宠项目。

为显示账号昵称与工作空间名，打包应用可在主进程内使用现有本机登录凭据，向固定官方资料接口发起只读请求。它不刷新登录，不将凭据写入账号记录、日志、本地控制响应或 MCP。显示名称与账号别名仅留本机，资料读取失败不影响额度读取。

导入图片仍默认用文件名命名，自己改的名称也会照常保留在本地。MCP 工具不会带出这些名称，只返回固定的内置形象名或“自定义形象”。

设置、导入的形象和本地插件文件保存在 `~/.codex-maid-widget`。可选控制接口只监听本机回环地址，每次启动都会换一个随机令牌。接口只支持固定的挂件操作，不能执行任意命令或请求任意 URL。

提交问题或截图前，请先去掉账号信息、凭据、个人路径和聊天内容。安全问题的反馈方式见 [SECURITY.md](SECURITY.md)。

## 从源码构建

请准备 **Node.js 22.12 或更新版本**和目标系统的开发环境。依赖版本已写入锁文件。

Windows，在仓库根目录运行：

```powershell
npm ci
node scripts/prepare-chat-semantic.cjs --download
npm test
npm run build
node distribution/windows/build.cjs
```

macOS，在 Mac 上运行：

```sh
cd macos
npm ci
node scripts/prepare-chat-semantic.cjs --download
npm test
npm run build:installer
```

两端使用同一个发布版本号；版本清单不一致时，构建会报错。打包细节见 [distribution/README.md](distribution/README.md)，想参与开发可以看看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 验证范围

Windows 0.5.14 已有主程序、助手与 MCP 同版本、非演示额度、本地控制及用户资料保全的运行证据。最新定向回归通过 47 项测试；隔离气泡检查覆盖双端源码、中英和三种尺寸，共 12 场景、24 张截图。前置容量恢复回归通过 157 项。各项结果只覆盖对应改动，不代表重新通过全量测试。

Worker 关闭生命周期修复后的真实语义后端定向服务回归已通过，之前的 V8 原生崩溃未再复现；检索生命周期回归也通过。完整跨平台套件仍有本机窗口夹具和平台环境相关失败，因此不宣称全量通过。完整真实聊天、Terra 发送、输入焦点手感和长期记忆质量仍需用户反馈。

CI 不代替 Mac 多屏、Spaces、全屏、Retina、声音及登录会话的人工体验。主观音量、动画手感、真实五小时提醒和 Windows 注销重登也仍需人工验收。

## 致谢与许可

- 据项目作者说明，原有薄荷女仆、淡紫龙女仆和应用图标由 **GPTimage2.5** 生成，这些素材采用 [CC BY 4.0](licenses/CC-BY-4.0.txt)，复用时请署名 **Codex Maid Widget contributors** 并链接本仓库。新增两张「小龙娘」图片由用户提供，已授权在本项目内置使用及命名；这里不声明额外独立版权或再许可。具体范围见[素材来源](docs/asset-provenance.md)和[图片许可](ARTWORK_LICENSE.md)。
- 感谢 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DeepSeek／DSH 小鲸鱼挂件）的维护者和贡献者。桌面陪伴、气泡、拖动吸附与互动设计参考了他们的项目。新小龙娘也参考其圆腮、大眼、略微低眉的视觉风格，同时保留本项目 GPT 小龙娘特征。「DSH 小黄鸭」音效来源与独立权利范围见[音频资料](docs/interaction-audio.md)。
- 也参考了 [Yang-huai406/Codex-Whale-Public](https://github.com/Yang-huai406/Codex-Whale-Public) 的 Codex 桌面伴随方案。显隐恢复模块适配其 MIT 实现并保留许可，界面、形象与额度读取分别实现。
- [Hugeicons](https://github.com/hugeicons/hugeicons)、[Motion](https://github.com/motiondivision/motion) 与 [SortableJS](https://github.com/SortableJS/Sortable) 分别提供免费图标子集、镜像动画与页面排序，固定版本素材与 MIT 许可随项目本地打包。互动音效还包括 CC0 的 [Kenney](https://kenney.nl/assets/interface-sounds) 素材与本项目合成啾啾声，见[音频资料](docs/interaction-audio.md)。
- 感谢 [Electron](https://www.electronjs.org/)、[Node.js](https://nodejs.org/)、[Inno Setup](https://jrsoftware.org/isinfo.php)，以及 Codex app-server 和插件接口。各项依赖保留各自的许可证。
- 随附的 OpenAI 标志来自 [OpenAI Agents 官方仓库](https://github.com/openai/openai-agents-python/blob/main/docs/assets/logo.svg)，不属于本项目图片许可的范围，不授予商标权，也不代表 OpenAI 为本项目背书。

本项目原创代码采用 [MIT](LICENSE) 许可。图片与第三方说明见 [NOTICE](NOTICE) 及[素材来源](docs/asset-provenance.md)。本项目由社区独立开发，不是 OpenAI 官方产品。
