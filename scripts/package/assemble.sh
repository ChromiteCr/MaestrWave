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

# 3) 运行时数据目录（启动器会在本机运行时创建，先放一个占位）
mkdir -p "$PKG_DIR/output"

# 4) 启动器 / 配置模板 / 说明
cp "$ROOT/scripts/package/$LAUNCHER" "$PKG_DIR/$LAUNCHER"
cp "$ROOT/scripts/package/config.env" "$PKG_DIR/config.env"
cp "$ROOT/scripts/package/PACKAGE_README.txt" "$PKG_DIR/README.txt"

# 5) macOS 启动器需要可执行权限
if [[ "$LAUNCHER" == *.command ]]; then
  chmod +x "$PKG_DIR/$LAUNCHER"
fi

# 6) 打包
cd "$ROOT/dist-pkg"
zip -r -q "${ARTIFACT}.zip" "$ARTIFACT"
echo "==> 完成：$ZIP_PATH"
