/**
 * 从已解码的 AudioBuffer 提取峰值包络，供 canvas 波形组件绘制。
 *
 * **按整轨最大值归一化**，画出来的是形状不是绝对响度。
 *
 * 以前不归一也看着正常，是因为老的两条生成链路出来的 wav 都被
 * `audio_utils.to_wav_bytes` 归一化到了 0.9 —— 波形组件其实一直隐含地假设
 * 「峰值接近 1」。写谱模式为了保住配器平衡是**固定增益不归一化**的
 * （见 backend/render.py），一条小提琴独奏轨峰值只有 0.067，照绝对值画出来
 * 就是一条贴着中线的直线，等于这个组件对写谱模式整个失效。
 *
 * 归一化不会丢信息：各声部的相对响度由推子和 velocity 表达，波形负责的是
 * 「这一段在哪儿、密不密」。
 */
export function computePeaks(buffer: AudioBuffer, bucketCount: number): Float32Array {
  const channel = buffer.getChannelData(0);
  const perBucket = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = new Float32Array(bucketCount);
  let loudest = 0;
  for (let i = 0; i < bucketCount; i++) {
    const start = i * perBucket;
    const end = Math.min(channel.length, start + perBucket);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
    if (max > loudest) loudest = max;
  }
  // 整轨静音时保持全零，别把 0/0 画成一片满格噪声
  if (loudest > 0) {
    for (let i = 0; i < bucketCount; i++) peaks[i] /= loudest;
  }
  return peaks;
}
