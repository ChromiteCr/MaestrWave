#!/usr/bin/env python3
"""把 fluidsynth 及其全部依赖库收进 dist-deps/fluidsynth/，供发布包携带。

只在 CI 里跑（见 .github/workflows/release-build.yml）。产物由
`scripts/package/assemble.sh` 复制进发布包，启动器把它加进 PATH。

**为什么不能直接 cp 一个可执行文件**：macOS 的动态库路径是写死在二进制里的
（`/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib` 这种绝对路径），拷到没装
Homebrew 的机器上会直接「找不到库」而启动失败。所以要把递归依赖全收过来，
再用 install_name_tool 把每一处引用改写成 `@loader_path/…` 的相对形式。

Windows 上 DLL 的查找规则是「和 exe 同目录」，把 dll 拷到一起即可，不用改写。

用法：
    python3 scripts/package/bundle_fluidsynth.py dist-deps/fluidsynth
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

# 系统自带的库不要收：它们在每台机器上都有，收进来反而可能和系统版本冲突
SYSTEM_PREFIXES = ("/usr/lib/", "/System/", "/Library/Frameworks/")


def macos_deps(binary: Path) -> dict[str, Path]:
    """递归收集非系统依赖，返回「二进制里**记录的那个字符串** → 实际文件」。

    必须按记录的字符串来，不能按解析后的真实路径：Homebrew 里记的是符号链接
    （`/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib`），真实文件在 Cellar 下，
    文件名也可能不同（记 `libfluidsynth.3.dylib`，实际是 `libfluidsynth.3.5.6.dylib`）。
    而 `install_name_tool -change` 只认二进制里逐字节相同的那个字符串。
    """
    found: dict[str, Path] = {}

    def walk(p: Path) -> None:
        out = subprocess.run(["otool", "-L", str(p)],
                             capture_output=True, text=True).stdout
        for line in out.splitlines()[1:]:
            m = re.match(r"\s+(\S+)", line)
            if not m:
                continue
            dep = m.group(1)
            if dep.startswith(SYSTEM_PREFIXES) or dep.startswith("@") or dep in found:
                continue
            real = Path(dep)
            if not real.exists():
                continue
            found[dep] = real
            walk(real)

    walk(binary)
    return found


def bundle_macos(dst: Path) -> None:
    exe = shutil.which("fluidsynth")
    if not exe:
        raise SystemExit("PATH 里没有 fluidsynth，先 brew install fluid-synth")
    exe = Path(exe).resolve()

    deps = macos_deps(exe)
    dst.mkdir(parents=True, exist_ok=True)

    def put(src: Path, name: str) -> Path:
        out = dst / name
        if out.exists():
            out.unlink()          # Homebrew 的库是 444，copy2 覆盖不上去
        shutil.copy2(src, out)
        os.chmod(out, 0o755)      # 要先可写，install_name_tool 才改得动
        return out

    put(exe, "fluidsynth")
    # 用**记录的**文件名落盘，这样引用改写后名字对得上
    for recorded, real in deps.items():
        put(real, Path(recorded).name)

    rewrite = {rec: f"@loader_path/{Path(rec).name}" for rec in deps}
    targets = [dst / "fluidsynth"] + [dst / Path(r).name for r in deps]
    for target in targets:
        os.chmod(target, 0o755)
        # 库自己的 install_name 也要改，否则别的库仍按绝对路径找它
        if target.name != "fluidsynth":
            subprocess.run(["install_name_tool", "-id",
                            f"@loader_path/{target.name}", str(target)],
                           capture_output=True)
        for old, new in rewrite.items():
            subprocess.run(["install_name_tool", "-change", old, new, str(target)],
                           capture_output=True)
        # 重签名：改过 Mach-O 之后原签名失效，Apple Silicon 上会直接拒绝执行
        subprocess.run(["codesign", "--force", "--sign", "-", str(target)],
                       capture_output=True)

    # 逐个文件复查，不只查主程序 —— 漏改的往往是库对库的引用
    bad = []
    for target in targets:
        out = subprocess.run(["otool", "-L", str(target)],
                             capture_output=True, text=True).stdout
        for line in out.splitlines()[1:]:
            if "/opt/homebrew" in line or "/usr/local/Cellar" in line:
                bad.append(f"  {target.name}: {line.strip()}")
    if bad:
        raise SystemExit("仍有绝对路径没改写干净：\n" + "\n".join(bad))

    total = sum(f.stat().st_size for f in dst.iterdir()) / 1024 / 1024
    print(f"✔ macOS：收了 {len(deps) + 1} 个文件，{total:.1f} MB")


def bundle_windows(dst: Path) -> None:
    exe = shutil.which("fluidsynth") or shutil.which("fluidsynth.exe")
    if not exe:
        raise SystemExit("PATH 里没有 fluidsynth")
    src = Path(exe).resolve().parent
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in src.iterdir():
        if f.suffix.lower() in (".exe", ".dll"):
            shutil.copy2(f, dst / f.name)
            n += 1
    total = sum(f.stat().st_size for f in dst.iterdir()) / 1024 / 1024
    print(f"✔ Windows：收了 {n} 个文件，{total:.1f} MB")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "dist-deps/fluidsynth")
    if platform.system() == "Darwin":
        bundle_macos(out)
    elif platform.system() == "Windows":
        bundle_windows(out)
    else:
        raise SystemExit(f"暂不支持 {platform.system()}")
