/**
 * 解析器离线单测：用固定 fixture 验证字段映射，不触网。
 *
 * @module test/resolvers
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ as biliTest } from '../lib/resolvers/bilibili.js';
import { detectPlatform } from '../lib/core/registry.js';
import { DEFAULT_GENERIC_DOMAINS, hostAllowed } from '../lib/resolvers/generic.js';
import { __test__ as ytTest } from '../lib/resolvers/youtube.js';
import { extractDouyinRef, mapDouyinItem, parseRouterData } from '../lib/resolvers/douyin.js';
import { extractTweetId, mapTweet } from '../lib/resolvers/twitter.js';
import { mixinKey, signWbi } from '../lib/sign/wbi.js';
import { __test__ as weiboTest } from '../lib/resolvers/weibo.js';

const { cleanWeiboText, extractImages, extractVideo, parseSetCookies } = weiboTest;
import { ciImageUrl, extractFileId, extractXhsNoteId, extractXhsRef, parseHtmlMedia, parseInitialState, redirectTargetOf } from '../lib/resolvers/xiaohongshu.js';
import { __test__ as xhsTest } from '../lib/resolvers/xiaohongshu.js';

test('bilibili: 短链识别与长链引用解析', () => {
  // 短链由 registry 命中平台，但短码本身不含 BV/av —— 需要 resolveBiliRef 跟随跳转。
  assert.equal(detectPlatform('https://b23.tv/abc123')?.platform, 'bilibili');
  assert.equal(biliTest.extractBiliRef('https://b23.tv/abc123'), undefined);
  assert.equal(biliTest.extractBiliRef('https://bili2233.cn/xyz'), undefined);
});

test('bilibili: 标题取值（单 P 忽略无意义的 part，多 P 附带分 P 名）', () => {
  const info = { title: 'Zen6震撼登场！' };
  assert.equal(biliTest.pickVideoTitle(info, { part: '1794985173419' }, 1, 1), 'Zen6震撼登场！');
  assert.equal(biliTest.pickVideoTitle(info, { part: '第二期' }, 2, 3), 'Zen6震撼登场！（P2：第二期）');
  assert.equal(biliTest.pickVideoTitle({}, { part: '1794985173419' }, 1, 1), '1794985173419');
});

test('bilibili: 链接引用与 DASH 媒体选择', () => {
  const ref = biliTest.extractBiliRef('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(ref.bvid, 'BV1xx411c7mD');
  assert.equal(ref.page, 2);

  const media = biliTest.buildDashMedia({
    dash: {
      video: [
        { id: 80, baseUrl: 'https://v/1080.m4s', bandwidth: 2000, codecs: 'avc1.640028', width: 1920, height: 1080 },
        { id: 80, baseUrl: 'https://v/1080-low.m4s', bandwidth: 1000, codecs: 'avc1' },
        { id: 32, baseUrl: 'https://v/480.m4s', bandwidth: 500, codecs: 'hev1', width: 854, height: 480 },
      ],
    },
  });
  assert.equal(media.length, 2);
  assert.equal(media[0].quality.label, '1080P');
  assert.equal(media[0].url, 'https://v/1080.m4s');
  assert.equal(media[1].quality.codec, 'hevc');
});

test('wbi: mixin key 与签名格式', () => {
  const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(key.length, 32);
  const query = signWbi({ bvid: 'BV1xx411c7mD', cid: 62131 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1700000000);
  assert.match(query, /wts=1700000000/);
  assert.match(query, /w_rid=[0-9a-f]{32}$/);
});

test('youtube: 链接判断与格式筛选', () => {
  assert.equal(ytTest.isYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(ytTest.isYoutubeUrl('https://example.com/v/1'), false);
  const media = ytTest.buildYoutubeMedia({
    formats: [
      { url: 'https://v/360', vcodec: 'avc1', height: 360, width: 640, tbr: 500 },
      { url: 'https://v/720', vcodec: 'avc1', height: 720, width: 1280, tbr: 1500 },
      { url: 'https://v/720-low', vcodec: 'avc1', height: 720, width: 1280, tbr: 1000 },
      { url: 'https://a/audio', vcodec: 'none' },
      { url: 'https://v/1080', vcodec: 'avc1', height: 1080, width: 1920, tbr: 3000 },
    ],
  }, 720);
  assert.equal(media.length, 2);
  assert.equal(media[0].quality.height, 720);
  assert.equal(media[0].url, 'https://v/720');
});

test('generic: 域名白名单', () => {
  assert.equal(hostAllowed('https://www.tiktok.com/@a/video/1', DEFAULT_GENERIC_DOMAINS), true);
  assert.equal(hostAllowed('https://vm.tiktok.com/abc', DEFAULT_GENERIC_DOMAINS), true);
  assert.equal(hostAllowed('https://evil.com/tiktok.com', DEFAULT_GENERIC_DOMAINS), false);
  assert.equal(hostAllowed('https://youtube.com/watch?v=1', DEFAULT_GENERIC_DOMAINS), false);
});

test('twitter: 提取 tweet id 并映射混合媒体', () => {
  assert.equal(extractTweetId('https://x.com/someone/status/1234567890123456789'), '1234567890123456789');
  const result = mapTweet(
    {
      tweet: {
        text: 'hello world',
        created_at: 'Mon Nov 17 10:00:00 +0000 2025',
        author: { name: 'Jack', screen_name: 'jack', avatar_url: 'https://pbs.twimg.com/a.jpg' },
        media: {
          photos: [{ url: 'https://pbs.twimg.com/p1.jpg' }],
          videos: [{ url: 'https://video.twimg.com/v1.mp4' }],
        },
      },
    },
    'https://x.com/jack/status/123',
    '123',
  );
  assert.equal(result.platform, 'twitter');
  assert.equal(result.type, 'mixed');
  assert.equal(result.author, 'Jack(@jack)');
  assert.equal(result.media.length, 2);
  assert.equal(result.media[0].kind, 'image');
  assert.equal(result.media[1].kind, 'video');
});

test('xiaohongshu: __INITIAL_STATE__ 解析（含 undefined 替换）', () => {
  const html = '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"title":"t"}}}}, "x":undefined}</script>';
  const state = parseInitialState(html);
  assert.equal(state.note.noteDetailMap.abc.note.title, 't');
  assert.equal(state.x, null);
  assert.equal(extractXhsNoteId('https://www.xiaohongshu.com/explore/65a1b2c3d4e5f6a7b8c9d0e1'), '65a1b2c3d4e5f6a7b8c9d0e1');
});

test('xiaohongshu: fileId 提取与 ci 原图地址', () => {
  assert.equal(extractFileId({ fileId: '1040g3k0327lfdk8bmq0g5p0hls' }), '1040g3k0327lfdk8bmq0g5p0hls');
  assert.equal(
    extractFileId({ urlDefault: 'https://sns-img-qc.xhscdn.com/spectrum/1040g0k031abc' }),
    '1040g0k031abc',
  );
  assert.match(ciImageUrl('abc', true), /ci\.xiaohongshu\.com\/abc\?imageView2\/2\/w\/format\/png$/);
});

test('xiaohongshu: redirectPath 与 HTML 兜底解析', () => {
  const finalUrl =
    'https://www.xiaohongshu.com/login?redirectPath=' +
    encodeURIComponent('https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=TOKEN&xhsshare=CopyLink');
  const target = redirectTargetOf(finalUrl);
  assert.ok(target.includes('xsec_token=TOKEN'));
  assert.ok(target.includes('xhsshare=CopyLink'));

  const html = '<script>{"title":"标题","desc":"正文","duration":85.7,"masterUrl":"https:\/\/sns-video-v6.xhscdn.com\/stream\/a.mp4?sign=x","image":"http:\/\/sns-webpic-qc.xhscdn.com\/1040g2sg.jpg"}</script>';
  const parsed = parseHtmlMedia(html);
  assert.equal(parsed.title, '标题');
  assert.equal(parsed.videoUrls[0], 'https://sns-video-v6.xhscdn.com/stream/a.mp4?sign=x');
  assert.ok(parsed.imageUrls[0].includes('sns-webpic-qc.xhscdn.com'));
});

test('xiaohongshu: 短链 redirectPath 提取 id 与 xsec_token', () => {
  const url =
    'https://www.xiaohongshu.com/login?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2F6afbbf45000000002501f97a%3Fxsec_token%3DABC%26xsec_source%3Dapp_share';
  const ref = extractXhsRef(url);
  assert.equal(ref.id, '6afbbf45000000002501f97a');
  assert.equal(ref.xsecToken, 'ABC');
});

test('xiaohongshu: 图片与 Live Photo 关联映射', () => {
  const note = {
    type: 'normal',
    title: '标题',
    desc: '描述',
    user: { nickname: '作者' },
    imageList: [
      { urlDefault: 'https://sns-img.xhscdn.com/a.jpg' },
      { urlDefault: 'https://sns-img.xhscdn.com/b.jpg', stream: { h264: [{ masterUrl: 'https://sns-video.xhscdn.com/b.mp4' }] } },
    ],
  };
  const result = xhsTest.mapNote(note, 'https://www.xiaohongshu.com/explore/abc', 'abc', 'https://xhslink.com/x');
  assert.equal(result.media.length, 3);
  assert.equal(result.media[0].kind, 'image');
  assert.equal(result.media[2].kind, 'livephoto-video');
  assert.equal(result.media[2].pairedWith, 1);
  assert.equal(result.type, 'images');
  assert.equal(result.title, '标题');
  assert.equal(result.author, '作者');
});

test('douyin: 视频地址 playwm→play 与时长换算', () => {
  const item = {
    aweme_id: '7345492945006595379',
    desc: '抖音标题',
    author: { nickname: '作者', avatar_thumb: { url_list: ['https://p3.douyinpic.com/avatar.jpg'] } },
    duration: 15000,
    video: {
      play_addr: { url_list: ['https://v.douyin.com/playwm/abc'] },
      cover: { url_list: ['https://p3.douyinpic.com/cover.jpg'] },
    },
    statistics: { digg_count: 10, comment_count: 2 },
  };
  const result = mapDouyinItem(item, 'https://v.douyin.com/x/', '7345492945006595379');
  assert.equal(result.platform, 'douyin');
  assert.equal(result.durationSec, 15);
  assert.ok(result.media[0].url.includes('/play/'));
  assert.equal(result.stats.likes, 10);
  assert.equal(result.author, '作者');
});

test('douyin: 图文 + 动态图映射', () => {
  const item = {
    aweme_id: '1',
    desc: '图文',
    author: { nickname: 'A' },
    images: [
      { url_list: ['https://p3.douyinpic.com/1.jpg'] },
      { url_list: ['https://p3.douyinpic.com/2.jpg'], video: { play_addr: { url_list: ['https://v.douyin.com/playwm/2'] } } },
    ],
  };
  const result = mapDouyinItem(item, 'https://v.douyin.com/x/', '1');
  assert.equal(result.media.length, 3);
  assert.equal(result.media[2].kind, 'livephoto-video');
  assert.equal(result.media[2].pairedWith, 1);
  assert.equal(result.type, 'images');
});

test('douyin: 分享页 _ROUTER_DATA 提取', () => {
  const html =
    '<script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"aweme_id":"42","desc":"d"}]}}}}</script>';
  const item = parseRouterData(html, '42');
  assert.equal(item.aweme_id, '42');
  assert.equal(extractDouyinRef('https://www.iesdouyin.com/share/video/42')?.id, '42');
});

test('weibo: 原图、最高码率与正文清洗', () => {
  const images = extractImages({
    pic_infos: {
      a: { largest: { url: 'https://wx1/large.jpg' } },
      b: { original: { url: 'https://wx1/orig.jpg' } },
    },
  });
  assert.deepEqual(images, ['https://wx1/large.jpg', 'https://wx1/orig.jpg']);

  const video = extractVideo({
    page_info: {
      media_info: {
        playback_list: [
          { play_info: { url: 'https://v/low.mp4', bitrate: 100 } },
          { play_info: { url: 'https://v/high.mp4', bitrate: 2000 } },
        ],
      },
    },
  });
  assert.equal(video.url, 'https://v/high.mp4');

  assert.equal(cleanWeiboText('<br/>a &amp; b<br>c'), 'a & b\nc');
});

test('weibo: Set-Cookie 多行解析', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'SUB=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'SUBP=def; Path=/');
  const cookies = parseSetCookies(headers);
  assert.equal(cookies.SUB, 'abc');
  assert.equal(cookies.SUBP, 'def');
});