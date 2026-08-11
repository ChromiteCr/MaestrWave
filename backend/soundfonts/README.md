# 音源

`orchestral.sf2` 是从 **FluidR3_GM** 裁出来的，只保留 MaestrWave 用得到的音色：

| | |
|---|---|
| 来源 | FluidR3_GM.sf2（Debian `fluid-soundfont` 3.1，141.5 MB） |
| 作者 | Frank Wen |
| 授权 | MIT（见 `FluidR3_GM-LICENSE.txt`，明确允许再分发） |
| 裁剪后 | 33.3 MB，12 个音色 + 1 套鼓组 |

保留的音色正好对应 `config.INSTRUMENT_LIBRARY` 里的 `gm_program`：
Violin / Cello / Strings / Trumpet / Trombone / French Horns / Brass Section /
Oboe / Clarinet / Flute / Timpani，加 bank 128 的标准鼓组（大鼓、小军鼓、
吊镲、中国钹、小吊镲、三角铁）。其余一百多个 GM 音色（吉他、电子琴、音效……）
在这个项目里一个都用不到，裁掉才可能把音源直接放进仓库。

## 换成别的音源

把任意 `.sf2` 放进这个目录即可，文件名随意，后端会自己扫。也可以用
`SOUNDFONT_PATH` 指定具体文件。

**只支持未压缩的 `.sf2`**：`.sf3` 的样本是 Ogg Vorbis 压缩的，而
`backend/sf2.py` 是纯标准库实现，解不了 Ogg。

## 重新裁剪

```bash
python3 scripts/trim_soundfont.py 完整音源.sf2 backend/soundfonts/orchestral.sf2
```

脚本按 `INSTRUMENT_LIBRARY` 与 `score.DRUM_KEYS` 自动决定保留哪些，加乐器之后
重跑一次即可。它只做「保留 + 重新编号」，不改任何音色参数 —— 实测裁剪前后
逐采样最大差 4.33e-07，远低于 16-bit 的一个最低位（3.05e-05）。
