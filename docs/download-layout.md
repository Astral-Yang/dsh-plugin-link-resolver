# 下载目录结构

下载根目录：`<会话工作区>/<downloadDir>/`，默认 `downloads`（可用配置改为绝对路径）。

## 目录树

```
downloads/
├── bilibili/
│   └── BV1Zos36FEZz/
│       ├── video.mp4            # 合并后的视频
│       ├── cover.jpg            # 封面（best effort）
│       ├── metadata.json        # 元数据快照
│       └── frames/              # 宿主预览生成（非插件产物，可忽略）
├── douyin/
│   └── 7708744445503573289/
│       ├── 01.mp4               # 视频或图集（按序号）
│       ├── cover.jpg
│       └── metadata.json
├── xiaohongshu/
│   └── 6afbbf45000000002501f97a/
│       ├── 01.png … 04.png      # 原图（ci.xiaohongshu.com）
│       └── metadata.json
├── weibo/
│   └── Rrbfqw8g0/
│       ├── 01.jpg …
│       └── metadata.json
├── twitter/
│   └── 20/
│       ├── 01.jpg / 01.mp4 …
│       └── metadata.json
├── youtube/
│   └── dQw4w9WgXcQ/
│       ├── dQw4w9WgXcQ.mp4
│       ├── cover.jpg
│       └── metadata.json
└── generic/
    └── <content_id>/
        ├── 01.mp4
        └── metadata.json
```

## 命名规则

| 类型 | 规则 |
| --- | --- |
| 平台目录 | `bilibili` / `douyin` / `xiaohongshu` / `weibo` / `twitter` / `youtube` / `generic` |
| 内容目录 | 平台内容 id（BV 号、aweme_id、note_id、mblogid、tweet_id、video_id）；缺失或非法字符替换为 `_` |
| 媒体文件 | 按媒体顺序两位数编号：`01.mp4`、`01.jpg`、`01.png` …；B站为 `video.mp4`，YouTube 为 `<id>.mp4` |
| 封面 | `cover.jpg`（下载失败不影响主流程） |
| 元数据 | `metadata.json`：`savedAt`、`platform`、`contentId`、`url`、`originalUrl`、`title`、`author`、`description`、`durationSec`、`media[]`、`downloads[]` |

## 行为说明

- 同一内容重复下载会**覆盖**同名文件（目录结构幂等），不会无限堆积；
- 单个媒体失败不阻断其余媒体，缺失项不会出现在 `downloads` 中；
- 目录按会话工作区隔离：不同工作区不会混用下载目录；
- 设置 `downloadDir` 为绝对路径时，直接使用该绝对路径（不再拼接工作区）。
