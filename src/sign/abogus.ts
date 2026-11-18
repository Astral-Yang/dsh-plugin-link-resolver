/**
 * 抖音 a_bogus 签名（移植自参考实现的 `core/douyin/abogus.py`）。
 *
 * 算法要素：SM3（Node 原生 `crypto` 提供）、RC4、自定义 Base64 字符表、
 * 浏览器指纹与时间戳分片。所有魔法常量与参考实现逐项对齐，并由
 * `test/fixtures/abogus-vectors.json` 的黄金向量锁定。
 *
 * @module dsh-plugin-link-resolver/sign/abogus
 */

import { createHash } from 'node:crypto';

/** 参考实现的固定混淆数组（`CryptoUtility.big_array`）。 */
const BIG_ARRAY: readonly number[] = [
  121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250, 207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28,
  194, 215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79,
  73, 161, 178, 81, 64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150, 110, 219, 199, 255, 181, 254,
  48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96, 83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158,
  13, 1, 188, 164, 210, 237, 222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141, 185, 33,
  157, 31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109, 57, 24, 38, 113, 209, 245, 2, 119, 153, 229,
  189, 214, 230, 174, 232, 63, 52, 205, 86, 140, 66, 175, 111, 171, 246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211,
  166, 151, 213, 206, 0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85, 224, 155, 226, 242, 87, 177,
  146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59, 9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14,
  156,
];

/** 自定义 Base64 字符表。 */
const CHARACTER = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const CHARACTER2 = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const ALPHABETS = [CHARACTER, CHARACTER2] as const;

/** 签名盐。 */
const SALT = 'cus';

/** 字段排序表。 */
const SORT_INDEX = [
  18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59,
  46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
];

/** XOR 排序表。 */
const SORT_INDEX_2 = [
  18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52,
  53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
];

/** 默认 UA（与参考实现一致）。 */
export const DEFAULT_DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

/** 构造参数。 */
export interface ABogusOptions {
  /** 浏览器 UA。 */
  userAgent?: string;
  /** 浏览器指纹（固定字符串，便于测试）。 */
  fingerprint?: string;
  /** 时间源（毫秒），默认 `Date.now`。 */
  now?: () => number;
  /** 随机前缀生成器，默认随机；测试注入固定值。 */
  randomPrefix?: () => string;
}

/** 生成浏览器指纹（等价 `BrowserFingerprintGenerator.generate_fingerprint('Edge')`）。 */
export function generateFingerprint(random: () => number = Math.random, platform = 'Win32'): string {
  const randint = (min: number, max: number): number => Math.floor(random() * (max - min + 1)) + min;
  const innerWidth = randint(1024, 1920);
  const innerHeight = randint(768, 1080);
  const outerWidth = innerWidth + randint(24, 32);
  const outerHeight = innerHeight + randint(75, 90);
  const screenX = 0;
  const screenY = random() < 0.5 ? 0 : 30;
  const sizeWidth = randint(1024, 1920);
  const sizeHeight = randint(768, 1080);
  const availWidth = randint(1280, 1920);
  const availHeight = randint(800, 1080);
  return [innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, 0, 0, sizeWidth, sizeHeight, availWidth, availHeight, innerWidth, innerHeight, 24, 24, platform].join('|');
}

