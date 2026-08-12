/**
 * 在解码之前先认一眼「这到底是不是音频」。
 *
 * 由来：`/api/repertoire/{id}/project` 曾经漏了 `_serialize_project`，返回的 take
 * 没有 `url`，前端于是去取 `/undefined`；dev server 拿首页顶上这个请求**并且给
 * 200**，浏览器把 871 字节的 HTML 当音频交给 `decodeAudioData`，报出来的是
 * 「Decoding failed」。那条消息把人往「音频文件坏了」的方向带，实际上文件好好的。
 *
 * 一次 4 字节的比对就能把这类错误从「解码失败」变成「取回来的是 HTML」，
 * 差别是能不能一眼看出问题在哪。
 */
export function looksLikeWav(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const b = new Uint8Array(data, 0, 12);
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;
}
