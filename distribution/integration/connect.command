#!/bin/bash
set -eu
maid_payload="$(cd -- "$(dirname -- "$0")" && pwd)"
maid_executable="$maid_payload/../../MacOS/Codex-Maid-Widget"
printf '%s\n' '将通过 Codex 自带的命令行注册并安装女仆挂件插件。无需 Node.js 或项目源码。' '请先安装并登录 Codex。'
if ! /usr/bin/osascript -e 'display dialog "将注册并安装本地挂件插件。完成后请重启 Codex 并新建聊天。" with title "连接 Codex 女仆挂件" buttons {"取消", "连接"} default button "连接" cancel button "取消"' >/dev/null; then
  exit 0
fi
if ELECTRON_RUN_AS_NODE=1 "$maid_executable" "$maid_payload/connect.cjs" --install; then
  /usr/bin/osascript -e 'display dialog "插件已连接。请重启 Codex 并新建聊天，并保持桌面挂件运行。" with title "Codex 女仆挂件" buttons {"好"} default button "好"' >/dev/null
else
  /usr/bin/osascript -e 'display dialog "连接失败。请在终端查看上方错误，安装或更新 Codex 后重试。" with title "Codex 女仆挂件" buttons {"好"} default button "好"' >/dev/null
  exit 1
fi
