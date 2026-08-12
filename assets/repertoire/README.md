# 模版曲目（MIDI）

指挥教学「考试」与「指挥体验」两处的参考曲目。**目前只是素材** ——
`backend/midi_out.py` 只有导出没有导入，后端还读不了 MIDI 文件，接进去需要写
解析与声部映射。

## 为什么曲目都从 Mutopia 来

**曲子是公有领域，不等于那个 MIDI 文件是。** MIDI 序列本身是一份有版权的演绎，
网上多数古典 MIDI 站（kunstderfuge、midiworld 那一类）没有给出明确授权，
放进一个 MIT 仓库是隐患。[Mutopia Project](https://www.mutopiaproject.org/)
用 LilyPond 排版公有领域乐谱并附带生成的 MIDI，**每个文件单独标注许可**。

这里两份都取 **Public Domain（CC0，无保留权利）**那一档，不取 CC BY-SA 的条目 ——
BY-SA 是传染性的，那个文件进了仓库就得一直挂着 BY-SA 并署名，不能被 MIT 吸收。
（因此排除了 Mutopia 上的德沃夏克第九《自新大陆》，它是 CC BY-SA 3.0。）

## 曲目

### `beethoven-symphony7-mvt2.mid` —— 考试

贝多芬 第七交响曲 Op.92 第二乐章（Allegretto）

| | |
|---|---|
| 来源 | https://www.mutopiaproject.org/ftp/BeethovenLv/O92/Symphony7_2/Symphony7_2.mid |
| 许可 | Public Domain（CC0） |
| 排版 | Stelios Samelis，LilyPond 2.6.3，2005-08-21 |
| sha256 | `7cf810b4625b9a272d3a0a9153d8beb5750fa3ee64122dc9f27b7661e997b903` |
| 大小 | 60,426 字节 |
| 实测 | SMF 格式 1，13 轨，**拍号只有 2/4，速度事件只有一个值 76 BPM** |

选它的理由是**全曲一个速度、一个拍号**：`score.py` 与 `midi_out` 目前只支持全曲
一个速度（三级考试的渐慢就是因此砍掉的），选一首本来就不变速的，这个限制根本
碰不到。加上那个 ♩♪♪♩♩ 的节奏细胞几乎不间断地重复整个乐章，拍子清楚到不可能听错 ——
考试该考「你能不能跟住」，而不是「你能不能听出这是几拍」。

**注意：这份 MIDI 没有力度信息，所有音符 velocity 都是 127。** LilyPond 未写
`\dynamics` 时的默认导出就是这样。所以它适合做**不考力度**的考卷（和现有一级
「进行曲」同类，那一首也是刻意「力度全程不变」），配器上一层层叠加带来的强弱
仍在，但那要从织体密度推，不是从 velocity 读。要考力度得另找或自己补。

### `beethoven-egmont-overture.mid` —— 指挥体验

贝多芬《埃格蒙特》序曲 Op.84

| | |
|---|---|
| 来源 | https://www.mutopiaproject.org/ftp/BeethovenLv/O84/Egmont/Egmont.mid |
| 许可 | Public Domain（CC0） |
| sha256 | `f189d4dfbd6058a144555393bfd3f116e751310ffb5134a5b98193ba92ba548e` |
| 大小 | 111,434 字节 |
| 实测 | SMF 格式 1，14 个乐器轨 + 控制轨，约 14 分钟，**85 种 velocity（12–127）**，拍号 3/2 → 3/4 → 4/4，速度 84 / 152 / 168 |

体验模式不打分，所以序曲里的速度与拍号变化在这里不是麻烦而是戏剧性。选它是因为
在全部公有领域候选里它**力度信息最丰富**（85 种 velocity，而多数 Mutopia 文件是
单一值），四族齐全，且是音乐会常备曲目、听得出来。

同样测过但没选的公有领域候选：《科里奥兰》序曲 Op.62（**单一 4/4、单一速度 150、
75 种 velocity**，技术上最干净，若以后想给体验模式也打分，它是首选）、贝多芬第五
第一乐章（velocity 单一值，且开头延长号对拍点驱动不友好）、莫扎特第 25 第一乐章
（velocity 单一值，无铜管打击）、《小夜曲》（纯弦乐，凑不齐四族）。

## 两个已知问题

1. **铜管的 GM 音色映射是错的。** 两份文件里圆号与小号声部都写成 GM 69（英国管）——
   LilyPond 没设 `midiInstrument` 时的默认值。按乐器映射到项目的十三件编制时不能
   照抄 GM 程序号，要按**总谱顺序**认：长笛、双簧管、单簧管、大管、圆号、小号、
   定音鼓、小提琴 I/II、中提琴、大提琴、低音提琴。
2. **轨道名是 `one:` `two:` 这样的序号**，不是乐器名，同样只能按总谱顺序认。

## 查证过但不要用的

- Mutopia 的「Ein Sommernachtstraum No. 5」**不是婚礼进行曲**（婚礼进行曲是
  Op.61 里的第 9 首）。这一条是间奏曲，6/8、2 分半。别照标题选。
- Mutopia 的《魔笛》序曲 `MFO-Score.mid` 只有 48 秒、4KB，是片段不是全曲；
  完整的分成 `adagioI/allegroI/...` 几个文件。
