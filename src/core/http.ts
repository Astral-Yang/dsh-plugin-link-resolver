/**
 * HTTP 客户端：超时、重试、SSRF 守卫与并发令牌桶。
 *
 * 设计取舍：
 * - 重定向手动跟随，逐跳做安全校验（防跳转绕过）；
 * - 重试仅针对 408/429/5xx 与网络异常，4xx 直接失败（参考实现同样语义）；
 * - DNS 预解析后校验全部地址；运行时仍存在 DNS Rebinding 残余风险，部署层可用
 *   出口策略兜底（TASK.md §9.1 已列为已知边界）。
 * - 不拦截 198.18.0.0/15：该段常被透明代理用作 fake-IP，拦截会让所有外网请求失败；
 *   它本身不可公网路由，放行不构成内网可达。
 *
 * @module dsh-plugin-link-resolver/core/http
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ResolveError } from './result.js';

/** 默认请求头（桌面 Chrome）。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/** 单次请求的可选参数。 */
export interface RequestOptions {
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 重试次数（不含首次）。 */
  retries?: number;
  /** 额外请求头。 */
  headers?: Record<string, string>;
  /** 外部取消信号。 */
  signal?: AbortSignal;
  /** 响应体大小上限（字节），默认 8MB。 */
  maxBytes?: number;
  /** 请求方法。 */
  method?: 'GET' | 'POST';
  /** 表单或 JSON 请求体。 */
  body?: string;
  /** 最大重定向次数，默认 5。 */
  maxRedirects?: number;
}

/** 文本响应。 */
export interface TextResponse {
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

/** IPv4 私网/保留段（CIDR 前缀以数组表达）。 */
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * IPv4 是否落在私网/保留段。
 *
 * @param ip - 点分 IPv4。
 * @returns 是否应拒绝。
 */
function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const value = ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
  return PRIVATE_V4.some(([base, bits]) => {
    const baseParts = base.split('.').map((part) => Number.parseInt(part, 10));
    const baseValue = ((baseParts[0]! << 24) >>> 0) + (baseParts[1]! << 16) + (baseParts[2]! << 8) + baseParts[3]!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

/**
 * IPv6 是否落在私网/保留段。
 *
 * @param ip - 已小写化的 IPv6。
 * @returns 是否应拒绝。
 */
function isPrivateV6(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10
  if (normalized.startsWith('ff')) return true; // ff00::/8
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

/**
 * 校验一条 URL 是否可以安全请求。
 *
 * @param raw - 绝对 URL。
 * @returns 解析后的 URL 对象。
 * @throws ResolveError `blocked-domain`。
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResolveError('unsupported-url', `链接格式无效：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ResolveError('blocked-domain', `仅允许 http(s) 协议：${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ResolveError('blocked-domain', `拒绝访问内部主机：${host}`);
  }

  const literal = isIP(host);
  if (literal === 4 && isPrivateV4(host)) throw new ResolveError('blocked-domain', `拒绝访问内网地址：${host}`);
  if (literal === 6 && isPrivateV6(host)) throw new ResolveError('blocked-domain', `拒绝访问内网地址：${host}`);
  if (literal !== 0) return url;

  // 域名：解析全部地址，任一落在私网即拒绝（防 DNS 指向内网）。
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new ResolveError('network', `DNS 解析失败：${host}`, { cause: error, retryable: true });
  }
  if (addresses.length === 0) throw new ResolveError('network', `DNS 无结果：${host}`);
  for (const entry of addresses) {
    const bad = entry.family === 4 ? isPrivateV4(entry.address) : isPrivateV6(entry.address);
    if (bad) throw new ResolveError('blocked-domain', `域名解析到内网地址：${host} → ${entry.address}`);
  }
  return url;
}

/** 简单信号量：限制全局并发。 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** 在令牌内执行一个异步任务。 */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** 合并外部信号与超时信号。 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 等待若干毫秒。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * 带超时、重试、跳转校验的文本请求。
 *
 * @param rawUrl - 目标 URL。
 * @param options - 请求参数。
 * @returns 文本响应。
 */
export async function requestText(rawUrl: string, options: RequestOptions = {}): Promise<TextResponse> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await once(options);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ResolveError
          ? error.retryable
          : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (!retryable || attempt === retries) break;
      await sleep(400 * 2 ** attempt, options.signal);
    }
  }
  if (lastError instanceof ResolveError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ResolveError('network', `请求失败：${message}`, { retryable: true, cause: lastError });

  /** 执行一次完整请求（含手动跳转）。 */
  async function once(opts: RequestOptions): Promise<TextResponse> {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = await assertSafeUrl(current);
      const signal = combineSignals(opts.signal, timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: opts.method ?? 'GET',
          headers: { 'User-Agent': DEFAULT_UA, ...(opts.headers ?? {}) },
          body: opts.body,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new ResolveError('timeout', `请求超时（${timeoutMs}ms）：${url.hostname}`, { retryable: true });
        }
        throw new ResolveError('network', `网络异常：${error instanceof Error ? error.message : String(error)}`, {
          retryable: true,
          cause: error,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new ResolveError('network', `重定向缺少 Location：${url.href}`);
        current = new URL(location, url).toString();
        await response.body?.cancel();
        continue;
      }

      if (response.status === 408 || response.status === 429) {
        await response.body?.cancel();
        throw new ResolveError('rate-limited', `请求被限流（${response.status}）`, { retryable: true });
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new ResolveError('network', `服务端错误（${response.status}）`, { retryable: true });
      }
      if (response.status >= 400) {
        await response.body?.cancel();
        throw new ResolveError('not-found', `请求失败（${response.status}）：${url.hostname}`);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new ResolveError('size-exceeded', `响应体超过限制（${buffer.byteLength} > ${maxBytes} 字节）`);
      }
      return {
        url: url.toString(),
        status: response.status,
        headers: response.headers,
        text: new TextDecoder('utf-8').decode(buffer),
      };
    }
    throw new ResolveError('network', `重定向次数超过 ${maxRedirects}`);
  }
}

/**
 * 请求 JSON。
 *
 * @param url - 目标 URL。
 * @param options - 请求参数。
 * @returns 解析后的 JSON（`unknown`）。
 */
export async function requestJson(url: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await requestText(url, {
    ...options,
    headers: { Accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) },
  });
  try {
    return JSON.parse(response.text) as unknown;
  } catch (error) {
    throw new ResolveError('parse-failed', `响应不是合法 JSON：${response.url}`, { cause: error });
  }
}