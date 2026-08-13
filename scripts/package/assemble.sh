#!/usr/bin/env bash
#
# 组装最终发布包：把 PyInstaller 产物 + 前端构建产物 + 启动器 + 配置模板
# 拼成一个解压即用的目录，再打成 zip。在 CI 中由 workflow 调用。
#
# 用法：bash scripts/package/assemble.sh <包名> <启动器文件名>
#   例：bash scripts/package/assemble.sh MaestrWave-macOS Start-MaestrWave.command
#
set -euo pipefail

ARTIFACT="${1:?缺少包名}"      # 例如 MaestrWave-macOS
LAUNCHER="${2:?缺少启动器}"    # Start-MaestrWave.command 或 Start-MaestrWave.bat
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG_DIR="$ROOT/dist-pkg/$ARTIFACT"
ZIP_PATH="$ROOT/dist-pkg/${ARTIFACT}.zip"

echo "==> 组装发布包：$ARTIFACT"
rm -rf "$PKG_DIR" "$ZIP_PATH"
mkdir -p "$PKG_DIR"

# 1) PyInstaller onedir 产物（含可执行文件与 _internal/）
[ -d "$ROOT/dist/MaestrWave" ] || { echo "!! 找不到 dist/MaestrWave，先运行 pyinstaller" >&2; exit 1; }
cp -R "$ROOT/dist/MaestrWave" "$PKG_DIR/MaestrWave"

# 2) 前端构建产物（backend/app.py 的 / 路由从这里 serve index.html）
[ -f "$ROOT/frontend/dist/index.html" ] || { echo "!! 找不到 frontend/dist/index.html，先 npm run build" >&2; exit 1; }
mkdir -p "$PKG_DIR/frontend"
cp -R "$ROOT/frontend/dist" "$PKG_DIR/frontend/dist"
# netinfo.py 读 frontend/package.json 拿版本号，一并带上（读取失败也有兜底）
cp "$ROOT/frontend/package.json" "$PKG_DIR/frontend/package.json"

# 3) 音源（写谱演奏模式的采样音色）。放在包内固定位置，启动器用
#    SOUNDFONT_DIR 指过去 —— 打包后 backend/config.py 的 __file__ 落在
#    _internal/ 里，靠它推路径会找不到。
if [ -d "$ROOT/backend/soundfonts" ]; then
  mkdir -p "$PKG_DIR/soundfonts"
  cp -R "$ROOT/backend/soundfonts/." "$PKG_DIR/soundfonts/"
  echo "==> 已带上音源：$(du -sh "$PKG_DIR/soundfonts" | cut -f1)"
else
  echo "⚠️  backend/soundfonts 不存在，发布包将只有内置合成音色"
fi

# 4) fluidsynth 及其依赖库（可选，由 CI 的 bundle-fluidsynth 步骤准备）
if [ -d "$ROOT/dist-deps/fluidsynth" ]; then
  mkdir -p "$PKG_DIR/fluidsynth"
  cp -R "$ROOT/dist-deps/fluidsynth/." "$PKG_DIR/fluidsynth/"
  chmod +x "$PKG_DIR/fluidsynth/fluidsynth" 2>/dev/null || true
  echo "==> 已带上 fluidsynth：$(du -sh "$PKG_DIR/fluidsynth" | cut -f1)"
fi

# 5) 运行时数据目录（启动器会在本机运行时创建，先放一个占位）
mkdir -p "$PKG_DIR/output"

# 6) 启动器 / 配置模板 / 说明
cp "$ROOT/scripts/package/$LAUNCHER" "$PKG_DIR/$LAUNCHER"
cp "$ROOT/scripts/package/config.env" "$PKG_DIR/config.env"
cp "$ROOT/scripts/package/PACKAGE_README.txt" "$PKG_DIR/README.txt"

# 7) macOS 启动器需要可执行权限
if [[ "$LAUNCHER" == *.command ]]; then
  chmod +x "$PKG_DIR/$LAUNCHER"
fi

# 8) 打包
#
# GitHub 的 Windows runner 上没有 zip：Git Bash 不带这个命令，assemble.sh 会以
# 127 退出。所以这里分两条路，**zip 存在时走的还是原来那一行**，macOS 与 Linux
# 的行为一字未改；只有找不到 zip 才退到 Python 的 zipfile。
#
# 退到 Python 而不是 PowerShell 的 Compress-Archive，是因为 Python 在这条流水线里
# 是确定存在的（前面的 Setup Python 步骤刚装过），而 Compress-Archive 对 PyInstaller
# 这种上千个小文件的目录出了名的慢。zipfile 也保留 Unix 权限位（ZipInfo.from_file
# 会把 st_mode 写进 external_attr），换平台解压出来 .command 仍是可执行的。
cd "$ROOT/dist-pkg"
if command -v zip >/dev/null 2>&1; then
  zip -r -q "${ARTIFACT}.zip" "$ARTIFACT"
else
  echo "==> 未找到 zip，改用 Python zipfile 打包"
  PY=""
  for c in python3 python py; do
    command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
  done
  [ -n "$PY" ] || { echo "!! zip 和 Python 都没有，无法打包" >&2; exit 1; }
  # base_dir 限定只收 $ARTIFACT/ 这一层，生成的 zip 是它的兄弟，不会把自己卷进去
  "$PY" -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', root_dir='.', base_dir=sys.argv[1])" "$ARTIFACT"
fi
[ -f "$ZIP_PATH" ] || { echo "!! 打包没有产出 $ZIP_PATH" >&2; exit 1; }
echo "==> 完成：$ZIP_PATH"
