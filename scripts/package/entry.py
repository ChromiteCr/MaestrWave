"""
PyInstaller 打包入口：以零代码修改方式启动 MaestrWave 后端。

为什么需要这个文件：
  backend/app.py 用 `Path(__file__).resolve().parent.parent` 推导项目根，
  打包后模块位于 `_internal/` 下，推导路径会错（找不到 frontend/dist）。
  这里在 import 后把 frontend/dist 的位置显式指回去，并补挂 /assets 静态目录，
  与 app.py 生产模式的挂载行为保持一致，不改动任何业务代码。

运行时数据目录（output/）由启动器通过环境变量 OUTPUT_DIR / PROJECTS_DIR
交给 backend/config.py（它本来就支持环境变量覆盖），同样无需改代码。
"""
import os
import sys
from pathlib import Path

# PyInstaller onedir 模式下 sys._MEIPASS 指向解压根/_internal，其 parent 即解压根
APP_ROOT = (
    Path(sys._MEIPASS).parent
    if getattr(sys, "_MEIPASS", None)
    else Path(__file__).resolve().parent
)

# 先让 backend 包完成常规 import（含 /api /audio /project-audio 挂载等）
from backend import app as backend_app  # noqa: E402

# 打包后前端 dist 位于 解压根/frontend/dist，显式重定向，避免依赖 __file__ 推导
_dist = APP_ROOT / "frontend" / "dist"
if _dist.exists():
    backend_app.FRONTEND_DIST_DIR = _dist
    # app.py 在模块加载时若 dist 不存在则不会挂载 /assets，这里补上
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    assets_dir = _dist / "assets"
    if assets_dir.exists():
        backend_app.app.mount(
            "/assets",
            StaticFiles(directory=str(assets_dir)),
            name="frontend-assets",
        )


def main() -> None:
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "3000"))
    # 直接传 app 对象而非字符串，避免打包环境下二次 import 出问题
    uvicorn.run(backend_app.app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
