/** 从已解码的 AudioBuffer 提取峰值包络，供 canvas 波形组件绘制。 */
export function computePeaks(buffer: AudioBuffer, bucketCount: number): Float32Array {
  const channel = buffer.getChannelData(0);
  const perBucket = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = new Float32Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    const start = i * perBucket;
    const end = Math.min(channel.length, start + perBucket);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}
