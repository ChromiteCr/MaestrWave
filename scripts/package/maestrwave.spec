# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：MaestrWave 后端（onedir 模式）。

用法（在项目根目录执行）：
    pyinstaller scripts/package/maestrwave.spec --noconfirm

产物：dist/MaestrWave/（目录内含可执行文件 + _internal/），
由 scripts/package/assemble.sh 组装成最终发布包。
"""

from PyInstaller.utils.hooks import collect_all

# uvicorn[standard] 的依赖多为动态导入，逐个 collect_all 保证运行时能找到
datas, binaries, hiddenimports = [], [], []
for _pkg in ("uvicorn", "websockets", "httpx", "aiofiles", "httptools", "watchfiles"):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

a = Analysis(
    ["scripts/package/entry.py"],
    pathex=["."],  # 项目根：让 `from backend import app` 及包内相对导入可解析
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MaestrWave",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # 保留控制台窗口：双击启动器后能看到日志，便于排查
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="MaestrWave",
)
