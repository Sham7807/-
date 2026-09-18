(function (root) {
  'use strict';

  const TIMEOUT_MS = 120000;
  const REVOKE_DELAY_MS = 60000;
  const EXTENSIONS = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp',
    'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/heic': 'heic',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
    'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a',
    'audio/webm': 'webm', 'audio/pcm': 'pcm', 'audio/l16': 'pcm',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/ogg': 'ogv', 'video/mpeg': 'mpeg', 'video/x-msvideo': 'avi',
  };
  const FALLBACK_EXTENSIONS = { image: 'png', video: 'mp4', audio: 'mp3' };

  function failure(message) {
    const error = new Error(message);
    error.name = 'MediaDownloadError';
    return error;
  }

  function sourceUrl(value) {
    if (typeof value !== 'string' || !value.trim()) throw failure('没有可下载的媒体地址。');
    let url;
    try { url = new URL(value); } catch (_) { throw failure('媒体地址无效，无法下载。'); }
    if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol) || url.username || url.password) {
      throw failure('该媒体地址类型不支持下载。');
    }
    if (url.protocol === 'data:' && !/^data:(?:image|audio|video)\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) {
      throw failure('数据地址不是图片、音频或视频，无法作为媒体下载。');
    }
    return url.href;
  }

  function mediaFilename(input, mime, kind) {
    let name = String(input || kind || 'media').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!name || /^\.+$/.test(name)) name = kind || 'media';
    const extension = EXTENSIONS[mime] || (/\.[a-z0-9]{1,8}$/i.exec(name)?.[0].slice(1)) || FALLBACK_EXTENSIONS[kind] || 'bin';
    name = name.replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 160) || kind || 'media';
    return name + '.' + extension;
  }

  async function checkedBlob(response, kind) {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw failure('下载被拒绝（HTTP ' + response.status + '），媒体链接可能已过期或需要额外权限。可打开原始媒体后另存为。');
      throw failure('下载失败（HTTP ' + response.status + '）。请检查媒体链接是否仍然有效；也可打开原始媒体后另存为。');
    }
    const blob = await response.blob();
    if (!blob.size) throw failure('渠道返回了空文件，未触发下载。');
    const mime = (blob.type || response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mediaType = /^(?:image|audio|video)\//.test(mime);
    if (!mediaType && mime && !['application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/ogg'].includes(mime)) {
      throw failure('链接返回的内容不是媒体文件（' + mime + '），可能是错误信息或登录页面。未触发下载。');
    }
    const beginning = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer()).replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>])/i.test(beginning) ||
        /^(?:\{\s*"[^"\n]+"\s*:|\[\s*\{\s*")/.test(beginning)) {
      throw failure('链接返回了 HTML 或 JSON 错误内容，并非媒体文件。未触发下载。');
    }
    if (kind && mediaType && !mime.startsWith(kind + '/')) {
      throw failure('下载内容类型与结果不一致（' + mime + '），请先打开原始响应核对媒体地址。');
    }
    return { blob, mime };
  }

  async function download(options) {
    const { url: input, filename, kind, onStatus, signal } = options || {};
    const url = sourceUrl(input);
    const controller = new AbortController();
    let timedOut = false;
    const report = status => { if (typeof onStatus === 'function') { try { onStatus(status); } catch (_) { /* UI callbacks must not break a download. */ } } };
    const abort = () => controller.abort();
    const checkAbort = () => {
      if (timedOut) throw failure('下载超时（已等待 120 秒），请重试或打开原始媒体后另存为。');
      if (signal?.aborted || controller.signal.aborted) throw failure('下载已取消，未保存文件。');
    };
    if (signal?.aborted) throw failure('下载已取消，未保存文件。');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    try {
      report({ phase: 'fetching', receivedBytes: 0 });
      const response = await fetch(url, {
        method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: controller.signal, mode: 'cors',
      });
      checkAbort();
      const { blob, mime } = await checkedBlob(response, kind);
      checkAbort();
      const name = mediaFilename(filename, mime, kind);
      report({ phase: 'saving', receivedBytes: blob.size, totalBytes: blob.size });
      checkAbort();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      link.style.display = 'none';
      document.body.appendChild(link);
      try { link.click(); } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
      }
      report({ phase: 'done', receivedBytes: blob.size, totalBytes: blob.size });
      return { filename: name };
    } catch (error) {
      checkAbort();
      if (error?.name === 'MediaDownloadError') throw error;
      throw failure('无法读取媒体文件，可能是媒体服务器未允许跨域下载（CORS）、链接已失效或网络异常。未跳转页面。可点击“打开原始媒体”后另存为。');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  root.MediaDownloads = Object.freeze({ download });
})(typeof window !== 'undefined' ? window : globalThis);
