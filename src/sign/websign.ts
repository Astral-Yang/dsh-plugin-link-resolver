/**
 * 抖音 WebSign（`x-secsdk-web-signature`）。
 *
 * 移植自参考实现的 `core/douyin/websign.py`：对包含 `a_bogus` 的最终查询串
 * 追加 `uifid`、`timestamp` 后做 MD5（固定盐）。
 *
 * @module dsh-plugin-link-resolver/sign/websign
 */

import { createHash } from 'node:crypto';

/** 固定盐（与参考实现一致）。 */
const WEB_SIGN_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';

/** 签名参数名。 */
export const WEB_SIGNATURE_PARAM = 'x-secsdk-web-signature';

/** 签名结果。 */
export interface SignedQuery {
  query: string;
  signature: string;
  timestamp: string;
}

/**
 * 按 Python `urllib.parse.quote(s, safe='*-._')` 的规则编码。
 *
 * @param value - 原始字符串。
 * @returns 编码后的字符串。
 */
export function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 解析查询串为键值对（等价 `parse_qsl`）。
 *
 * @param query - 查询串。
 * @returns 解码后的键值对。
 */
function decodePairs(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of query.split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const name = index === -1 ? part : part.slice(0, index);
    const value = index === -1 ? '' : part.slice(index + 1);
    pairs.push([decodeURIComponent(name.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' '))]);
  }
  return pairs;
}

/**
 * 序列化键值对（等价参考实现的 `encode_pairs`）。
 *
 * @param pairs - 键值对。
 * @returns 查询串。
 */
export function encodePairs(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([name, value]) => `${pyQuote(name)}=${pyQuote(value)}`).join('&');
}

/**
 * 生成 WebSign。
 *
 * @param query - 已包含 `a_bogus` 的查询串。
 * @param uifid - 游客 UIFID。
 * @param timestamp - 秒级时间戳（默认当前时间）。
 * @returns 追加签名后的查询串与签名值。
 */
export function sign(query: string, uifid: string, timestamp?: number): SignedQuery {
  const stamp = String(timestamp ?? Math.floor(Date.now() / 1000));
  const pairs = decodePairs(query);
  if (!pairs.some(([name]) => name === 'uifid')) pairs.push(['uifid', uifid]);
  pairs.push(['timestamp', stamp]);
  const covered = encodePairs(pairs);
  const preimage = `${uifid}_${stamp}_${WEB_SIGN_SALT}_${covered}`;
  const signature = createHash('md5').update(preimage, 'utf8').digest('hex');
  return {
    query: `${covered}&${WEB_SIGNATURE_PARAM}=${signature}`,
    signature,
    timestamp: stamp,
  };
}