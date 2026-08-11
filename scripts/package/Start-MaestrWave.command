#!/bin/bash
#
# MaestrWave 一键启动（macOS）——双击本文件即可，无需任何命令行。
#
# 首次运行若系统提示「无法验证开发者」：右键点本文件 → 打开 → 再点「打开」一次即可。
# 如需停止：回到终端窗口按 Ctrl+C，或直接关掉终端窗口。

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

# 可选配置（TME 云端生成密钥、端口等）：用文本编辑器打开同目录 config.env 填写
if [ -f config.env ]; then
  set -a
  # shellcheck disable=SC1091
  source config.env
  set +a
fi

# 运行时数据（生成的项目/音频）写入解压目录，便于持久化
export OUTPUT_DIR="$(pwd)/output/sessions"
export PROJECTS_DIR="$(pwd)/output/projects"
mkdir -p "$OUTPUT_DIR" "$PROJECTS_DIR"

# 写谱演奏模式的音源与外部合成器。打包后 backend/config.py 的 __file__ 落在
# _internal/ 里，靠它推不出这两个路径，所以由启动器显式指定。
export SOUNDFONT_DIR="$(pwd)/soundfonts"
export SCORE_PREFS_PATH="$(pwd)/output/score_prefs.json"
if [ -x "$(pwd)/fluidsynth/fluidsynth" ]; then
  export PATH="$(pwd)/fluidsynth:$PATH"
  export DYLD_LIBRARY_PATH="$(pwd)/fluidsynth:${DYLD_LIBRARY_PATH:-}"
fi

echo "▶ 正在启动 MaestrWave 后端…"
./MaestrWave/MaestrWave &
BACKEND_PID=$!

# 等待端口就绪后自动打开浏览器
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:${PORT:-3000}/"; then break; fi
  sleep 0.5
done
echo "▶ 已在浏览器打开 http://localhost:${PORT:-3000}"
open "http://localhost:${PORT:-3000}"

# 保持终端窗口可见，方便看日志；Ctrl+C 停止服务
wait "$BACKEND_PID"