/** SM3 → 字节数组。 */
function sm3Bytes(input: string | Buffer): number[] {
  const hex = createHash('sm3').update(input).digest('hex');
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** 生成随机混淆前缀（等价 `StringProcessor.generate_random_bytes`）。 */
function defaultRandomPrefix(): string {
  const chunk = (): string => {
    const rd = Math.floor(Math.random() * 10000);
    return String.fromCharCode((((rd & 255) & 170) | 1), (((rd & 255) & 85) | 2), ((((rd >>> 8) & 255) & 170) | 5), ((((rd >>> 8) & 255) & 85) | 40));
  };
  return chunk() + chunk() + chunk();
}

/** a_bogus 生成器。注意 `bigArray` 为实例状态（参考实现会就地置换）。 */
export class ABogus {
  private readonly bigArray: number[];
  private readonly userAgent: string;
  private readonly fingerprint: string;
  private readonly now: () => number;
  private readonly randomPrefix: () => string;

  constructor(options: ABogusOptions = {}) {
    this.bigArray = [...BIG_ARRAY];
    this.userAgent = options.userAgent ?? DEFAULT_DOUYIN_UA;
    this.fingerprint = options.fingerprint ?? generateFingerprint();
    this.now = options.now ?? (() => Date.now());
    this.randomPrefix = options.randomPrefix ?? defaultRandomPrefix;
  }

  /** 取指纹（供外部复用）。 */
  get fingerprintValue(): string {
    return this.fingerprint;
  }

  /** 取 UA。 */
  get userAgentValue(): string {
    return this.userAgent;
  }

  /**
   * 生成 a_bogus。
   *
   * @param params - 已编码的查询串（不含 a_bogus）。
   * @param body - 请求体（GET 为空串）。
   * @returns `{ params, signature }`，`params` 已追加 `a_bogus`。
   */
  generate(params: string, body = ''): { params: string; signature: string } {
    const start = Math.floor(this.now());
    const array1 = this.paramsToArray(this.paramsToArray(params));
    const array2 = this.paramsToArray(this.paramsToArray(body));
    const uaEncoded = this.base64Encode(this.toCharStr([...this.rc4Encrypt(Buffer.from([0, 1, 14]), this.userAgent)]), 1);
    const array3 = this.paramsToArray(uaEncoded, false);
    const end = Math.floor(this.now());

    const dir: Record<number, number> = {
      8: 3,
      15: 1,
      18: 44,
      19: 1,
      66: 0,
      69: 0,
      70: 0,
      71: 0,
      20: (start >>> 24) & 255,
      21: (start >>> 16) & 255,
      22: (start >>> 8) & 255,
      23: start & 255,
      24: Math.floor(start / 256 / 256 / 256 / 256) & 255,
      25: Math.floor(start / 256 / 256 / 256 / 256 / 256) & 255,
      26: 0,
      27: 0,
      28: 0,
      29: 0,
      30: Math.trunc(1 / 256) & 255,
      31: 1 % 256,
      32: (1 >>> 24) & 255,
      33: (1 >>> 16) & 255,
      34: (14 >>> 24) & 255,
      35: (14 >>> 16) & 255,
      36: (14 >>> 8) & 255,
      37: 14 & 255,
      38: array1[21] ?? 0,
      39: array1[22] ?? 0,
      40: array2[21] ?? 0,
      41: array2[22] ?? 0,
      42: array3[23] ?? 0,
      43: array3[24] ?? 0,
      44: (end >>> 24) & 255,
      45: (end >>> 16) & 255,
      46: (end >>> 8) & 255,
      47: end & 255,
      48: 3,
      49: Math.floor(end / 256 / 256 / 256 / 256) & 255,
      50: Math.floor(end / 256 / 256 / 256 / 256 / 256) & 255,
      51: 0,
      52: 0,
      53: 0,
      54: 0,
      55: 0,
      56: 6383,
      57: 6383 & 255,
      58: (6383 >>> 8) & 255,
      59: (6383 >>> 16) & 255,
      60: (6383 >>> 24) & 255,
      64: this.fingerprint.length,
      65: this.fingerprint.length,
    };

    const sortedValues = SORT_INDEX.map((index) => dir[index] ?? 0);
    const fingerprintArray = [...this.fingerprint].map((char) => char.charCodeAt(0));

    let xor = 0;
    for (let index = 0; index < SORT_INDEX_2.length - 1; index += 1) {
      if (index === 0) xor = dir[SORT_INDEX_2[0]!] ?? 0;
      xor ^= dir[SORT_INDEX_2[index + 1]!] ?? 0;
    }

    sortedValues.push(...fingerprintArray, xor & 255);
    const payload = this.randomPrefix() + this.transformBytes(sortedValues);
    const signature = this.abogusEncode(payload, 0);
    return { params: `${params}&a_bogus=${signature}`, signature };
  }

  /** SM3(参数+盐) → 字节数组；支持字符串或已编码字节。 */
  private paramsToArray(param: string | readonly number[] | Buffer, addSalt = true): number[] {
    if (typeof param === 'string') return sm3Bytes(addSalt ? `${param}${SALT}` : param);
    return sm3Bytes(Buffer.from(param));
  }

  /** 字节数组 → 字符串。 */
  private toCharStr(bytes: readonly number[]): string {
    return bytes.map((value) => String.fromCharCode(value)).join('');
  }

  /** 参考实现的字节置换加密。 */
  private transformBytes(bytesList: readonly number[]): string {
    const input = this.toCharStr(bytesList);
    const result: string[] = [];
    let indexB = this.bigArray[1]!;
    let initialValue = 0;
    let valueE = 0;

    for (let index = 0; index < input.length; index += 1) {
      let sum: number;
      if (index === 0) {
        initialValue = this.bigArray[indexB]!;
        sum = indexB + initialValue;
        this.bigArray[1] = initialValue;
        this.bigArray[indexB] = indexB;
      } else {
        sum = initialValue + valueE;
      }

      const charValue = input.charCodeAt(index);
      sum %= this.bigArray.length;
      const valueF = this.bigArray[sum]!;
      result.push(String.fromCharCode(charValue ^ valueF));

      valueE = this.bigArray[(index + 2) % this.bigArray.length]!;
      sum = (indexB + valueE) % this.bigArray.length;
      initialValue = this.bigArray[sum]!;
      this.bigArray[sum] = this.bigArray[(index + 2) % this.bigArray.length]!;
      this.bigArray[(index + 2) % this.bigArray.length] = initialValue;
      indexB = sum;
    }
    return result.join('');
  }

  /** 自定义 Base64 编码。 */
  private base64Encode(input: string, alphabetIndex = 0): string {
    let binary = '';
    for (const char of input) binary += char.charCodeAt(0).toString(2).padStart(8, '0');
    const padding = (6 - (binary.length % 6)) % 6;
    binary += '0'.repeat(padding);
    const alphabet = ALPHABETS[alphabetIndex]!;
    let output = '';
    for (let i = 0; i < binary.length; i += 6) output += alphabet[Number.parseInt(binary.slice(i, i + 6), 2)]!;
    return output + '='.repeat(Math.floor(padding / 2));
  }

  /** abogus 专用 Base64（3 字节一组 + 位移）。 */
  private abogusEncode(input: string, alphabetIndex: number): string {
    const alphabet = ALPHABETS[alphabetIndex]!;
    const out: string[] = [];
    for (let i = 0; i < input.length; i += 3) {
      let n: number;
      if (i + 2 < input.length) {
        n = (input.charCodeAt(i) << 16) | (input.charCodeAt(i + 1) << 8) | input.charCodeAt(i + 2);
      } else if (i + 1 < input.length) {
        n = (input.charCodeAt(i) << 16) | (input.charCodeAt(i + 1) << 8);
      } else {
        n = input.charCodeAt(i) << 16;
      }
      const shifts = [18, 12, 6, 0] as const;
      const masks = [0xfc0000, 0x03f000, 0x0fc0, 0x3f] as const;
      for (let k = 0; k < 4; k += 1) {
        const j = shifts[k]!;
        if (j === 6 && i + 1 >= input.length) break;
        if (j === 0 && i + 2 >= input.length) break;
        out.push(alphabet[(n & masks[k]!) >> j]!);
      }
    }
    out.push('='.repeat((4 - (out.length % 4)) % 4));
    return out.join('');
  }

  /** RC4。 */
  private rc4Encrypt(key: Buffer, plaintext: string): Buffer {
    const s = Array.from({ length: 256 }, (_, index) => index);
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
      j = (j + s[i]! + key[i % key.length]!) % 256;
      [s[i], s[j]] = [s[j]!, s[i]!];
    }
    let i = 0;
    j = 0;
    const out = Buffer.alloc(plaintext.length);
    for (let index = 0; index < plaintext.length; index += 1) {
      i = (i + 1) % 256;
      j = (j + s[i]!) % 256;
      [s[i], s[j]] = [s[j]!, s[i]!];
      out[index] = plaintext.charCodeAt(index) ^ s[(s[i]! + s[j]!) % 256]!;
    }
    return out;
  }
}