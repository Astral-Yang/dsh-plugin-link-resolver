/**
 * 平台注册表：受支持平台的唯一描述处。
 *
 * 与参考实现（astrbot_plugin_link_resolver/core/registry.py）保持同样的职责划分：
 * 新增平台只需在此追加一条记录，识别与分发随之生效；各平台解析器另行实现。
 *
 * @module dsh-plugin-link-resolver/core/registry
 */

/** 受支持的平台标识。 */
export type PlatformId =
  | 'bilibili'
  | 'douyin'
  | 'xiaohongshu'
  | 'weibo'
  | 'twitter'
  | 'youtube'
  | 'generic';

/** 一个平台的最小描述。 */
export interface PlatformDef {
  /** 内部标识，同时用于配置开关与结果字段。 */
  readonly id: PlatformId;
  /** 面向用户的名称。 */
  readonly label: string;
  /** 用于快速判定的主机名（含子域，例如 `bilibili.com` 覆盖 `www.bilibili.com`）。 */
  readonly hosts: readonly string[];
  /** 内容链接识别正则（针对规范化后的整条 URL）。 */
  readonly patterns: readonly RegExp[];
  /** 是否默认启用。通用站点兜底默认关闭。 */
  readonly defaultEnabled: boolean;
}

/** 平台识别结果。 */
export interface Detection {
  readonly platform: PlatformId;
  readonly contentId?: string;
}

/** 全部平台，顺序即识别与分发优先级（通用站点最后）。 */
export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'bilibili',
    label: 'B站',
    hosts: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
    patterns: [
      /bilibili\.com\/video\/(?<id>BV[0-9A-Za-z]{10}|av\d+)/i,
      /b23\.tv\/[A-Za-z\d._?%&+\-=/]+/i,
      /bili2233\.cn\/[A-Za-z\d._?%&+\-=/]+/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'douyin',
    label: '抖音',
    hosts: ['douyin.com', 'iesdouyin.com'],
    patterns: [
      /(?:v|jx)\.douyin\.com\/[a-zA-Z0-9_-]+\/?/i,
      /douyin\.com\/(?:video|note)\/(?<id>\d+)/i,
      /iesdouyin\.com\/share\/(?:slides|video|note)\/(?<id>\d+)/i,
      /m\.douyin\.com\/share\/(?:slides|video|note)\/(?<id>\d+)/i,
      /jingxuan\.douyin\.com\/m\/(?:slides|video|note)\/(?<id>\d+)/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
    patterns: [
      /xhslink\.(?:com|cn)\/[A-Za-z0-9._?%&+=/#@-]+/i,
      /xiaohongshu\.com\/(?:explore|discovery\/item|user\/profile\/[0-9a-zA-Z]+)\/(?<id>[0-9a-zA-Z]+)/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'weibo',
    label: '微博',
    hosts: ['weibo.com', 'weibo.cn', 'm.weibo.cn', 'video.weibo.com', 't.cn'],
    patterns: [
      /t\.cn\/[A-Za-z0-9]+\/?/i,
      /weibo\.com\/\d{10}\/(?<id>[A-Za-z0-9]{9,16})/i,
      /m\.weibo\.cn\/(?:detail|status|\d+)\/(?<id>[A-Za-z0-9]{9,16})/i,
      /weibo\.cn\/(?:detail\/)?(?<id>[A-Za-z0-9]{9,16})/i,
      /weibo\.com\/tv\/show\/(?<id>\d+)/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'twitter',
    label: 'X',
    hosts: ['x.com', 'twitter.com'],
    patterns: [
      /(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,32}|i\/web)\/status(?:es)?\/(?<id>\d+)/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    hosts: ['youtube.com', 'youtu.be', 'm.youtube.com'],
    patterns: [
      /youtube\.com\/watch\?(?:[^#]*&)?v=(?<id>[A-Za-z0-9_-]{11})/i,
      /youtu\.be\/(?<id>[A-Za-z0-9_-]{11})/i,
      /youtube\.com\/shorts\/(?<id>[A-Za-z0-9_-]{11})/i,
    ],
    defaultEnabled: true,
  },
  {
    id: 'generic',
    label: '通用站点',
    hosts: [],
    patterns: [/^https?:\/\//i],
    defaultEnabled: false,
  },
];

/** 按 id 索引的平台表。 */
export const PLATFORM_BY_ID: Readonly<Record<PlatformId, PlatformDef>> = Object.fromEntries(
  PLATFORMS.map((platform) => [platform.id, platform]),
) as Readonly<Record<PlatformId, PlatformDef>>;

/** 主机名是否等于某域名或为其子域。 */
export function hostInDomains(host: string, domains: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

/**
 * 识别一条已规范化的链接。
 *
 * @param url - 已带 scheme 的绝对 URL。
 * @returns 命中的平台与内容 id；未命中返回 null。
 */
export function detectPlatform(url: string): Detection | null {
  for (const platform of PLATFORMS) {
    if (platform.id === 'generic') continue;
    for (const pattern of platform.patterns) {
      const match = pattern.exec(url);
      if (!match) continue;
      const id = match.groups?.['id'];
      return id === undefined ? { platform: platform.id } : { platform: platform.id, contentId: id };
    }
  }
  return null;
}