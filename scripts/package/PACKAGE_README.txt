MaestrWave 一键启动包
======================

感谢下载 MaestrWave！这是一个解压即用的绿色发布包，不需要安装任何
运行环境（Python / Node 都已打包在内），也不需要敲任何命令行。

快速开始
--------
1. 把本 zip 解压到任意目录。
2. 双击：
   - macOS ：Start-MaestrWave.command（首次若提示无法验证开发者，
     右键 → 打开 → 再点「打开」一次）
   - Windows：Start-MaestrWave.bat
3. 浏览器会自动打开 http://localhost:3000 ，开始生成音乐与指挥体验。

功能说明
--------
- 生成音乐：AI 生成管弦乐素材。默认使用占位音频（演示链路完整可用）；
  想用腾讯天琴云端真实生成，编辑 config.env 填入 TME_APP_ID / TME_APP_KEY，
  并把 GENERATION_BACKEND 设为 tme（见 config.env 内注释）。
- 体感指挥：手机连同一 Wi-Fi，在「输出」页选「手机遥控」模式，扫描页面
  二维码即可接入；桌面端也可用摄像头手势指挥。
- 数据持久化：生成的项目与音频保存在本目录 output/ 下。

常见问题
--------
- 端口被占用：在 config.env 里设 PORT=xxxx 换一个端口。
- 手机连不上：确认电脑与手机在同一 Wi-Fi，且系统防火墙放行了 3000 端口。
- iOS 手机传感器权限：iOS 只在 HTTPS 安全上下文下开放运动传感器。
  本机演示建议用桌面浏览器指挥；手机遥控的完整 HTTPS 体验请部署到云端。

源码与更新
----------
本项目开源，最新版本与源码见 GitHub 仓库（本包由 GitHub Actions 自动构建）。
