"""
快速本地开发脚本：生成一个假会话（静音 WAV 文件），用于前端与静态路由测试

用法：
  cd backend
  python dev_generate_mock.py

脚本会在 `backend/config.py` 指定的 OUTPUT_DIR 下创建一个 session 文件夹并写入若干 wav 文件。
"""
import uuid
from pathlib import Path
import wave
import struct

try:
    from .config import OUTPUT_DIR, STEM_PROMPTS
except Exception:
    from config import OUTPUT_DIR, STEM_PROMPTS


def write_silence_wav(path: Path, duration_sec: float = 4.0, sr: int = 22050):
    path.parent.mkdir(parents=True, exist_ok=True)
    nframes = int(duration_sec * sr)
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sr)
        silence_frame = struct.pack('<h', 0)
        wf.writeframes(silence_frame * nframes)


def main():
    session_id = str(uuid.uuid4())[:8]
    session_dir = Path(OUTPUT_DIR) / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # 生成每个声部的静音文件
    for inst in STEM_PROMPTS.keys():
        p = session_dir / f"{inst}.wav"
        write_silence_wav(p, duration_sec=6.0)

    # 生成 full_mix.wav（简单复制第一个声部）
    first = next(iter(STEM_PROMPTS.keys()))
    (session_dir / 'full_mix.wav').write_bytes((session_dir / f"{first}.wav").read_bytes())

    print("mock session created:")
    print(session_id)
    print("access urls (when server running):")
    for inst in list(STEM_PROMPTS.keys()) + ['full_mix']:
        print(f"/audio/{session_id}/{inst}.wav")


if __name__ == '__main__':
    main()
