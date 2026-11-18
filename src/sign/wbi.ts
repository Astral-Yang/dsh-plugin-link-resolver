/**
 * B站 WBI 签名。
 *
 * 算法：`img_key + sub_key` 经固定混淆表取前 32 位得到 `mixin_key`；
 * 参数按 key 排序、过滤 `!'()*` 后 URL 编码，拼接 `mixin_key` 取 MD5 即 `w_rid`。
 *
 * @module dsh-plugin-link-resolver/sign/wbi
 */

import { createHash } from 'node:crypto';

/** 官方混淆表。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48,
  7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * 计算 mixin key。
 *
 * @param imgKey - `nav` 返回的 img_url 文件名（不含扩展名）。
 * @param subKey - `nav` 返回的 sub_url 文件名。
 * @returns 32 位 mixin key。
 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/** 过滤 WBI 不允许的字符。 */
function sanitize(value: string): string {
  return [...value].filter((char) => !"!'()*".includes(char)).join('');
}

/**
 * 对参数签名。
 *
 * @param params - 业务参数。
 * @param imgKey - img_key。
 * @param subKey - sub_key。
 * @param timestamp - 秒级时间戳（默认当前）。
 * @returns 追加 `wts` 与 `w_rid` 的查询串。
 */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const withTs: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])), wts: String(timestamp) };
  const query = Object.keys(withTs)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitize(withTs[key]!))}`)
    .join('&');
  const wRid = createHash('md5').update(`${query}${mixinKey(imgKey, subKey)}`, 'utf8').digest('hex');
  return `${query}&w_rid=${wRid}`;
}