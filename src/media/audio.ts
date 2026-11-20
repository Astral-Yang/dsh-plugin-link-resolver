/**
 * 音频策略：按配置与平台判断是否把下载到的视频转为音频。
 *
 * @module dsh-plugin-link-resolver/media/audio
 */

/**
 * 当前平台是否需要转音频。
 *
 * @param enabled - 总开关。
 * @param platforms - 平台白名单；空数组表示全部平台。
 * @param platform - 本轮结果的平台 id。
 * @returns 是否需要转换。
 */
export function wantsAudio(enabled: boolean, platforms: readonly string[], platform: string): boolean {
  if (!enabled) return false;
  return platforms.length === 0 || platforms.includes(platform);
}

/**
 * 视频路径对应的音频输出路径（同目录、同名、`.mp3`）。
 *
 * @param videoPath - 视频文件路径。
 * @returns 音频文件路径。
 */
export function audioTarget(videoPath: string): string {
  return `${videoPath.replace(/\.[^./\\]+$/, '')}.mp3`;
}

/**
 * 交付列表：音频模式下排除音频文件（音频只落盘）；没有其它文件时退回全部。
 *
 * 视频照常交付，音频留在下载目录里不随本轮发送。
 *
 * @param files - 下载到的文件。
 * @param enabled - 音频模式开关。
 * @param platforms - 平台白名单；空数组表示全部平台。
 * @param platform - 本轮平台 id。
 * @returns 需要交付的文件。
 */
export function deliverableFiles<T extends { kind: string }>(
  files: readonly T[],
  enabled: boolean,
  platforms: readonly string[],
  platform: string,
): T[] {
  if (!wantsAudio(enabled, platforms, platform)) return [...files];
  const rest = files.filter((file) => file.kind !== 'audio');
  return rest.length > 0 ? rest : [...files];
}