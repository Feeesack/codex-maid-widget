#!/bin/bash
set -eu
maid_payload="$(cd -- "$(dirname -- "$0")" && pwd)"
maid_executable="$maid_payload/../../MacOS/Codex-Maid-Widget"
printf '%s\n' '使用 Codex 自带的命令行连接或断开本项目插件。无需 Node.js 或项目源码。'
if ! maid_action="$(/usr/bin/osascript -e 'button returned of (display dialog "连接或断开 Codex 女仆挂件的本地插件。断开会保留其他插件、挂件设置与导入形象；卸载应用前请先断开。完成后请重启 Codex 并新建聊天。" with title "Codex 女仆挂件" buttons {"取消", "断开", "连接"} default button "连接" cancel button "取消")')"; then
  exit 0
fi
case "$maid_action" in
  '连接') maid_option='--install' ;;
  '断开') maid_option='--remove' ;;
  *) exit 0 ;;
esac
if ELECTRON_RUN_AS_NODE=1 "$maid_executable" "$maid_payload/connect.cjs" "$maid_option"; then
  /usr/bin/osascript -e 'display dialog "插件操作已完成。请重启 Codex 并新建聊天；已断开时可以卸载应用。" with title "Codex 女仆挂件" buttons {"好"} default button "好"' >/dev/null
else
  /usr/bin/osascript -e 'display dialog "插件操作失败，尚未卸载应用。请在终端查看上方错误，安装或更新 Codex 后重试。" with title "Codex 女仆挂件" buttons {"好"} default button "好"' >/dev/null
  exit 1
fi
