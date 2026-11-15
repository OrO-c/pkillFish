// ==UserScript==
// @name         pkillFish
// @name:zh-CN   pkillFish - B站大肥鱼评论净化
// @namespace    https://github.com/OrO-c/pkillFish
// @version      1.5.2
// @description  静默隐藏 B 站评论区中的 DSH / 大肥鱼 Agent 灌水评论。仅本地 DOM 处理，不调用 B 站 API，不自动举报。
// @description:en Hide suspected DSH / AI agent comments on Bilibili locally. No Bilibili API, no auto-reporting.
// @author       pkillFish contributors
// @license      MIT
// @homepageURL  https://github.com/OrO-c/pkillFish
// @supportURL   https://github.com/OrO-c/pkillFish/issues
// @updateURL    https://raw.githubusercontent.com/OrO-c/pkillFish/main/pkillFish.user.js
// @downloadURL  https://raw.githubusercontent.com/OrO-c/pkillFish/main/pkillFish.user.js
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @connect      github.com
// @connect      cdn.jsdelivr.net
// @connect      gitee.com
// @connect      gitlab.com
// @run-at       document-start
// @noframes
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// ==/UserScript==

/*
 * pkillFish
 *
 * 设计边界（请保持）：
 *   1. 只修改本地 DOM，不请求 B 站任何 API，不提交举报，不改服务端数据。
 *   2. 不自动上传评论。只有用户点击“上报可疑鱼”才打开 GitHub Issue 新建页。
 *   3. 无动画、无声音、无弹窗、无二次元装饰；默认静默，只有用户主动打开面板。
 *   4. 优先使用 data-* 稳定属性；class 仅作为兼容兜底。
 *
 * 模块顺序：
 *   utils -> GM 适配 -> 状态存储 -> 黑名单 -> 规则 -> DOM 抓取
 *   -> MutationObserver 扫描 -> 上报 -> 设置面板 -> 本地模型钩子 -> 启动
 */

(function () {
  'use strict';

  // @noframes 已经限制大多数管理器；这里再兜底一次，避免在 iframe 中重复注入。
  try {
    if (window.top !== window.self) return;
  } catch (_) {
    return;
  }

  /* ==========================================================================
   * 常量
   * ========================================================================== */

  const VERSION = '1.5.2';

  // 发布前请把这里改成你自己的 GitHub 仓库（owner/repo），并同步 README。
  const DEFAULT_REPORT_REPO = 'OrO-c/pkillFish';
  const DEFAULT_BLACKLIST_URL =
    'https://raw.githubusercontent.com/' + DEFAULT_REPORT_REPO + '/main/blacklist.json';
  const DEFAULT_KEYWORDS_URL =
    'https://raw.githubusercontent.com/' + DEFAULT_REPORT_REPO + '/main/keywords.json';
  const DEFAULT_ML_MODEL_URL =
    'https://raw.githubusercontent.com/OrO-c/pkillFish/main/ml/artifacts/model.json';

  const STORAGE = {
    state: 'pf:v1:state',
    blacklist: 'pf:v1:blacklist',
    blacklistMeta: 'pf:v1:blacklist-meta',
    keywords: 'pf:v1:keywords',
    keywordsMeta: 'pf:v1:keywords-meta'
  };

  const LIMITS = {
    maxEntries: 50000,
    maxRevoked: 50000,
    maxRules: 100,
    maxLog: 200,
    maxWhitelist: 5000,
    maxText: 5000,
    maxRetry: 5,
    maxShadowObservers: 400,
    maxCandidates: 5000,
    requestTimeout: 15000
  };

  const BLACKLIST_SCHEMA = 1;
  const MAX_BATCH_REPORTS = 10;
  const MAX_REPORT_QUEUE = 50;
  const ML_FORMAT = 'pkillfish-ml-v1';
  const ML_MAX_BYTES = 2 * 1024 * 1024;
  const MID_RE = /^[1-9]\d{0,18}$/;
  const RPID_RE = /^[1-9]\d{0,18}$/;

  const DEFAULT_SETTINGS = {
    enabled: true,
    rulesEnabled: true,
    keywordRulesEnabled: false,
    keywordBlockEnabled: true,
    keywordUrl: '',
    mlEnabled: true,
    mlOnlyBadge: true,
    mlModelUrl: '',
    offline: false,
    reportEnabled: true,
    debug: false,
    reportRepo: DEFAULT_REPORT_REPO,
    blacklistUrl: '',
    updateIntervalHours: 12,
    threshold: 3,
    weights: {
      avatar: 3,
      nickname: 3,
      phrase: 2,
      burst: 3,
      template: 3
    },
    burst: {
      count: 8,
      windowMinutes: 10
    },
    nicknameKeywords: ['dsh-agent', 'dsh agent', 'deepseek harness'],
    avatarHashes: [],
    phrasePatterns: [
      '作为(一个|一名)?(AI|人工智能|语言模型|智能体|助手)',
      '(DSH|DeepSeek\\s*Harness|dsh-dafeiyu)',
      '(本鱼|大肥鱼)(来|报到|路过|打卡|冒泡)'
    ],
    enableLocalModel: false,
    modelTimeoutMs: 500
  };

  const SELECTORS = {
    newHost: 'bili-comments',
    newThread: 'bili-comment-thread-renderer',
    newComment: 'bili-comment-renderer',
    newReply: 'bili-comment-reply-renderer',
    newReplies: 'bili-comment-replies-renderer',
    legacyItem:
      '.reply-item, .sub-reply-item, .comment-item, [data-comment-id], .comment-list [data-mid]',
    legacyInfo: '.reply-info, .sub-reply-info, .reply-operation-warp, .comment-actions',
    legacyName: '.user-name, .sub-user-name, .nickname, .user-nick, .uname',
    legacyContent:
      '.reply-content, .sub-reply-content, .comment-content, .reply-content-container .content, .content',
    legacyAvatar:
      '.root-reply-avatar img, .sub-reply-avatar img, .avatar img, .user-face img, img'
  };

  const COMMENT_PAGE_RE = /\/(video|opus|read|bangumi|list|festival|dynamic)(\/|$)/;

  /* ==========================================================================
   * 基础工具
   * ========================================================================== */

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '从未更新';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '从未更新';
    return (
      d.getFullYear() +
      '-' +
      pad2(d.getMonth() + 1) +
      '-' +
      pad2(d.getDate()) +
      ' ' +
      pad2(d.getHours()) +
      ':' +
      pad2(d.getMinutes())
    );
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 把 B 站评论时间文本转成时间戳；解析不了返回 0。
  // 用途：避免把页面上几年前的历史评论误判成“短时间高频刷屏”。
  function parsePostedAt(value) {
    const s = cleanText(value, 40, false);
    if (!s) return 0;
    const now = Date.now();
    let m;

    if (s === '刚刚' || s === '刚才') return now;
    if ((m = s.match(/^(\d+)\s*秒前$/))) return now - Number(m[1]) * 1000;
    if ((m = s.match(/^(\d+)\s*分钟前$/))) return now - Number(m[1]) * 60 * 1000;
    if ((m = s.match(/^(\d+)\s*小时前$/))) return now - Number(m[1]) * 3600 * 1000;
    if ((m = s.match(/^(\d+)\s*天前$/))) return now - Number(m[1]) * 86400 * 1000;

    if ((m = s.match(/^昨天\s*(\d{1,2}):(\d{2})$/))) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return d.getTime();
    }

    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/))) {
      const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        0,
        0
      ).getTime();
      return Number.isFinite(t) ? t : 0;
    }

    if ((m = s.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/))) {
      const d = new Date();
      let t = new Date(
        d.getFullYear(),
        Number(m[1]) - 1,
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        0,
        0
      ).getTime();
      if (t > now + 86400 * 1000) {
        t = new Date(
          d.getFullYear() - 1,
          Number(m[1]) - 1,
          Number(m[2]),
          Number(m[3]),
          Number(m[4]),
          0,
          0
        ).getTime();
      }
      return Number.isFinite(t) ? t : 0;
    }

    return 0;
  }

  function truncate(value, max) {
    const s = String(value == null ? '' : value);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  function digitsOnly(value) {
    const s = String(value == null ? '' : value).trim();
    return /^\d+$/.test(s) ? s : '';
  }

  function cleanText(value, max, keepNewlines) {
    let s = String(value == null ? '' : value);
    if (!keepNewlines) s = s.replace(/[\r\n\t]+/g, ' ');
    // 保留换行，移除其余控制字符与零宽字符
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!keepNewlines) s = s.replace(/\s+/g, ' ');
    s = s.trim();
    return s.slice(0, max);
  }

  function normalizeForMatch(value) {
    let s = String(value == null ? '' : value);
    try {
      s = s.normalize('NFKC');
    } catch (_) {
      /* 老浏览器没有 normalize，忽略 */
    }
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function fnv1a(value) {
    const s = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  const ML_URL_RE = /https?:\/\/\S+|www\.\S+/gi;
  const ML_MENTION_RE = /@[A-Za-z0-9_\-\u4e00-\u9fff]+/g;
  const ML_EMOJI_RE =
    /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;
  const ML_BULLET_RE = /(^|\n)\s*(?:[-*•]|\d+[.、)])\s+/;
  const ML_REPEAT_PUNCT_RE = /[!?！？]{2,}|[。.]{3,}/;
  let mlEncoder = null;

  function mlNormalizeText(value) {
    let text = String(value == null ? '' : value);
    try {
      text = text.normalize('NFKC');
    } catch (_) {
      /* ignore */
    }
    text = text.toLowerCase();
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    text = text.replace(ML_URL_RE, ' <url> ');
    text = text.replace(ML_MENTION_RE, ' <mention> ');
    text = text.replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, 4000).join('');
  }

  function mlLengthBucket(length) {
    if (length <= 20) return 'len_0_20';
    if (length <= 50) return 'len_21_50';
    if (length <= 100) return 'len_51_100';
    if (length <= 300) return 'len_101_300';
    return 'len_301_plus';
  }

  function mlFnv1aBytes(value) {
    const text = String(value == null ? '' : value);
    let hash = 0x811c9dc5;
    if (!mlEncoder) mlEncoder = new TextEncoder();
    const bytes = mlEncoder.encode(text);
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function mlFeatureBuckets(text, spec) {
    const buckets = new Set();
    const normalized = mlNormalizeText(text);
    if (!normalized) return buckets;

    const chars = Array.from('^' + normalized + '$');
    const minN = Math.max(1, Number(spec.ngramMin) || 1);
    const maxN = Math.min(8, Number(spec.ngramMax) || 4);
    for (let n = minN; n <= maxN; n += 1) {
      for (let i = 0; i <= chars.length - n; i += 1) {
        const gram = chars.slice(i, i + n).join('');
        if (!gram.trim()) continue;
        buckets.add(mlFnv1aBytes('g:' + gram) % spec.buckets);
      }
    }

    const tokens = [
      'f:' + mlLengthBucket(Array.from(normalized).length),
      normalized.indexOf('<url>') !== -1 ? 'f:has_url' : 'f:no_url',
      normalized.indexOf('<mention>') !== -1 ? 'f:has_mention' : 'f:no_mention',
      ML_EMOJI_RE.test(normalized) ? 'f:has_emoji' : 'f:no_emoji',
      ML_BULLET_RE.test(normalized) ? 'f:has_bullet' : 'f:no_bullet',
      normalized.indexOf('?') !== -1 || normalized.indexOf('？') !== -1
        ? 'f:has_question'
        : 'f:no_question',
      ML_REPEAT_PUNCT_RE.test(normalized) ? 'f:has_repeat_punct' : 'f:no_repeat_punct',
      normalized.indexOf('!') !== -1 || normalized.indexOf('！') !== -1
        ? 'f:has_exclaim'
        : 'f:no_exclaim'
    ];
    for (let i = 0; i < tokens.length; i += 1) {
      buckets.add(mlFnv1aBytes(tokens[i]) % spec.buckets);
    }
    return buckets;
  }

  function mlScoreText(text) {
    if (!mlModel) return null;
    const buckets = mlFeatureBuckets(text, mlModel.features);
    let sum = mlModel.bias;
    for (const bucket of buckets) {
      sum += mlModel.weights[bucket] * mlModel.quantScale;
    }
    const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, sum))));
    return { probability: probability, features: buckets.size };
  }

  function splitList(value, separators) {
    const re = separators || /[\r\n,，]+/;
    return String(value == null ? '' : value)
      .split(re)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function uniq(list) {
    const seen = Object.create(null);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const s = String(list[i]);
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  function safeJsonParse(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    const s = raw.replace(/^\uFEFF/, '').trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function compareMid(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    if (x.length !== y.length) return x.length - y.length;
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function isIsoDate(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    const t = Date.parse(value);
    return Number.isFinite(t);
  }

  function isHttpsUrl(value) {
    try {
      const u = new URL(String(value));
      return u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function normalizeRepo(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s) return '';
    s = s
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const m = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/);
    if (!m) return '';
    if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return '';
    return m[1] + '/' + m[2];
  }

  function debug() {
    if (!state || !state.settings || !state.settings.debug) return;
    try {
      console.debug.apply(console, ['[pkillFish]'].concat(Array.prototype.slice.call(arguments)));
    } catch (_) {
      /* ignore */
    }
  }

  /* ==========================================================================
   * GM API 适配（标准 GM_* 优先，缺失时降级）
   * ========================================================================== */

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key);
        return v === undefined ? fallback : v;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (_) {
      return memoryStore[key] === undefined ? fallback : memoryStore[key];
    }
  }

  const memoryStore = Object.create(null);

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (_) {
      memoryStore[key] = value;
      return false;
    }
  }

  function gmOpenTab(url) {
    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true, setParent: true });
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      return !!win;
    } catch (_) {
      return false;
    }
  }

  function xhrGet(url, headers) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      function done(fn) {
        if (settled) return;
        settled = true;
        fn();
      }

      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: headers || {},
            timeout: LIMITS.requestTimeout,
            anonymous: true,
            onload: function (res) {
              done(function () {
                resolve({
                  status: res.status,
                  text: res.responseText || '',
                  headers: res.responseHeaders || ''
                });
              });
            },
            onerror: function () {
              done(function () {
                reject(new Error('网络请求失败'));
              });
            },
            ontimeout: function () {
              done(function () {
                reject(new Error('网络请求超时'));
              });
            },
            onabort: function () {
              done(function () {
                reject(new Error('网络请求已取消'));
              });
            }
          });
          return;
        } catch (err) {
          done(function () {
            reject(err);
          });
          return;
        }
      }

      if (typeof fetch !== 'function') {
        reject(new Error('当前环境没有可用的网络请求 API'));
        return;
      }

      let controller = null;
      try {
        controller = typeof AbortController === 'function' ? new AbortController() : null;
      } catch (_) {
        controller = null;
      }
      const timer = setTimeout(function () {
        try {
          if (controller) controller.abort();
        } catch (_) {
          /* ignore */
        }
        done(function () {
          reject(new Error('网络请求超时'));
        });
      }, LIMITS.requestTimeout);

      fetch(url, {
        method: 'GET',
        headers: headers || {},
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          return res.text().then(function (text) {
            done(function () {
              resolve({
                status: res.status,
                text: text,
                headers: 'etag: ' + (res.headers.get('etag') || '')
              });
            });
          });
        })
        .catch(function (err) {
          done(function () {
            reject(err);
          });
        })
        .then(function () {
          clearTimeout(timer);
        });
    });
  }

  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (_) {
      /* ignore */
    }
    try {
      if (window.wrappedJSObject) return window.wrappedJSObject;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /* ==========================================================================
   * 状态与存储
   * ========================================================================== */

  let state = null;
  let settings = null;
  let ui = null;
  let host = null;
  let currentTab = 'status';
  let noticeText = '';
  let noticeIsError = false;
  let saveTimer = null;
  let suppressUI = false;
  let logSeq = 0;

  let blacklistDoc = emptyBlacklistDoc();
  let blacklistByMid = new Map();
  let blacklistMeta = {
    etag: '',
    checkedAt: 0,
    fetchedAt: 0,
    version: 0,
    count: 0,
    error: '',
    updating: false
  };

  let keywordDoc = {
    schemaVersion: 1,
    version: 0,
    updatedAt: '',
    nameKeywords: [],
    commentKeywords: []
  };
  let keywordMeta = {
    etag: '',
    checkedAt: 0,
    fetchedAt: 0,
    version: 0,
    count: 0,
    error: '',
    updating: false
  };
  let keywordNameList = [];
  let keywordCommentList = [];

  let whitelistSets = { mids: new Set(), rpids: new Set(), fingerprints: new Set() };
  let keywordList = [];
  let avatarList = [];
  let compiledPatterns = [];

  let active = false;
  let docObserver = null;
  let shadowObservers = new Map();
  let pendingRoots = new Set();
  let scanTimer = null;
  let processed = new WeakSet();
  let retryCount = new WeakMap();
  let injectionRetry = new WeakMap();
  let reportHosts = new WeakSet();
  let reportButtons = new Set();
  let candidates = new Set();
  let candidateList = [];
  let nodeMap = new Map();
  let recordCandidates = new Map();

  // “已屏蔽肥鱼”筛选视图状态
  let fishFilterActive = false;
  let filterButton = null;
  let filterHost = null;
  let filterHiddenNodes = new Map();
  let filterDebounce = null;
  let filterNoticeEl = null;
  let filterHeaderObservers = new WeakSet();
  let filterHeaderClickBound = new WeakSet();
  let filterSortExitBound = new WeakSet();
  let filterHeaderRetry = new WeakMap();
  let filterMasks = new Map();
  let pageStats = { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0, ml: 0 };
  let mlModel = null;
  let mlStatus = 'idle';
  let mlError = '';
  let mlPredictions = new WeakMap();
  let mlBadges = new Set();

  let burstTracker = new Map();
  let templateTracker = new Map();
  let seenTracker = new Map();

  let lastHref = '';
  let lastPageKey = '';
  let pageWatcher = null;

  function defaultSettings() {
    return safeJsonParse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function defaultState() {
    return {
      schema: 1,
      settings: defaultSettings(),
      whitelist: { mids: [], rpids: [], fingerprints: [] },
      stats: { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0, ml: 0, byDay: {} },
      log: [],
      reportQueue: [],
      migrations: {
        broadNicknameRemoved: false,
        broadRemoteNicknameRemoved: false
      }
    };
  }

  function emptyBlacklistDoc() {
    return {
      schemaVersion: BLACKLIST_SCHEMA,
      version: 0,
      updatedAt: '',
      entries: [],
      revoked: [],
      rules: { nicknameKeywords: [], avatarHashes: [] }
    };
  }

  function sanitizeStringArray(value, maxItems, maxLen, pattern) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < value.length && out.length < maxItems; i += 1) {
      const s = cleanText(value[i], maxLen, false);
      if (!s || seen[s]) continue;
      if (pattern && !pattern.test(s)) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  function sanitizeSettings(input) {
    const def = defaultSettings();
    const out = def;
    if (!isPlainObject(input)) return out;

    const boolKeys = [
      'enabled',
      'rulesEnabled',
      'keywordRulesEnabled',
      'keywordBlockEnabled',
      'mlEnabled',
      'mlOnlyBadge',
      'offline',
      'reportEnabled',
      'debug',
      'enableLocalModel'
    ];
    for (let i = 0; i < boolKeys.length; i += 1) {
      const k = boolKeys[i];
      if (typeof input[k] === 'boolean') out[k] = input[k];
    }

    const repo = cleanText(input.reportRepo, 140, false);
    out.reportRepo = normalizeRepo(repo) || def.reportRepo;
    out.blacklistUrl = cleanText(input.blacklistUrl, 500, false);
    out.keywordUrl = cleanText(input.keywordUrl, 500, false);
    out.mlModelUrl = cleanText(input.mlModelUrl, 500, false);
    out.updateIntervalHours = clampNumber(
      input.updateIntervalHours,
      0.25,
      720,
      def.updateIntervalHours
    );
    out.threshold = clampInt(input.threshold, 1, 12, def.threshold);
    out.modelTimeoutMs = clampInt(input.modelTimeoutMs, 100, 5000, def.modelTimeoutMs);

    if (isPlainObject(input.weights)) {
      const w = input.weights;
      out.weights = {
        avatar: clampInt(w.avatar, 1, 5, def.weights.avatar),
        nickname: clampInt(w.nickname, 1, 5, def.weights.nickname),
        phrase: clampInt(w.phrase, 1, 5, def.weights.phrase),
        burst: clampInt(w.burst, 1, 5, def.weights.burst),
        template: clampInt(w.template, 1, 5, def.weights.template)
      };
    }

    if (isPlainObject(input.burst)) {
      out.burst = {
        count: clampInt(input.burst.count, 2, 100, def.burst.count),
        windowMinutes: clampInt(input.burst.windowMinutes, 1, 1440, def.burst.windowMinutes)
      };
    }

    out.nicknameKeywords = sanitizeStringArray(
      input.nicknameKeywords,
      LIMITS.maxRules,
      40
    );
    out.avatarHashes = sanitizeStringArray(
      input.avatarHashes,
      LIMITS.maxRules,
      80,
      /^[a-z0-9._-]+$/
    ).map(function (s) {
      return s.toLowerCase();
    });
    out.phrasePatterns = sanitizeStringArray(input.phrasePatterns, 50, 200);

    return out;
  }

  function sanitizeWhitelist(input) {
    const out = { mids: [], rpids: [], fingerprints: [] };
    if (!isPlainObject(input)) return out;
    out.mids = sanitizeStringArray(input.mids, LIMITS.maxWhitelist, 19, MID_RE);
    out.rpids = sanitizeStringArray(input.rpids, LIMITS.maxWhitelist, 19, RPID_RE);
    out.fingerprints = sanitizeStringArray(input.fingerprints, LIMITS.maxWhitelist, 80, /^[a-z0-9:._-]+$/i);
    return out;
  }

  function sanitizeStats(input) {
    const out = { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0, ml: 0, byDay: {} };
    if (!isPlainObject(input)) return out;
    out.total = clampInt(input.total, 0, 1000000000, 0);
    out.blacklist = clampInt(input.blacklist, 0, 1000000000, 0);
    out.keyword = clampInt(input.keyword, 0, 1000000000, 0);
    out.rules = clampInt(input.rules, 0, 1000000000, 0);
    out.model = clampInt(input.model, 0, 1000000000, 0);
    out.ml = clampInt(input.ml, 0, 1000000000, 0);
    if (isPlainObject(input.byDay)) {
      const keys = Object.keys(input.byDay).sort();
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        out.byDay[k] = clampInt(input.byDay[k], 0, 1000000000, 0);
      }
      const all = Object.keys(out.byDay);
      if (all.length > 90) {
        const keep = all.slice(all.length - 90);
        const trimmed = {};
        for (let i = 0; i < keep.length; i += 1) trimmed[keep[i]] = out.byDay[keep[i]];
        out.byDay = trimmed;
      }
    }
    return out;
  }

  function sanitizeLog(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (let i = 0; i < input.length && out.length < LIMITS.maxLog; i += 1) {
      const r = input[i];
      if (!isPlainObject(r)) continue;
      const reason =
        r.reason === 'blacklist' ||
        r.reason === 'keyword' ||
        r.reason === 'rules' ||
        r.reason === 'model' ||
        r.reason === 'ml'
          ? r.reason
          : 'rules';
      out.push({
        id: cleanText(r.id, 40, false) || 'legacy-' + i,
        ts: clampInt(r.ts, 0, 9999999999999, 0),
        mid: digitsOnly(r.mid),
        rpid: digitsOnly(r.rpid),
        uname: cleanText(r.uname, 80, false),
        text: cleanText(r.text, 500, true),
        reason: reason,
        detail: cleanText(r.detail, 160, false),
        score: clampInt(r.score, 0, 99, 0),
        fp: cleanText(r.fp, 80, false),
        url: cleanText(r.url, 400, false),
        restored: r.restored === true
      });
    }
    return out;
  }

  function sanitizeReportQueue(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < input.length && out.length < MAX_REPORT_QUEUE; i += 1) {
      const item = input[i];
      if (!isPlainObject(item)) continue;
      const mid = digitsOnly(item.mid);
      const link = cleanText(item.link, 500, false);
      if (!mid || !link || !isBilibiliCommentUrl(link)) continue;
      const key = mid + '|' + (digitsOnly(item.rpid) || fnv1a(cleanText(item.text, 500, true)));
      if (seen[key]) continue;
      seen[key] = true;
      out.push({
        id: cleanText(item.id, 40, false) || 'q-' + i,
        key: key,
        mid: mid,
        rpid: digitsOnly(item.rpid),
        oid: digitsOnly(item.oid),
        type: digitsOnly(item.type),
        link: link,
        uname: cleanText(item.uname, 80, false),
        text: cleanText(item.text, 500, true),
        selected: item.selected !== false,
        queuedAt: clampInt(item.queuedAt, 0, 9999999999999, 0)
      });
    }
    return out;
  }

  function loadState() {
    const raw = gmGet(STORAGE.state, null);
    const saved = safeJsonParse(raw);
    const fresh = defaultState();
    let dirty = false;
    if (!isPlainObject(saved)) {
      state = fresh;
    } else {
      state = fresh;
      state.settings = sanitizeSettings(saved.settings);
      state.whitelist = sanitizeWhitelist(saved.whitelist);
      state.stats = sanitizeStats(saved.stats);
      state.log = sanitizeLog(saved.log);
      state.reportQueue = sanitizeReportQueue(saved.reportQueue);
      if (isPlainObject(saved.migrations)) {
        state.migrations.broadNicknameRemoved =
          saved.migrations.broadNicknameRemoved === true;
        state.migrations.broadRemoteNicknameRemoved =
          saved.migrations.broadRemoteNicknameRemoved === true;
      }
    }

    // 1.1.2：单独词“大肥鱼”会把普通用户的昵称误判成 Agent。
    // 仅移除这个过宽的默认词，保留 dsh-agent / deepseek harness 等更具体的词。
    if (!state.migrations.broadNicknameRemoved) {
      const before = state.settings.nicknameKeywords.length;
      state.settings.nicknameKeywords = state.settings.nicknameKeywords.filter(
        function (keyword) {
          return keyword !== '大肥鱼';
        }
      );
      state.migrations.broadNicknameRemoved = true;
      if (state.settings.nicknameKeywords.length !== before) dirty = true;
    }

    settings = state.settings;
    rebuildWhitelistSets();
    if (dirty) saveState(true);
    debug('state loaded', { settings: settings });
  }

  function statePayload() {
    return {
      schema: 1,
      settings: state.settings,
      whitelist: state.whitelist,
      stats: state.stats,
      log: state.log,
      reportQueue: state.reportQueue,
      migrations: state.migrations
    };
  }

  function saveState(immediate) {
    if (!state) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (immediate) {
      gmSet(STORAGE.state, JSON.stringify(statePayload()));
      return;
    }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      gmSet(STORAGE.state, JSON.stringify(statePayload()));
    }, 350);
  }

  function flushState() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (state) gmSet(STORAGE.state, JSON.stringify(statePayload()));
  }

  function rebuildWhitelistSets() {
    whitelistSets = {
      mids: new Set(state.whitelist.mids),
      rpids: new Set(state.whitelist.rpids),
      fingerprints: new Set(state.whitelist.fingerprints)
    };
  }

  /* ==========================================================================
   * 黑名单：解析、缓存、增量更新
   * ========================================================================== */

  function normalizeEntry(raw) {
    let mid = '';
    let addedAt = '';
    let reports = [];

    if (typeof raw === 'string' || typeof raw === 'number') {
      mid = digitsOnly(raw);
    } else if (isPlainObject(raw)) {
      mid = digitsOnly(raw.mid);
      addedAt = isIsoDate(raw.addedAt) ? new Date(raw.addedAt).toISOString() : '';
      if (Array.isArray(raw.reports)) {
        for (let i = 0; i < raw.reports.length && reports.length < 200; i += 1) {
          const n = clampInt(raw.reports[i], 1, 1000000000, 0);
          if (n && reports.indexOf(n) === -1) reports.push(n);
        }
      }
    }

    if (!MID_RE.test(mid)) return null;
    return { mid: mid, addedAt: addedAt, reports: reports };
  }

  function normalizeDoc(input) {
    const out = emptyBlacklistDoc();
    let rejected = 0;

    if (input == null) return { doc: out, rejected: rejected };
    let source = input;
    if (Array.isArray(source)) source = { entries: source };
    if (!isPlainObject(source)) return { doc: out, rejected: 1 };

    out.version = clampInt(source.version, 0, 1000000000, 0);
    out.updatedAt = isIsoDate(source.updatedAt) ? new Date(source.updatedAt).toISOString() : '';

    const revoked = Object.create(null);
    if (Array.isArray(source.revoked)) {
      for (let i = 0; i < source.revoked.length && i < LIMITS.maxRevoked; i += 1) {
        const mid = digitsOnly(source.revoked[i]);
        if (MID_RE.test(mid)) revoked[mid] = true;
        else rejected += 1;
      }
    }
    out.revoked = Object.keys(revoked).sort(compareMid);

    const byMid = new Map();
    const rawEntries = Array.isArray(source.entries) ? source.entries : [];
    const scanLimit = Math.min(rawEntries.length, LIMITS.maxEntries * 2);
    for (let i = 0; i < scanLimit && byMid.size < LIMITS.maxEntries; i += 1) {
      const entry = normalizeEntry(rawEntries[i]);
      if (!entry) {
        rejected += 1;
        continue;
      }
      if (revoked[entry.mid]) continue;
      if (byMid.has(entry.mid)) {
        // 同一 mid 取信息更完整的一条，不视为脏数据
        const old = byMid.get(entry.mid);
        if (!old.addedAt && entry.addedAt) old.addedAt = entry.addedAt;
        for (let r = 0; r < entry.reports.length; r += 1) {
          if (old.reports.indexOf(entry.reports[r]) === -1) old.reports.push(entry.reports[r]);
        }
        continue;
      }
      byMid.set(entry.mid, entry);
    }

    out.entries = Array.from(byMid.values()).sort(function (a, b) {
      return compareMid(a.mid, b.mid);
    });

    if (isPlainObject(source.rules)) {
      out.rules.nicknameKeywords = sanitizeStringArray(
        source.rules.nicknameKeywords,
        LIMITS.maxRules,
        40
      );
      out.rules.avatarHashes = sanitizeStringArray(
        source.rules.avatarHashes,
        LIMITS.maxRules,
        80,
        /^[a-z0-9._-]+$/
      ).map(function (s) {
        return s.toLowerCase();
      });
    }

    return { doc: out, rejected: rejected };
  }

  function parseEtag(headerText) {
    const m = String(headerText || '').match(/etag:\s*([^\r\n]+)/i);
    return m ? m[1].trim() : '';
  }

  function parseRemoteText(text) {
    const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error('远端内容为空');

    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        throw new Error('远端 JSON 解析失败');
      }
      return parsed;
    }

    // 纯文本名单：每行一个 UID，可用 #、|、-- 或空白追加理由
    const entries = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) === '#' || line.indexOf('//') === 0) continue;
      const m = line.match(/^(\d{1,19})(?:\s*(?:#|\||--|,|-|\s)\s*(.*))?$/);
      if (!m) continue;
      entries.push({ mid: m[1] });
    }
    if (!entries.length) throw new Error('远端文本中没有可解析的 UID');
    return { entries: entries, version: 0, updatedAt: new Date().toISOString() };
  }

  function mergeDocs(cached, remote) {
    const map = new Map();
    for (let i = 0; i < cached.entries.length; i += 1) {
      map.set(cached.entries[i].mid, cached.entries[i]);
    }
    for (let i = 0; i < remote.entries.length; i += 1) {
      map.set(remote.entries[i].mid, remote.entries[i]);
    }

    const revoked = Object.create(null);
    for (let i = 0; i < cached.revoked.length; i += 1) revoked[cached.revoked[i]] = true;
    for (let i = 0; i < remote.revoked.length; i += 1) revoked[remote.revoked[i]] = true;
    for (const mid of Object.keys(revoked)) map.delete(mid);

    const keywords = uniq(
      (cached.rules.nicknameKeywords || []).concat(remote.rules.nicknameKeywords || [])
    ).slice(0, LIMITS.maxRules);
    const avatars = uniq(
      (cached.rules.avatarHashes || []).concat(remote.rules.avatarHashes || [])
    )
      .map(function (s) {
        return s.toLowerCase();
      })
      .slice(0, LIMITS.maxRules);

    return {
      schemaVersion: BLACKLIST_SCHEMA,
      version: Math.max(cached.version || 0, remote.version || 0),
      updatedAt: remote.updatedAt || cached.updatedAt || new Date().toISOString(),
      entries: Array.from(map.values())
        .filter(function (e) {
          return !revoked[e.mid];
        })
        .sort(function (a, b) {
          return compareMid(a.mid, b.mid);
        }),
      revoked: Object.keys(revoked).sort(compareMid),
      rules: { nicknameKeywords: keywords, avatarHashes: avatars }
    };
  }

  function blacklistFingerprint(doc) {
    return (
      doc.version +
      '|' +
      doc.updatedAt +
      '|' +
      doc.entries
        .map(function (e) {
          return e.mid + ':' + e.addedAt + ':' + e.reports.join('.');
        })
        .join(',') +
      '|' +
      doc.revoked.join(',') +
      '|' +
      doc.rules.nicknameKeywords.join(',') +
      '|' +
      doc.rules.avatarHashes.join(',')
    );
  }

  function rebuildBlacklistIndex() {
    blacklistByMid = new Map();
    for (let i = 0; i < blacklistDoc.entries.length; i += 1) {
      blacklistByMid.set(blacklistDoc.entries[i].mid, blacklistDoc.entries[i]);
    }
  }

  function loadBlacklistCache() {
    const cached = safeJsonParse(gmGet(STORAGE.blacklist, null));
    let cacheDirty = false;
    if (cached) {
      const normalized = normalizeDoc(cached);
      blacklistDoc = normalized.doc;
      if (normalized.rejected) debug('blacklist cache rejected entries', normalized.rejected);
    }

    // 同时清掉旧缓存里远端下发的“大肥鱼”宽泛关键词，避免更新后仍被旧缓存误伤。
    if (!state.migrations.broadRemoteNicknameRemoved) {
      const before = blacklistDoc.rules.nicknameKeywords.length;
      blacklistDoc.rules.nicknameKeywords = blacklistDoc.rules.nicknameKeywords.filter(
        function (keyword) {
          return keyword !== '大肥鱼';
        }
      );
      state.migrations.broadRemoteNicknameRemoved = true;
      if (blacklistDoc.rules.nicknameKeywords.length !== before) cacheDirty = true;
    }

    const meta = safeJsonParse(gmGet(STORAGE.blacklistMeta, null));
    if (isPlainObject(meta)) {
      blacklistMeta.etag = cleanText(meta.etag, 300, false);
      blacklistMeta.checkedAt = clampInt(meta.checkedAt, 0, 9999999999999, 0);
      blacklistMeta.fetchedAt = clampInt(meta.fetchedAt, 0, 9999999999999, 0);
      blacklistMeta.error = cleanText(meta.error, 200, false);
    }
    blacklistMeta.version = blacklistDoc.version;
    blacklistMeta.count = blacklistDoc.entries.length;

    rebuildBlacklistIndex();
    rebuildRules();
    if (cacheDirty) {
      persistBlacklistCache();
      saveState();
    }
    debug('blacklist loaded', {
      entries: blacklistDoc.entries.length,
      version: blacklistDoc.version
    });
  }

  function persistBlacklistCache() {
    gmSet(STORAGE.blacklist, JSON.stringify(blacklistDoc));
    gmSet(
      STORAGE.blacklistMeta,
      JSON.stringify({
        etag: blacklistMeta.etag,
        checkedAt: blacklistMeta.checkedAt,
        fetchedAt: blacklistMeta.fetchedAt,
        error: blacklistMeta.error
      })
    );
  }

  function applyBlacklistDoc(doc, metaPatch) {
    blacklistDoc = doc;
    blacklistMeta.version = doc.version;
    blacklistMeta.count = doc.entries.length;
    if (metaPatch) {
      if (metaPatch.etag !== undefined) blacklistMeta.etag = metaPatch.etag;
      if (metaPatch.fetchedAt !== undefined) blacklistMeta.fetchedAt = metaPatch.fetchedAt;
      if (metaPatch.error !== undefined) blacklistMeta.error = metaPatch.error;
    }
    rebuildBlacklistIndex();
    rebuildRules();
    persistBlacklistCache();

    // 远端名单可能在评论渲染之后才到达；重新评估已存在的候选。
    if (active && settings.enabled) {
      rescanCandidates();
    } else {
      refreshUI();
    }
  }

  async function updateBlacklist(force) {
    if (!settings) return;
    if (settings.offline) {
      setNotice('离线模式已开启：不会拉取远端黑名单。');
      refreshUI();
      return;
    }
    if (blacklistMeta.updating) return;

    const intervalMs = settings.updateIntervalHours * 3600 * 1000;
    if (
      !force &&
      blacklistMeta.checkedAt > 0 &&
      Date.now() - blacklistMeta.checkedAt < intervalMs
    ) {
      debug('blacklist update skipped, not due');
      return;
    }

    const url = (settings.blacklistUrl || DEFAULT_BLACKLIST_URL).trim();
    if (!isHttpsUrl(url)) {
      blacklistMeta.error = '黑名单地址必须是 https URL';
      blacklistMeta.checkedAt = Date.now();
      persistBlacklistCache();
      setNotice(blacklistMeta.error, true);
      refreshUI();
      return;
    }

    blacklistMeta.updating = true;
    blacklistMeta.error = '';
    setNotice('正在检查远端黑名单…');
    refreshUI();

    try {
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache'
      };
      if (blacklistMeta.etag) headers['If-None-Match'] = blacklistMeta.etag;

      const res = await xhrGet(url, headers);
      blacklistMeta.checkedAt = Date.now();

      // 用户在请求过程中切到离线模式：本次结果不写入，避免违背离线承诺。
      if (settings.offline) {
        setNotice('已切换离线模式，本次远端结果未写入。');
        return;
      }

      if (res.status === 304) {
        blacklistMeta.error = '';
        persistBlacklistCache();
        setNotice('黑名单已是最新（304）。');
        debug('blacklist not modified');
        return;
      }
      if (res.status !== 200) throw new Error('黑名单请求返回 HTTP ' + res.status);
      if (String(res.text).length > 8 * 1024 * 1024) {
        throw new Error('远端黑名单超过 8MB 上限');
      }

      const parsed = normalizeDoc(parseRemoteText(res.text));
      if (parsed.rejected) debug('remote blacklist rejected entries', parsed.rejected);

      const merged = mergeDocs(blacklistDoc, parsed.doc);
      const changed = blacklistFingerprint(merged) !== blacklistFingerprint(blacklistDoc);
      const etag = parseEtag(res.headers);

      if (changed) {
        applyBlacklistDoc(merged, { etag: etag, fetchedAt: Date.now(), error: '' });
        setNotice(
          '黑名单已更新：' + merged.entries.length + ' 条，版本 ' + merged.version + '。'
        );
        debug('blacklist updated', {
          entries: merged.entries.length,
          version: merged.version
        });
      } else {
        blacklistMeta.etag = etag || blacklistMeta.etag;
        blacklistMeta.fetchedAt = Date.now();
        blacklistMeta.error = '';
        persistBlacklistCache();
        setNotice('黑名单无变化。');
      }
    } catch (err) {
      blacklistMeta.error = truncate(err && err.message ? err.message : String(err), 180);
      blacklistMeta.checkedAt = Date.now();
      persistBlacklistCache();
      setNotice('黑名单更新失败：' + blacklistMeta.error, true);
      debug('blacklist update failed', err);
    } finally {
      blacklistMeta.updating = false;
      persistBlacklistCache();
      refreshUI();
    }
  }

  /* ==========================================================================
   * 独立关键词规则：keywords.json
   *
   * 与 UID 黑名单完全分离：
   *   - nameKeywords：命中昵称即自动屏蔽
   *   - commentKeywords：命中评论正文即自动屏蔽
   * 被自动屏蔽的评论不注入“上报可疑鱼”按钮；如果用户强行提交 Issue，
   * workflow 会用仓库里的 keywords.json 再检查一次，命中则拒绝。
   * ========================================================================== */

  function emptyKeywordDoc() {
    return {
      schemaVersion: 1,
      version: 0,
      updatedAt: '',
      nameKeywords: [],
      commentKeywords: []
    };
  }

  function normalizeKeywordDoc(input) {
    const out = emptyKeywordDoc();
    if (!isPlainObject(input)) return out;
    out.version = clampInt(input.version, 0, 1000000000, 0);
    out.updatedAt = isIsoDate(input.updatedAt) ? new Date(input.updatedAt).toISOString() : '';
    out.nameKeywords = sanitizeStringArray(input.nameKeywords, 500, 40);
    out.commentKeywords = sanitizeStringArray(input.commentKeywords, 500, 40);
    return out;
  }

  function rebuildKeywordIndex() {
    keywordNameList = (keywordDoc.nameKeywords || [])
      .map(function (keyword) {
        return normalizeForMatch(keyword);
      })
      .filter(Boolean);
    keywordCommentList = (keywordDoc.commentKeywords || [])
      .map(function (keyword) {
        return normalizeForMatch(keyword);
      })
      .filter(Boolean);
  }

  function matchKeyword(candidate) {
    if (!candidate || !settings.keywordBlockEnabled) return null;

    if (candidate.uname) {
      const uname = normalizeForMatch(candidate.uname);
      for (let i = 0; i < keywordNameList.length; i += 1) {
        const keyword = keywordNameList[i];
        if (keyword && uname.indexOf(keyword) !== -1) {
          return { kind: 'name', keyword: keyword };
        }
      }
    }

    if (candidate.text) {
      const text = normalizeForMatch(candidate.text);
      for (let i = 0; i < keywordCommentList.length; i += 1) {
        const keyword = keywordCommentList[i];
        if (keyword && text.indexOf(keyword) !== -1) {
          return { kind: 'comment', keyword: keyword };
        }
      }
    }

    return null;
  }

  function loadKeywordCache() {
    const cached = safeJsonParse(gmGet(STORAGE.keywords, null));
    if (cached) {
      keywordDoc = normalizeKeywordDoc(cached);
    }
    const meta = safeJsonParse(gmGet(STORAGE.keywordsMeta, null));
    if (isPlainObject(meta)) {
      keywordMeta.etag = cleanText(meta.etag, 300, false);
      keywordMeta.checkedAt = clampInt(meta.checkedAt, 0, 9999999999999, 0);
      keywordMeta.fetchedAt = clampInt(meta.fetchedAt, 0, 9999999999999, 0);
      keywordMeta.error = cleanText(meta.error, 200, false);
    }
    keywordMeta.version = keywordDoc.version;
    keywordMeta.count = keywordDoc.nameKeywords.length + keywordDoc.commentKeywords.length;
    rebuildKeywordIndex();
    debug('keywords loaded', {
      names: keywordDoc.nameKeywords.length,
      comments: keywordDoc.commentKeywords.length
    });
  }

  function persistKeywordCache() {
    gmSet(STORAGE.keywords, JSON.stringify(keywordDoc));
    gmSet(
      STORAGE.keywordsMeta,
      JSON.stringify({
        etag: keywordMeta.etag,
        checkedAt: keywordMeta.checkedAt,
        fetchedAt: keywordMeta.fetchedAt,
        error: keywordMeta.error
      })
    );
  }

  async function updateKeywords(force) {
    if (!settings) return;
    if (settings.offline) return;
    if (keywordMeta.updating) return;

    const intervalMs = settings.updateIntervalHours * 3600 * 1000;
    if (
      !force &&
      keywordMeta.checkedAt > 0 &&
      Date.now() - keywordMeta.checkedAt < intervalMs
    ) {
      return;
    }

    const url = (settings.keywordUrl || DEFAULT_KEYWORDS_URL).trim();
    if (!isHttpsUrl(url)) {
      keywordMeta.error = '关键词地址必须是 https URL';
      keywordMeta.checkedAt = Date.now();
      persistKeywordCache();
      refreshUI();
      return;
    }

    keywordMeta.updating = true;
    keywordMeta.error = '';
    refreshUI();

    try {
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache'
      };
      if (keywordMeta.etag) headers['If-None-Match'] = keywordMeta.etag;

      const res = await xhrGet(url, headers);
      keywordMeta.checkedAt = Date.now();

      if (settings.offline) return;
      if (res.status === 304) {
        keywordMeta.error = '';
        persistKeywordCache();
        refreshUI();
        return;
      }
      if (res.status !== 200) throw new Error('关键词请求返回 HTTP ' + res.status);
      if (String(res.text).length > 2 * 1024 * 1024) {
        throw new Error('关键词文件超过 2MB 上限');
      }

      const parsed = safeJsonParse(res.text);
      if (!parsed || !isPlainObject(parsed)) throw new Error('关键词不是合法 JSON 对象');
      const next = normalizeKeywordDoc(parsed);

      keywordDoc = next;
      keywordMeta.version = next.version;
      keywordMeta.count = next.nameKeywords.length + next.commentKeywords.length;
      keywordMeta.etag = parseEtag(res.headers) || keywordMeta.etag;
      keywordMeta.fetchedAt = Date.now();
      keywordMeta.error = '';
      rebuildKeywordIndex();
      persistKeywordCache();

      if (active && settings.enabled) rescanCandidates();
      refreshUI();
      setNotice(
        '关键词规则已更新：昵称 ' +
          next.nameKeywords.length +
          ' 条，评论 ' +
          next.commentKeywords.length +
          ' 条。'
      );
    } catch (err) {
      keywordMeta.error = truncate(err && err.message ? err.message : String(err), 180);
      keywordMeta.checkedAt = Date.now();
      persistKeywordCache();
      setNotice('关键词更新失败：' + keywordMeta.error, true);
      debug('keywords update failed', err);
    } finally {
      keywordMeta.updating = false;
      persistKeywordCache();
      refreshUI();
    }
  }

  async function updateAll(force) {
    await Promise.all([updateBlacklist(force), updateKeywords(force)]);
  }

  /* ==========================================================================
   * 实验性：手动加载的轻量文本模型
   *
   * 模型只在用户点击“加载本页模型”时请求和解析；不写入 state，
   * 页面切换时释放。默认只加名称旁标识，不隐藏；关闭“仅标记”后才折叠。
   * ========================================================================== */

  function mlModelUrl() {
    return (settings.mlModelUrl || DEFAULT_ML_MODEL_URL).trim();
  }

  function mlStatusText() {
    if (mlStatus === 'loading') return '加载中';
    if (mlStatus === 'ready' && mlModel) return '已加载 v' + (mlModel.version || '?');
    if (mlStatus === 'error') return '加载失败：' + (mlError || '未知错误');
    return '未加载';
  }

  function mlStateApply() {
    if (ui && ui.mlState) ui.mlState.textContent = mlStatusText();
    if (ui && ui.mlLoad) {
      ui.mlLoad.disabled =
        !settings.mlEnabled || mlStatus === 'loading' || settings.offline;
    }
    if (ui && ui.mlUnload) ui.mlUnload.disabled = !mlModel;
  }

  function base64Bytes(value) {
    const text = String(value || '').replace(/\s+/g, '');
    if (!text) throw new Error('模型权重为空');
    const raw = window.atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i) & 0xff;
    return bytes;
  }

  async function loadMlModel() {
    if (!settings.mlEnabled) {
      setNotice('请先启用实验性本地模型。', true);
      return;
    }
    if (settings.offline) {
      setNotice('离线模式不能加载模型。', true);
      return;
    }
    if (mlStatus === 'loading') return;
    if (mlModel) return;

    const url = mlModelUrl();
    if (!isHttpsUrl(url)) {
      mlStatus = 'error';
      mlError = '模型地址必须是 HTTPS';
      mlStateApply();
      return;
    }

    mlStatus = 'loading';
    mlError = '';
    mlStateApply();
    setNotice('正在加载实验模型（仅当前页面）…');

    try {
      const res = await xhrGet(url, { Accept: 'application/json, */*' });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      if (String(res.text).length > ML_MAX_BYTES) throw new Error('模型超过 2MB 上限');
      const parsed = safeJsonParse(res.text);
      if (!parsed || parsed.format !== ML_FORMAT) throw new Error('模型格式不支持');
      const features = parsed.features;
      if (!isPlainObject(features)) throw new Error('缺少 features');
      const buckets = clampInt(features.buckets, 16, 262144, 0);
      if (!buckets) throw new Error('features.buckets 无效');
      if (typeof parsed.weights !== 'string') throw new Error('缺少权重');
      const bytes = base64Bytes(parsed.weights);
      if (bytes.length < buckets) throw new Error('权重数量不足');
      const weights = new Int8Array(bytes.buffer, bytes.byteOffset, buckets);
      const quantScale = Number(parsed.quantScale);
      const bias = Number(parsed.bias);
      const threshold = Number(parsed.threshold);
      if (!Number.isFinite(quantScale) || quantScale <= 0) throw new Error('quantScale 无效');
      if (!Number.isFinite(bias)) throw new Error('bias 无效');
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
        throw new Error('threshold 无效');
      }

      mlModel = {
        version: cleanText(parsed.version || '', 40, false),
        features: features,
        weights: weights,
        quantScale: quantScale,
        bias: bias,
        threshold: threshold,
        metrics: isPlainObject(parsed.metrics) ? parsed.metrics : {}
      };
      mlStatus = 'ready';
      mlError = '';
      setNotice(
        '实验模型已加载：' +
          mlStatusText() +
          '。仅对当前页面生效。'
      );
      mlApplyAll();
    } catch (err) {
      mlModel = null;
      mlStatus = 'error';
      mlError = truncate(err && err.message ? err.message : String(err), 160);
      setNotice('模型加载失败：' + mlError, true);
    } finally {
      mlStateApply();
      refreshUI();
    }
  }

  function unloadMlModel(silent) {
    const had = !!mlModel;
    if (mlModel) {
      mlRestoreAllMlHidden();
      removeAllMlBadges();
    }
    mlModel = null;
    mlPredictions = new WeakMap();
    mlStatus = 'idle';
    mlError = '';
    if (had && !silent) setNotice('实验模型已卸载，相关标识和折叠已移除。');
    mlStateApply();
    refreshUI();
  }

  function mlNameHost(candidate) {
    if (!candidate || !candidate.el) return null;
    if (candidate.kind === 'new-root' || candidate.kind === 'new-reply') {
      const userInfo = candidate.el.shadowRoot
        ? candidate.el.shadowRoot.querySelector('bili-comment-user-info')
        : null;
      const root = userInfo && userInfo.shadowRoot;
      if (root) {
        const name = root.querySelector('#user-name');
        if (name && name.parentNode) return { parent: name.parentNode, after: name };
        const info = root.querySelector('#info');
        if (info) return { parent: info, after: null };
      }
      return null;
    }
    const name = candidate.el.querySelector(SELECTORS.legacyName);
    if (name && name.parentNode) return { parent: name.parentNode, after: name };
    return null;
  }

  function ensureMlBadge(candidate) {
    if (!candidate || !candidate.el || !candidate.el.isConnected) return;
    if (candidate.mlBadge && candidate.mlBadge.isConnected) return;
    const host = mlNameHost(candidate);
    if (!host || !host.parent) return;

    // B 站可能重建用户信息节点，先清掉同容器里的旧标识。
    const stale = host.parent.querySelectorAll('[data-pf-ml-badge]');
    for (let i = 0; i < stale.length; i += 1) {
      try {
        stale[i].parentNode.removeChild(stale[i]);
      } catch (_) {
        /* ignore */
      }
    }

    const badge = document.createElement('span');
    badge.setAttribute('data-pf-ml-badge', '1');
    badge.textContent = '机器学习判定为AI生成';
    badge.title = '实验性本地模型判定，可能误判；可在日志中恢复或加入白名单';
    badge.style.cssText =
      'display:inline-flex;align-items:center;height:16px;line-height:16px;' +
      'padding:0 4px;margin-left:4px;background:#b42318;color:#fff;' +
      'font-size:10px;font-weight:400;font-family:inherit;border-radius:2px;' +
      'white-space:nowrap;vertical-align:middle;box-sizing:border-box;' +
      'letter-spacing:0;';
    if (window.innerWidth <= 600) badge.style.fontSize = '9px';

    if (host.after && host.after.parentNode === host.parent) {
      host.parent.insertBefore(badge, host.after.nextSibling);
    } else {
      host.parent.appendChild(badge);
    }
    candidate.mlBadge = badge;
    mlBadges.add(badge);
  }

  function removeMlBadge(candidate) {
    if (!candidate) return;
    const badge = candidate.mlBadge;
    if (badge) {
      try {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      } catch (_) {
        /* ignore */
      }
      mlBadges.delete(badge);
    }
    candidate.mlBadge = null;
  }

  function removeAllMlBadges() {
    for (const badge of mlBadges) {
      try {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      } catch (_) {
        /* ignore */
      }
    }
    mlBadges = new Set();
    for (const candidate of candidates) candidate.mlBadge = null;
  }

  function mlRestoreCandidate(candidate) {
    if (!candidate) return;
    let changed = false;
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.reason !== 'ml' || record.restored) continue;
      if (recordCandidates.get(record.id) !== candidate) continue;
      unhideNodes(nodeMap.get(record.id));
      record.restored = true;
      changed = true;
    }
    if (candidate.hidden) candidate.hidden = false;
    candidate.mlHidden = false;
    candidate.restored = true;
    injectReportButton(candidate);
    if (changed) {
      saveState();
      refreshUI();
      scheduleFilterRefresh();
    }
  }

  function mlRestoreAllMlHidden() {
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.reason !== 'ml' || record.restored) continue;
      const candidate = recordCandidates.get(record.id);
      if (candidate) {
        unhideNodes(nodeMap.get(record.id));
        record.restored = true;
        candidate.hidden = false;
        candidate.mlHidden = false;
        candidate.restored = true;
        injectReportButton(candidate);
      }
    }
    scheduleFilterRefresh();
  }

  function mlApplyCandidate(candidate) {
    if (!mlModel || !settings.mlEnabled) return;
    if (!candidate || !candidate.el || !candidate.el.isConnected) return;
    if (candidate.hidden && !candidate.mlHidden) return;

    const result = mlScoreText(candidate.text || '');
    if (!result) return;
    candidate.mlScore = result.probability;

    if (result.probability < mlModel.threshold) {
      removeMlBadge(candidate);
      if (candidate.mlHidden) mlRestoreCandidate(candidate);
      return;
    }

    ensureMlBadge(candidate);
    if (settings.mlOnlyBadge) {
      if (candidate.mlHidden) mlRestoreCandidate(candidate);
      return;
    }

    if (candidate.hidden) return;
    const hidden = hideCandidate(candidate, {
      block: true,
      reason: 'ml',
      detail: '实验性模型 p=' + result.probability.toFixed(3),
      score: Math.round(result.probability * 100)
    });
    if (hidden) candidate.mlHidden = true;
  }

  function mlApplyAll() {
    if (!mlModel || !settings.mlEnabled) return;
    for (const candidate of candidates) {
      if (candidate && candidate.el && candidate.el.isConnected) mlApplyCandidate(candidate);
    }
    scheduleFilterRefresh();
  }

  async function mlReloadForModeChange() {
    if (!mlModel) return;
    mlRestoreAllMlHidden();
    mlApplyAll();
  }

  /* ==========================================================================
   * 规则匹配（黑名单优先，其后才是启发式规则）
   * ========================================================================== */

  function compilePatterns(patterns) {
    const out = [];
    if (!Array.isArray(patterns)) return out;
    for (let i = 0; i < patterns.length && out.length < 50; i += 1) {
      const source = cleanText(patterns[i], 200, false);
      if (!source) continue;
      try {
        out.push(new RegExp(source, 'iu'));
      } catch (_) {
        debug('invalid phrase pattern ignored', source);
      }
    }
    return out;
  }

  function rebuildRules() {
    const remoteRules = blacklistDoc.rules || {};
    keywordList = uniq(
      (settings.nicknameKeywords || []).concat(remoteRules.nicknameKeywords || [])
    )
      .map(function (s) {
        return normalizeForMatch(s);
      })
      .filter(Boolean)
      .slice(0, LIMITS.maxRules);
    avatarList = uniq(
      (settings.avatarHashes || []).concat(remoteRules.avatarHashes || [])
    )
      .map(function (s) {
        return String(s).toLowerCase();
      })
      .filter(Boolean)
      .slice(0, LIMITS.maxRules);
    compiledPatterns = compilePatterns(settings.phrasePatterns || []);
  }

  function avatarKey(url) {
    if (!url) return '';
    let clean = String(url).split('?')[0].split('@')[0];
    const slash = clean.lastIndexOf('/');
    if (slash >= 0) clean = clean.slice(slash + 1);
    return clean.trim().toLowerCase();
  }

  function fingerprintOf(candidate) {
    if (!candidate || !candidate.text) return '';
    if (candidate.mid) return candidate.mid + ':' + fnv1a(normalizeForMatch(candidate.text));
    return 'anon:' + fnv1a(normalizeForMatch(candidate.text));
  }

  function isWhitelisted(candidate) {
    if (!candidate) return false;
    if (candidate.mid && whitelistSets.mids.has(candidate.mid)) return true;
    if (candidate.rpid && whitelistSets.rpids.has(candidate.rpid)) return true;
    const fp = candidate.fp || fingerprintOf(candidate);
    if (fp && whitelistSets.fingerprints.has(fp)) return true;
    return false;
  }

  function pruneTrackers(now) {
    const windowMs = Math.max(1, settings.burst.windowMinutes) * 60 * 1000;

    for (const [mid, times] of burstTracker) {
      const kept = times.filter(function (t) {
        return now - t <= windowMs;
      });
      if (kept.length) burstTracker.set(mid, kept);
      else burstTracker.delete(mid);
    }

    for (const [key, entry] of templateTracker) {
      const kept = entry.times.filter(function (t) {
        return now - t <= windowMs;
      });
      if (kept.length) {
        entry.times = kept;
        templateTracker.set(key, entry);
      } else {
        templateTracker.delete(key);
      }
    }

    if (seenTracker.size > 5000) {
      const cutoff = now - windowMs;
      for (const [key, ts] of seenTracker) {
        if (ts < cutoff) seenTracker.delete(key);
      }
      while (seenTracker.size > 5000) {
        const oldest = seenTracker.keys().next().value;
        if (oldest === undefined) break;
        seenTracker.delete(oldest);
      }
    }
  }

  function evaluateRules(candidate) {
    const now = Date.now();
    pruneTrackers(now);

    const hits = [];
    let score = 0;

    if (candidate.avatar) {
      const key = avatarKey(candidate.avatar);
      if (key && (avatarList.indexOf(key) !== -1 || avatarList.indexOf(fnv1a(key)) !== -1)) {
        hits.push('avatar');
        score += settings.weights.avatar;
      }
    }

    // 关键词规则目前默认关闭：昵称/话术字面量容易误伤普通用户。
    // 临时需要时可在面板重新打开；UID 黑名单、头像指纹、高频、模板同文不受影响。
    if (settings.keywordRulesEnabled) {
      if (candidate.uname) {
        const uname = normalizeForMatch(candidate.uname);
        for (let i = 0; i < keywordList.length; i += 1) {
          const kw = keywordList[i];
          if (kw && uname.indexOf(kw) !== -1) {
            hits.push('nickname');
            score += settings.weights.nickname;
            break;
          }
        }
      }

      if (candidate.text) {
        const text = normalizeForMatch(candidate.text);
        for (let i = 0; i < compiledPatterns.length; i += 1) {
          if (compiledPatterns[i].test(text)) {
            hits.push('phrase');
            score += settings.weights.phrase;
            break;
          }
        }
      }
    }

    // 去重键：同一个评论在 SPA 重渲染后不要重复计入高频
    const dedupeKey =
      (candidate.mid || 'anon') +
      '|' +
      (candidate.rpid || fnv1a(normalizeForMatch(candidate.text || '')));
    const firstSeen = !seenTracker.has(dedupeKey);
    if (firstSeen) seenTracker.set(dedupeKey, now);

    const windowMs = Math.max(1, settings.burst.windowMinutes) * 60 * 1000;
    const postedAt = Number(candidate.postedAt) || 0;
    const hasPostedAt = postedAt > 0;
    const recentEnough =
      hasPostedAt && postedAt <= now + 5 * 60 * 1000 && now - postedAt <= windowMs;

    // 高频必须基于可解析的评论时间，避免把几年前的评论当成“刚刚刷屏”。
    if (firstSeen && candidate.mid && recentEnough) {
      const times = (burstTracker.get(candidate.mid) || []).concat(now).slice(-200);
      burstTracker.set(candidate.mid, times);
      if (times.length >= settings.burst.count) {
        hits.push('burst');
        score += settings.weights.burst;
      }
    }

    // 模板同文：有明确时间时要求是新评论；时间缺失时仍允许触发（3 个不同 UID 同文）。
    if (
      firstSeen &&
      candidate.text &&
      candidate.text.length >= 12 &&
      (recentEnough || !hasPostedAt)
    ) {
      const textKey = fnv1a(normalizeForMatch(candidate.text));
      let entry = templateTracker.get(textKey);
      if (!entry) {
        entry = { mids: Object.create(null), times: [] };
        templateTracker.set(textKey, entry);
      }
      if (candidate.mid) entry.mids[candidate.mid] = true;
      entry.times.push(now);
      if (entry.times.length > 200) entry.times = entry.times.slice(-200);
      const midKeys = Object.keys(entry.mids);
      if (midKeys.length > 500) {
        for (let i = 0; i < midKeys.length - 500; i += 1) delete entry.mids[midKeys[i]];
      }
      if (Object.keys(entry.mids).length >= 3) {
        hits.push('template');
        score += settings.weights.template;
      }
    }

    const blocked = score >= settings.threshold;
    return {
      blocked: blocked,
      score: score,
      hits: uniq(hits),
      detail: uniq(hits).join('+')
    };
  }

  function evaluate(candidate) {
    if (!candidate) return null;
    if (!settings.enabled) return null;

    // 本地白名单优先级最高，高于远端黑名单
    if (isWhitelisted(candidate)) {
      debug('whitelist skip', candidate.mid);
      return null;
    }

    if (candidate.mid) {
      const entry = blacklistByMid.get(candidate.mid);
      if (entry) {
        return {
          block: true,
          reason: 'blacklist',
          detail: '社区黑名单',
          score: 99
        };
      }
    }

    const keywordHit = matchKeyword(candidate);
    if (keywordHit) {
      return {
        block: true,
        reason: 'keyword',
        detail:
          (keywordHit.kind === 'name' ? '昵称' : '评论') +
          '关键词：' +
          keywordHit.keyword,
        score: 99
      };
    }

    if (settings.rulesEnabled) {
      const rules = evaluateRules(candidate);
      if (rules.blocked) {
        return {
          block: true,
          reason: 'rules',
          detail: rules.detail || '规则命中',
          score: rules.score
        };
      }
    }

    return null;
  }

  /* ==========================================================================
   * 页面世界数据桥（只为读取评论 rpid / 完整原文，不发请求）
   * ========================================================================== */

  function getPageNode(el) {
    const w = pageWindow();
    if (!w || !w.document || !w.document.documentElement) return null;
    if (!el || !el.getRootNode) return null;

    try {
      const top = document.documentElement;
      const path = [];
      let node = el;
      let guard = 0;

      while (node && node !== top && guard < 40) {
        guard += 1;
        const parent = node.parentNode;
        if (!parent) return null;
        if (parent.nodeType === 11 && parent.host) {
          path.unshift({ shadow: true });
          node = parent.host;
          continue;
        }
        if (parent.nodeType === 1) {
          const idx = Array.prototype.indexOf.call(parent.children, node);
          if (idx < 0) return null;
          path.unshift({ index: idx });
          node = parent;
          continue;
        }
        return null;
      }

      let current = w.document.documentElement;
      for (let i = 0; i < path.length; i += 1) {
        const step = path[i];
        if (!current) return null;
        if (step.shadow) {
          current = current.shadowRoot;
        } else {
          current = current.children[step.index];
        }
      }
      return current || null;
    } catch (err) {
      debug('page node bridge failed', err && err.message);
      return null;
    }
  }

  function readPageData(el) {
    try {
      if (el && el.__data) {
        const direct = extractDataFromPageObject(el.__data);
        if (direct) return direct;
      }
    } catch (_) {
      /* ignore */
    }

    const pageEl = getPageNode(el);
    if (!pageEl) return null;

    let node = pageEl;
    for (let i = 0; i < 6 && node; i += 1) {
      try {
        if (node.__data) {
          const data = extractDataFromPageObject(node.__data);
          if (data) return data;
        }
      } catch (_) {
        /* ignore */
      }
      if (node.parentNode) node = node.parentNode;
      else if (node.host) node = node.host;
      else break;
    }
    return null;
  }

  function extractDataFromPageObject(data) {
    if (!data || typeof data !== 'object') return null;
    const rpid = digitsOnly(data.rpid_str || data.rpid);
    const mid = digitsOnly(data.mid_str || data.mid);
    if (!rpid && !mid) return null;
    const text =
      data.content && typeof data.content.message === 'string' ? data.content.message : '';
    const uname = data.member && typeof data.member.uname === 'string' ? data.member.uname : '';
    return {
      rpid: rpid,
      mid: mid,
      text: text,
      uname: uname,
      oid: digitsOnly(data.oid_str || data.oid)
    };
  }

  /* ==========================================================================
   * DOM 抓取
   * ========================================================================== */

  function textOf(el) {
    if (!el) return '';
    let s = '';
    try {
      s = typeof el.innerText === 'string' ? el.innerText : '';
    } catch (_) {
      s = '';
    }
    if (!s) {
      try {
        s = el.textContent || '';
      } catch (_) {
        s = '';
      }
    }
    return cleanText(s, LIMITS.maxText, true);
  }

  function attrOf(el, name) {
    if (!el || !el.getAttribute) return '';
    return cleanText(el.getAttribute(name) || '', 200, false);
  }

  function deepQuery(root, selector, maxDepth) {
    if (!root || !selector) return null;
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch (_) {
      return null;
    }
    if (!root.querySelectorAll) return null;
    const depth = maxDepth == null ? 3 : maxDepth;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (el.shadowRoot && depth > 0) {
        const found = deepQuery(el.shadowRoot, selector, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }

  function hostParams(el) {
    let node = el;
    let guard = 0;
    while (node && guard < 20) {
      guard += 1;
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === 'bili-comments') {
        const params = attrOf(node, 'data-params');
        const parts = params.split(',');
        return { oid: digitsOnly(parts[1]), type: digitsOnly(parts[0]) };
      }
      if (node.host) {
        node = node.host;
        continue;
      }
      node = node.parentNode;
    }
    return { oid: '', type: '' };
  }

  function extractNew(el) {
    const shadow = el.shadowRoot;
    if (!shadow) return null;

    const avatarA = shadow.querySelector('#user-avatar');
    let avatarImg = null;
    if (avatarA) {
      avatarImg =
        avatarA.querySelector('img') ||
        (avatarA.shadowRoot && avatarA.shadowRoot.querySelector('img')) ||
        deepQuery(avatarA, 'img', 2);
    }
    if (!avatarImg) avatarImg = deepQuery(shadow, '#user-avatar img', 2) || shadow.querySelector('img');
    const avatar = avatarImg ? cleanText(avatarImg.getAttribute('src') || '', 500, false) : '';

    const userInfo = shadow.querySelector('bili-comment-user-info');
    const unameEl =
      (userInfo && userInfo.shadowRoot && userInfo.shadowRoot.querySelector('#user-name a')) ||
      (userInfo && userInfo.shadowRoot && userInfo.shadowRoot.querySelector('#user-name')) ||
      shadow.querySelector('#user-name a') ||
      shadow.querySelector('#user-name');

    const rich = shadow.querySelector('bili-rich-text');
    const contentEl =
      (rich && rich.shadowRoot && rich.shadowRoot.querySelector('#contents')) ||
      (rich && rich.querySelector('#contents')) ||
      shadow.querySelector('#contents');

    const actions = shadow.querySelector('bili-comment-action-buttons-renderer');
    const pubdate =
      actions && actions.shadowRoot ? actions.shadowRoot.querySelector('#pubdate') : null;

    let mid =
      (avatarA && attrOf(avatarA, 'data-user-profile-id')) ||
      (unameEl && unameEl.closest ? attrOf(unameEl.closest('[data-user-profile-id]'), 'data-user-profile-id') : '') ||
      attrOf(shadow.querySelector('[data-user-profile-id]'), 'data-user-profile-id');
    if (!mid) {
      const spaceLink = shadow.querySelector('a[href*="space.bilibili.com/"]');
      const m = spaceLink
        ? (spaceLink.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/)
        : null;
      if (m) mid = m[1];
    }
    const text = contentEl ? textOf(contentEl) : '';
    const uname = unameEl ? cleanText(textOf(unameEl), 80, false) : '';
    const time = pubdate ? cleanText(textOf(pubdate), 40, false) : '';

    if (!mid && !text && !uname) return null;

    const params = hostParams(el);
    return {
      mid: digitsOnly(mid),
      rpid: '',
      uname: uname,
      text: text,
      avatar: avatar,
      time: time,
      postedAt: parsePostedAt(time),
      oid: params.oid,
      type: params.type
    };
  }

  function extractLegacy(el) {
    const midAttr =
      attrOf(el, 'data-mid') ||
      attrOf(el, 'data-user-id') ||
      attrOf(el, 'data-uid') ||
      attrOf(el.querySelector('[data-mid]'), 'data-mid');

    let mid = digitsOnly(midAttr);
    if (!mid) {
      const link = el.querySelector('a[href*="space.bilibili.com/"]');
      const m = link ? (link.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) : null;
      if (m) mid = m[1];
    }

    const rpid =
      digitsOnly(attrOf(el, 'data-id')) ||
      digitsOnly(attrOf(el, 'data-rpid')) ||
      digitsOnly(attrOf(el, 'data-comment-id'));

    const unameEl = el.querySelector(SELECTORS.legacyName);
    const contentEl = el.querySelector(SELECTORS.legacyContent);
    const avatarImg = el.querySelector(SELECTORS.legacyAvatar);

    const text = contentEl ? textOf(contentEl) : '';
    const uname = unameEl ? cleanText(textOf(unameEl), 80, false) : '';
    const avatar = avatarImg ? cleanText(avatarImg.getAttribute('src') || '', 500, false) : '';
    const timeEl = el.querySelector('.reply-time, .sub-reply-time, .comment-time, .time');
    const time = timeEl ? cleanText(textOf(timeEl), 40, false) : '';

    if (!mid && !text) return null;

    const params = hostParams(el);
    return {
      mid: mid,
      rpid: rpid,
      uname: uname,
      text: text,
      avatar: avatar,
      time: time,
      postedAt: parsePostedAt(time),
      oid: params.oid,
      type: params.type
    };
  }

  /* ==========================================================================
   * 隐藏 / 恢复
   * ========================================================================== */

  function getHideTargets(candidate) {
    const el = candidate.el;
    if (!el) return [];
    if (candidate.kind === 'legacy-root') {
      return [el.querySelector('.root-reply-container') || el];
    }
    if (candidate.kind === 'new-root') {
      // 新版评论中，根评论与它的楼中楼在同一个 thread 容器里。
      // 命中根评论时整楼隐藏，避免留下没有父评论的孤儿子回复。
      let node = el;
      let guard = 0;
      while (node && guard < 12) {
        guard += 1;
        if (
          node.nodeType === 1 &&
          node.tagName &&
          node.tagName.toLowerCase() === 'bili-comment-thread-renderer'
        ) {
          return [node];
        }
        if (node.host) node = node.host;
        else node = node.parentNode;
      }
    }
    return [el];
  }

  function bumpStat(reason) {
    const key =
      reason === 'blacklist'
        ? 'blacklist'
        : reason === 'keyword'
          ? 'keyword'
          : reason === 'model'
            ? 'model'
            : reason === 'ml'
              ? 'ml'
              : 'rules';
    state.stats.total += 1;
    state.stats[key] = (state.stats[key] || 0) + 1;
    const day = todayKey();
    state.stats.byDay[day] = (state.stats.byDay[day] || 0) + 1;
    pageStats.total += 1;
    pageStats[key] = (pageStats[key] || 0) + 1;

    const days = Object.keys(state.stats.byDay);
    if (days.length > 90) {
      days.sort();
      const keep = days.slice(days.length - 90);
      const next = {};
      for (let i = 0; i < keep.length; i += 1) next[keep[i]] = state.stats.byDay[keep[i]];
      state.stats.byDay = next;
    }
  }

  function nextLogId() {
    logSeq += 1;
    return Date.now().toString(36) + '-' + logSeq.toString(36);
  }

  function hideCandidate(candidate, decision) {
    if (!candidate || !candidate.el || !candidate.el.isConnected || candidate.hidden) return false;
    if (!settings.enabled) return false;

    const targets = getHideTargets(candidate);
    const stored = [];

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      if (!target || target.nodeType !== 1) continue;
      if (target.hasAttribute('data-pf-hidden')) continue;
      stored.push([target, target.style.display]);
      target.setAttribute('data-pf-hidden', '1');
      target.setAttribute('data-pf-reason', decision.reason);
      target.setAttribute('aria-hidden', 'true');
      target.style.setProperty('display', 'none', 'important');
    }

    if (!stored.length) return false;

    candidate.hidden = true;
    removeReportButtonFor(candidate);
    removeQueuedReportFor(candidate);
    const fp = candidate.fp || fingerprintOf(candidate);
    candidate.fp = fp;

    const record = {
      id: nextLogId(),
      ts: Date.now(),
      mid: candidate.mid || '',
      rpid: candidate.rpid || '',
      uname: candidate.uname || '',
      text: cleanText(candidate.text || '', 500, true),
      reason: decision.reason,
      detail: cleanText(decision.detail || '', 160, false),
      score: decision.score || 0,
      fp: fp,
      url: canonicalPageUrl(),
      restored: false
    };

    state.log.unshift(record);
    if (state.log.length > LIMITS.maxLog) state.log.length = LIMITS.maxLog;
    nodeMap.set(record.id, stored);
    recordCandidates.set(record.id, candidate);
    pruneNodeMap();
    bumpStat(decision.reason);
    saveState();
    if (!suppressUI) refreshUI();
    scheduleFilterRefresh();
    debug('hidden', {
      mid: record.mid,
      reason: record.reason,
      score: record.score
    });
    return true;
  }

  function pruneNodeMap() {
    const ids = new Set();
    for (let i = 0; i < state.log.length; i += 1) ids.add(state.log[i].id);
    for (const key of Array.from(nodeMap.keys())) {
      if (!ids.has(key)) nodeMap.delete(key);
    }
    for (const key of Array.from(recordCandidates.keys())) {
      if (!ids.has(key)) recordCandidates.delete(key);
    }
  }

  function unhideNodes(nodes) {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i][0];
      const previous = nodes[i][1];
      if (!node || !node.isConnected) continue;
      if (previous) node.style.display = previous;
      else node.style.removeProperty('display');
      node.removeAttribute('data-pf-hidden');
      node.removeAttribute('data-pf-reason');
      node.removeAttribute('aria-hidden');
    }
  }

  function addWhitelistEntry(entry) {
    let changed = false;
    if (entry.mid && MID_RE.test(entry.mid) && state.whitelist.mids.indexOf(entry.mid) === -1) {
      state.whitelist.mids.push(entry.mid);
      changed = true;
    }
    if (
      entry.rpid &&
      RPID_RE.test(entry.rpid) &&
      state.whitelist.rpids.indexOf(entry.rpid) === -1
    ) {
      state.whitelist.rpids.push(entry.rpid);
      changed = true;
    }
    if (
      entry.fingerprint &&
      state.whitelist.fingerprints.indexOf(entry.fingerprint) === -1
    ) {
      state.whitelist.fingerprints.push(entry.fingerprint);
      changed = true;
    }
    if (changed) {
      if (state.whitelist.mids.length > LIMITS.maxWhitelist) {
        state.whitelist.mids = state.whitelist.mids.slice(-LIMITS.maxWhitelist);
      }
      if (state.whitelist.rpids.length > LIMITS.maxWhitelist) {
        state.whitelist.rpids = state.whitelist.rpids.slice(-LIMITS.maxWhitelist);
      }
      if (state.whitelist.fingerprints.length > LIMITS.maxWhitelist) {
        state.whitelist.fingerprints = state.whitelist.fingerprints.slice(-LIMITS.maxWhitelist);
      }
      rebuildWhitelistSets();
      saveState();
    }
    return changed;
  }

  function restoreRecord(id, mode) {
    const record = state.log.find(function (r) {
      return r.id === id;
    });
    if (!record) return;

    unhideNodes(nodeMap.get(id));
    record.restored = true;
    const candidate = recordCandidates.get(id);
    if (candidate) {
      candidate.hidden = false;
      candidate.restored = true;
      injectReportButton(candidate);
    }

    if (mode === 'mid') {
      if (record.mid) addWhitelistEntry({ mid: record.mid });
    } else {
      addWhitelistEntry({ rpid: record.rpid, fingerprint: record.fp });
    }

    saveState();
    renderLog();
    renderSettings();
    refreshUI();
    scheduleFilterRefresh();
  }

  function restoreByMid(mid) {
    if (!mid) return;
    addWhitelistEntry({ mid: mid });
    let restored = 0;
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.mid !== mid || record.restored) continue;
      unhideNodes(nodeMap.get(record.id));
      record.restored = true;
      const candidate = recordCandidates.get(record.id);
      if (candidate) {
        candidate.hidden = false;
        candidate.restored = true;
        injectReportButton(candidate);
      }
      restored += 1;
    }
    scheduleFilterRefresh();
    saveState();
    renderLog();
    renderSettings();
    refreshUI();
    if (restored) setNotice('已恢复并加入白名单：UID ' + mid + '（' + restored + ' 条）。');
  }

  /* ==========================================================================
   * 上报（仅用户点击后打开 GitHub Issue 新建页）
   * ========================================================================== */

  function canonicalPageUrl() {
    try {
      const u = new URL(location.href);
      u.hash = '';
      u.search = '';
      return u.toString();
    } catch (_) {
      return location.origin + location.pathname;
    }
  }

  function commentPermalink(candidate) {
    const base = canonicalPageUrl();
    const rpid = digitsOnly(candidate && candidate.rpid);
    if (rpid) return base + '#reply' + rpid;
    return base;
  }

  function resolvePageMeta(candidate) {
    if (!candidate) return candidate;
    if (candidate.rpid && candidate.mid) return candidate;

    const data = readPageData(candidate.el);
    if (!data) return candidate;

    if (!candidate.rpid && data.rpid) candidate.rpid = data.rpid;
    if (!candidate.mid && data.mid) candidate.mid = data.mid;
    if (!candidate.text && data.text) candidate.text = cleanText(data.text, LIMITS.maxText, true);
    if (!candidate.uname && data.uname) candidate.uname = data.uname;
    if (!candidate.oid && data.oid) candidate.oid = data.oid;
    if (candidate.mid && candidate.text && !candidate.fp) candidate.fp = fingerprintOf(candidate);
    return candidate;
  }

  function buildIssueUrl(candidate) {
    const repo = normalizeRepo(settings.reportRepo);
    if (!repo) return { error: '上报仓库地址无效，请填写 owner/repo。' };

    const mid = digitsOnly(candidate.mid);
    const rpid = digitsOnly(candidate.rpid);
    const link = commentPermalink(candidate);
    const page = canonicalPageUrl();
    const uname = cleanText(candidate.uname || '', 80, false);
    const originalText = cleanText(candidate.text || '', 1800, true);

    const title =
      '[fish-report] ' +
      (mid ? 'UID ' + mid : '可疑评论') +
      (rpid ? ' / rpid ' + rpid : '');

    const metaBlock = [
      '<!-- pkillfish:meta',
      'uid: ' + mid,
      'mid: ' + mid,
      'rpid: ' + rpid,
      'oid: ' + digitsOnly(candidate.oid),
      'type: ' + digitsOnly(candidate.type),
      'link: ' + link,
      '-->'
    ].join('\n');

    function composeBody(textValue, truncatedNote) {
      return [
        metaBlock,
        '',
        '> 提交后不会自动加入黑名单。维护者审核后打 `resolved` 或关闭为 `completed` 才会加入；打 `wontfix` 或关闭为 `not planned` 表示不加入。',
        '',
        '### 可疑评论',
        '',
        '- UID: ' + (mid || '未知'),
        '- 昵称: ' + (uname || '未知'),
        '- 评论永久链接: ' + link,
        '- 页面: ' + page,
        '',
        '~~~text',
        textValue || '（未获取到评论原文，请手动粘贴）',
        '~~~',
        truncatedNote || '',
        '',
        '### 判断依据',
        '',
        '- [ ] 批量 / 模板化评论',
        '- [ ] 捏造事实、答非所问或与视频无关',
        '- [ ] 昵称、头像或话术指向 DSH / 大肥鱼 Agent',
        '',
        '### 截图',
        '',
        '> 请拖入该评论的截图（可选，但建议附上）。截图应只包含公开评论区，不要包含个人信息。',
        '',
        '### 确认',
        '',
        '- [ ] 我只提交了公开评论信息，没有提交任何账号凭据或隐私数据',
        '- [ ] 我理解该 Issue 是公开的，并同意按项目黑名单流程审核'
      ].join('\n');
    }

    // GitHub 的 Issue 新建页通过 URL 接收正文，浏览器和 GitHub 对 URL 长度都有限制。
    // 先尽量保留全文；确实超长时逐级截断，并在正文中明确提示用户手动补充。
    let textValue = originalText;
    let truncatedNote = '';
    let lastUrl = '';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const params = new URLSearchParams();
      params.set('labels', 'report');
      params.set('title', truncate(title, 140));
      params.set('body', composeBody(textValue, truncatedNote));
      lastUrl = 'https://github.com/' + repo + '/issues/new?' + params.toString();

      if (lastUrl.length <= 7200 || textValue.length <= 120) break;
      textValue = textValue.slice(0, Math.max(80, Math.floor(textValue.length * 0.65)));
      truncatedNote =
        '\n> 原文过长，受 GitHub URL 长度限制已截断。请在上报时手动补充完整原文。';
    }

    return { url: lastUrl };
  }

  function openReport(candidate) {
    const resolved = resolvePageMeta(candidate);
    const built = buildIssueUrl(resolved);
    if (built.error) {
      openPanel('settings');
      setNotice(built.error, true);
      try {
        if (ui && ui.repo) ui.repo.focus();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    debug('open report', { mid: resolved.mid, rpid: resolved.rpid });
    const ok = gmOpenTab(built.url);
    if (!ok) setNotice('浏览器拦截了新标签页，请允许弹窗后重试。', true);
  }

  function removeReportButtonFor(candidate) {
    if (!candidate) return;
    const button = candidate.reportBtn;
    if (button) {
      try {
        if (button.parentNode) button.parentNode.removeChild(button);
      } catch (_) {
        /* ignore */
      }
      reportButtons.delete(button);
    }
    try {
      reportHosts.delete(candidate.el);
    } catch (_) {
      /* ignore */
    }
    candidate.reportBtn = null;
  }

  function removeQueuedReportFor(candidate) {
    if (!candidate || !state) return;
    const key =
      candidate.mid +
      '|' +
      (digitsOnly(candidate.rpid) ||
        candidate.fp ||
        fingerprintOf(candidate));
    const before = state.reportQueue.length;
    state.reportQueue = state.reportQueue.filter(function (item) {
      return item.key !== key;
    });
    if (state.reportQueue.length !== before) {
      saveState();
      renderReportQueue();
      setQueueNotice('该评论已被自动屏蔽，已从待上报列表移除。');
    }
  }

  function injectReportButton(candidate) {
    if (!settings.reportEnabled || !candidate || !candidate.el || candidate.hidden) return;
    if (!candidate.el.isConnected) return;
    if (reportHosts.has(candidate.el)) return;

    let parent = null;

    if (candidate.kind === 'new-root' || candidate.kind === 'new-reply') {
      const actions = candidate.el.shadowRoot
        ? candidate.el.shadowRoot.querySelector('bili-comment-action-buttons-renderer')
        : null;
      const actionsShadow = actions && actions.shadowRoot;
      if (actionsShadow) {
        const more = actionsShadow.querySelector('#more');
        parent = more && more.parentNode ? more.parentNode : actionsShadow;
      }
    } else {
      parent = candidate.el.querySelector(SELECTORS.legacyInfo) || candidate.el;
    }

    if (!parent) {
      const attempts = injectionRetry.get(candidate.el) || 0;
      if (attempts < 3) {
        injectionRetry.set(candidate.el, attempts + 1);
        setTimeout(function () {
          if (active && candidate.el && candidate.el.isConnected) injectReportButton(candidate);
        }, 700);
      }
      return;
    }

    try {
      if (parent.querySelector && parent.querySelector('[data-pf-report]')) {
        reportHosts.add(candidate.el);
        return;
      }
    } catch (_) {
      /* ignore */
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-pf-report', '1');
    button.textContent = '上报可疑鱼';
    button.title = '加入左下角待上报面板，稍后批量提交';
    button.style.cssText =
      'all:unset;display:inline-block;cursor:pointer;color:#8a8a8a;font-size:12px;' +
      'line-height:1.6;margin-left:8px;font-family:inherit;';

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      enqueueReport(candidate);
    });

    parent.appendChild(button);
    reportButtons.add(button);
    reportHosts.add(candidate.el);
    candidate.reportBtn = button;
  }

  function injectAllReportButtons() {
    if (!settings.reportEnabled) return;
    for (const candidate of candidates) {
      if (candidate && candidate.el && candidate.el.isConnected && !candidate.hidden) {
        injectReportButton(candidate);
      }
    }
  }

  function removeReportButtons() {
    for (const button of reportButtons) {
      try {
        if (button.parentNode) button.parentNode.removeChild(button);
      } catch (_) {
        /* ignore */
      }
    }
    reportButtons = new Set();
    reportHosts = new WeakSet();
    for (const candidate of candidates) candidate.reportBtn = null;
  }

  /* ==========================================================================
   * 候选处理
   * ========================================================================== */

  function registerCandidate(candidate) {
    candidate.fp = candidate.fp || fingerprintOf(candidate);
    candidates.add(candidate);
    candidateList.push(candidate);
    if (candidateList.length > LIMITS.maxCandidates) {
      const old = candidateList.shift();
      candidates.delete(old);
    }
    if (!settings.enabled) {
      injectReportButton(candidate);
      scheduleFilterRefresh();
      return;
    }

    const decision = evaluate(candidate);
    if (decision && decision.block) {
      // 自动屏蔽的评论不提供上报按钮，也不进入待上报队列。
      hideCandidate(candidate, decision);
      scheduleFilterRefresh();
      return;
    }

    injectReportButton(candidate);
    scheduleFilterRefresh();
    if (mlModel) mlApplyCandidate(candidate);
    if (settings.enableLocalModel) queueModel(candidate);
  }

  function processNew(el, kind) {
    if (!el || !el.isConnected || processed.has(el)) return;
    try {
      const data = extractNew(el);
      if (!data) {
        retryLater(el, kind);
        return;
      }
      if (!data.mid && !data.text && !data.uname) {
        retryLater(el, kind);
        return;
      }

      const candidate = {
        el: el,
        kind: kind,
        mid: data.mid,
        rpid: data.rpid,
        uname: data.uname,
        text: data.text,
        avatar: data.avatar,
        postedAt: data.postedAt || 0,
        oid: data.oid,
        type: data.type,
        pageUrl: canonicalPageUrl(),
        hidden: false,
        fp: '',
        modelPending: false
      };

      processed.add(el);
      registerCandidate(candidate);
    } catch (err) {
      debug('processNew failed', err && err.message);
    }
  }

  function processLegacy(el) {
    if (!el || !el.isConnected || processed.has(el)) return;
    try {
      const data = extractLegacy(el);
      if (!data) {
        retryLater(el, 'legacy');
        return;
      }

      let kind = 'legacy';
      if (el.matches('.sub-reply-item')) kind = 'legacy-sub';
      else if (el.matches('.reply-item')) kind = 'legacy-root';

      const candidate = {
        el: el,
        kind: kind,
        mid: data.mid,
        rpid: data.rpid,
        uname: data.uname,
        text: data.text,
        avatar: data.avatar,
        postedAt: data.postedAt || 0,
        oid: data.oid,
        type: data.type,
        pageUrl: canonicalPageUrl(),
        hidden: false,
        fp: '',
        modelPending: false
      };

      processed.add(el);
      registerCandidate(candidate);
    } catch (err) {
      debug('processLegacy failed', err && err.message);
    }
  }

  function retryLater(el, kind) {
    const attempts = retryCount.get(el) || 0;
    if (attempts >= LIMITS.maxRetry) return;
    retryCount.set(el, attempts + 1);
    setTimeout(
      function () {
        if (!active || !el || !el.isConnected) return;
        if (kind === 'new-root' || kind === 'new-reply') processNew(el, kind);
        else processLegacy(el);
      },
      450 + attempts * 450
    );
  }

  function resetRuleTrackers() {
    burstTracker = new Map();
    templateTracker = new Map();
    seenTracker = new Map();
  }

  function rescanCandidates() {
    if (!settings.enabled) return;
    resetRuleTrackers();
    suppressUI = true;
    try {
      for (const candidate of candidates) {
        if (!candidate || !candidate.el || !candidate.el.isConnected || candidate.hidden) continue;
        if (isWhitelisted(candidate)) continue;
        const decision = evaluate(candidate);
        if (decision && decision.block) {
          hideCandidate(candidate, decision);
        } else {
          if (mlModel) mlApplyCandidate(candidate);
          if (settings.enableLocalModel && !candidate.modelPending) queueModel(candidate);
        }
      }
    } finally {
      suppressUI = false;
      saveState();
      refreshUI();
      if (currentTab === 'log') renderLog();
      scheduleFilterRefresh();
    }
  }

  /* ==========================================================================
   * 本地轻量模型钩子（可选，默认关闭；脚本自身不发起任何模型请求）
   * ========================================================================== */

  const classifiers = [];

  function registerClassifier(fn) {
    if (typeof fn !== 'function' || classifiers.length >= 20) return false;
    classifiers.push(fn);
    debug('classifier registered', classifiers.length);
    return true;
  }

  function queueModel(candidate) {
    if (!candidate || candidate.hidden || candidate.modelPending) return;
    if (!settings.enableLocalModel || !classifiers.length) return;
    candidate.modelPending = true;

    const context = {
      mid: candidate.mid,
      uname: candidate.uname,
      text: candidate.text,
      avatar: candidate.avatar,
      rpid: candidate.rpid,
      pageUrl: candidate.pageUrl
    };

    let finished = false;
    const timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      candidate.modelPending = false;
      debug('classifier timeout', candidate.mid);
    }, settings.modelTimeoutMs);

    const chain = Promise.resolve();
    let pending = chain.then(function () {
      let index = 0;
      function next() {
        if (index >= classifiers.length) return null;
        const fn = classifiers[index];
        index += 1;
        return Promise.resolve()
          .then(function () {
            return fn(context);
          })
          .then(function (result) {
            if (result === true) return { block: true, reason: 'local-classifier' };
            if (result && typeof result === 'object' && result.block === true) {
              return {
                block: true,
                reason: cleanText(result.reason || 'local-classifier', 80, false)
              };
            }
            return next();
          });
      }
      return next();
    });

    pending
      .then(function (result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        candidate.modelPending = false;
        if (
          result &&
          result.block === true &&
          settings.enabled &&
          settings.enableLocalModel &&
          !candidate.hidden &&
          candidate.el &&
          candidate.el.isConnected &&
          !isWhitelisted(candidate)
        ) {
          hideCandidate(candidate, {
            block: true,
            reason: 'model',
            detail: result.reason || '本地模型钩子',
            score: 99
          });
        }
      })
      .catch(function (err) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        candidate.modelPending = false;
        debug('classifier failed', err && err.message);
      });
  }

  /* ==========================================================================
   * MutationObserver 与扫描
   * ========================================================================== */

  function isInteresting(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (node.id === 'pkillfish-root') return false;
      if (node.matches && node.matches(SELECTORS.newHost)) return true;
      if (node.matches && node.matches(SELECTORS.newThread)) return true;
      if (node.matches && node.matches(SELECTORS.newComment)) return true;
      if (node.matches && node.matches(SELECTORS.newReply)) return true;
      if (node.matches && node.matches(SELECTORS.newReplies)) return true;
      if (node.matches && node.matches(SELECTORS.legacyItem)) return true;
      if (node.tagName && node.tagName.indexOf('BILI-') === 0) return true;
      if (!node.childElementCount) return false;
      if (node.querySelector && node.querySelector(SELECTORS.newHost)) return true;
      if (node.querySelector && node.querySelector(SELECTORS.newComment)) return true;
      if (node.querySelector && node.querySelector(SELECTORS.legacyItem)) return true;
    } catch (_) {
      return false;
    }
    return false;
  }

  function queueScan(node) {
    if (!node) return;
    pendingRoots.add(node);
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      runScan();
    }, 120);
  }

  function runScan() {
    if (!active) return;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    for (let i = 0; i < roots.length; i += 1) {
      try {
        scanRoot(roots[i]);
      } catch (err) {
        debug('scan failed', err && err.message);
      }
    }
  }

  function scanRoot(root) {
    if (!root || !active) return;
    if (root.nodeType === 9) {
      scanDocument();
      return;
    }
    if (root.nodeType === 1) {
      if (root.id === 'pkillfish-root') return;
      try {
        if (root.closest && root.closest('#pkillfish-root')) return;
      } catch (_) {
        /* ignore */
      }
      if (root.matches && root.matches(SELECTORS.legacyItem)) processLegacy(root);
      scanLegacyIn(root);
      scanNode(root, 0);
      return;
    }
    if (root.nodeType === 11 || root.nodeType === 10) {
      scanChildren(root, 0);
    }
  }

  function scanDocument() {
    try {
      const hosts = document.querySelectorAll(SELECTORS.newHost);
      for (let i = 0; i < hosts.length; i += 1) scanNode(hosts[i], 0);
    } catch (_) {
      /* ignore */
    }

    try {
      const loose = document.querySelectorAll(
        'bili-comment-renderer, bili-comment-reply-renderer'
      );
      for (let i = 0; i < loose.length; i += 1) {
        const tag = loose[i].tagName.toLowerCase();
        processNew(loose[i], tag === SELECTORS.newReply ? 'new-reply' : 'new-root');
      }
    } catch (_) {
      /* ignore */
    }

    scanLegacyIn(document);
  }

  const SKIP_TAGS = {
    script: true,
    style: true,
    noscript: true,
    template: true,
    svg: true,
    path: true,
    img: true,
    video: true,
    audio: true,
    iframe: true
  };

  const SKIP_BILI_TAGS = {
    'bili-avatar': true,
    'bili-icon': true,
    'bili-text-button': true,
    'bili-rich-text': true,
    'bili-comment-user-info': true,
    'bili-comment-action-buttons-renderer': true,
    'bili-comment-menu': true,
    'bili-comment-user-sailing-card': true,
    'bili-comments-header-renderer': true,
    'bili-comment-box': true,
    'bili-comment-textarea': true,
    'bili-checkbox': true
  };

  function scanChildren(parent, depth) {
    if (!parent || depth > 24) return;
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) scanNode(children[i], depth + 1);
  }

  const deferredScans = new WeakMap();

  function scheduleNodeRescan(node, depth, delay) {
    if (!node || !active) return;
    const count = deferredScans.get(node) || 0;
    if (count >= 3) return;
    deferredScans.set(node, count + 1);
    setTimeout(function () {
      if (!active || !node.isConnected) return;
      // 重新走完整的 scanNode：既补扫 shadow 内容，也补挂 feed observer 和筛选按钮。
      // 只在 scanChildren 上补扫会漏掉“host 先插入、shadowRoot 后创建”的情况。
      scanNode(node, depth);
    }, delay);
  }

  function scanNode(node, depth) {
    if (!node || node.nodeType !== 1 || depth > 24) return;
    if (node.id === 'pkillfish-root') return;

    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (SKIP_TAGS[tag]) return;

    if (tag === SELECTORS.newComment) {
      processNew(node, 'new-root');
      return;
    }
    if (tag === SELECTORS.newReply) {
      processNew(node, 'new-reply');
      return;
    }
    if (tag === SELECTORS.newThread) {
      if (node.shadowRoot) {
        scanChildren(node.shadowRoot, depth + 1);
        if (!node.shadowRoot.querySelector(SELECTORS.newComment)) {
          scheduleNodeRescan(node, depth, 600);
        }
      } else {
        scheduleNodeRescan(node, depth, 500);
      }
      return;
    }
    if (tag === SELECTORS.newHost) {
      if (node.shadowRoot) {
        observeShadow(node.shadowRoot);
        try { ensureFilterButton(node); } catch (e) { debug('ensure error', e && e.message); }
        scanChildren(node.shadowRoot, depth + 1);
      } else {
        scheduleNodeRescan(node, depth, 500);
      }
      return;
    }
    if (tag === SELECTORS.newReplies) {
      if (node.shadowRoot) {
        observeShadow(node.shadowRoot);
        scanChildren(node.shadowRoot, depth + 1);
      } else {
        scheduleNodeRescan(node, depth, 500);
      }
      return;
    }
    if (tag === 'bili-comments-header-renderer') {
      ensureFilterButtonForHeader(node);
      return;
    }
    if (SKIP_BILI_TAGS[tag]) return;
    if (tag.indexOf('bili-') === 0) {
      // 未知的 B 站自定义元素可能是新版包装层，保守地向下探测一层，
      // 已知的叶子组件已在 SKIP_BILI_TAGS 中跳过。
      if (node.shadowRoot && depth < 8) scanChildren(node.shadowRoot, depth + 1);
      else if (!node.shadowRoot) scheduleNodeRescan(node, depth, 600);
      scanChildren(node, depth + 1);
      return;
    }

    scanChildren(node, depth + 1);
  }

  function observeShadow(root) {
    if (!root || shadowObservers.has(root)) return;
    if (shadowObservers.size >= LIMITS.maxShadowObservers) return;
    try {
      const observer = new MutationObserver(onMutations);
      observer.observe(root, { childList: true, subtree: true });
      shadowObservers.set(root, observer);
    } catch (err) {
      debug('shadow observe failed', err && err.message);
    }
  }

  function onMutations(mutations) {
    try {
      let interesting = false;
      for (let i = 0; i < mutations.length; i += 1) {
        const mutation = mutations[i];
        if (mutation.type !== 'childList') continue;
        const added = mutation.addedNodes;
        for (let j = 0; j < added.length; j += 1) {
          const node = added[j];
          if (node && node.nodeType === 1 && isInteresting(node)) {
            queueScan(node);
            interesting = true;
          }
        }
      }
      // 只在真的新增了评论结构时刷新筛选视图；
      // 避免筛选提示条的插入/移除再次触发自己。
      if (fishFilterActive && interesting) scheduleFilterRefresh();
    } catch (err) {
      debug('mutation handling failed', err && err.message);
    }
  }

  function scanLegacyIn(root) {
    if (!root || !root.querySelectorAll) return;
    let items;
    try {
      items = root.querySelectorAll(SELECTORS.legacyItem);
    } catch (_) {
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      const el = items[i];
      try {
        if (el.closest && el.closest('#pkillfish-root')) continue;
        // [data-mid] 可能落在已处理的条目的子节点上，避免重复
        if (el.matches('[data-mid]')) {
          const owner = el.closest('.reply-item, .sub-reply-item, .comment-item');
          if (owner && owner !== el) continue;
        }
        if (el.matches('[data-comment-id]')) {
          const owner = el.closest('.reply-item, .sub-reply-item, .comment-item');
          if (owner && owner !== el) continue;
        }
        processLegacy(el);
      } catch (err) {
        debug('legacy item failed', err && err.message);
      }
    }
  }

  function startDocumentObserver() {
    if (docObserver) return;
    if (!document.documentElement) return;
    docObserver = new MutationObserver(onMutations);
    docObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObservers() {
    if (docObserver) {
      try {
        docObserver.disconnect();
      } catch (_) {
        /* ignore */
      }
      docObserver = null;
    }
    for (const observer of shadowObservers.values()) {
      try {
        observer.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    shadowObservers = new Map();
    pendingRoots.clear();
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  /* ==========================================================================
   * “已屏蔽肥鱼”评论筛选视图
   *
   * 只在用户点击按钮时启用，不改变正常评论区的规则：
   *   - 普通模式：根评论命中隐藏整楼；楼中楼命中只隐藏该条回复，父评论和其他回复保持可见。
   *   - 筛选模式：只显示本页有屏蔽记录的楼；楼中楼命中时把父评论一起显示。
   *   - 退出筛选：按日志记录恢复普通模式的隐藏状态，不新增统计或日志。
   * ========================================================================== */

  function closestComposedTag(node, tagName) {
    let current = node;
    let guard = 0;
    while (current && guard < 30) {
      guard += 1;
      if (
        current.nodeType === 1 &&
        current.tagName &&
        current.tagName.toLowerCase() === tagName
      ) {
        return current;
      }
      if (current.host) current = current.host;
      else current = current.parentNode;
    }
    return null;
  }

  function getThreadForNode(node) {
    return closestComposedTag(node, SELECTORS.newThread);
  }

  function getFilterFeed() {
    if (filterHost && filterHost.isConnected && filterHost.shadowRoot) {
      const feed = filterHost.shadowRoot.querySelector('#feed');
      if (feed) return feed;
    }
    try {
      const hosts = document.querySelectorAll(SELECTORS.newHost);
      for (let i = 0; i < hosts.length; i += 1) {
        const feed =
          hosts[i].shadowRoot && hosts[i].shadowRoot.querySelector('#feed');
        if (feed) {
          filterHost = hosts[i];
          return feed;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function ensureFilterButtonForHeader(header) {
    let node = header;
    let guard = 0;
    while (node && guard < 20) {
      guard += 1;
      if (
        node.nodeType === 1 &&
        node.tagName &&
        node.tagName.toLowerCase() === SELECTORS.newHost
      ) {
        ensureFilterButton(node);
        return;
      }
      if (node.host) node = node.host;
      else node = node.parentNode;
    }
  }

  function retryFilterHeader(host) {
    if (!host || !host.isConnected) return;
    const attempts = filterHeaderRetry.get(host) || 0;
    if (attempts >= 6) return;
    filterHeaderRetry.set(host, attempts + 1);
    setTimeout(function () {
      if (active && host.isConnected) ensureFilterButton(host);
    }, 400 + attempts * 400);
  }

  function ensureFilterButton(host) {
    if (!host || !host.shadowRoot) return false;
    filterHost = host;

    const header = host.shadowRoot.querySelector('bili-comments-header-renderer');
    if (!header || !header.shadowRoot) {
      retryFilterHeader(host);
      return false;
    }
    const headerShadow = header.shadowRoot;

    if (!filterHeaderObservers.has(headerShadow)) {
      filterHeaderObservers.add(headerShadow);
      try {
        new MutationObserver(function () {
          ensureFilterButton(host);
        }).observe(headerShadow, { childList: true, subtree: true });
      } catch (_) {
        /* ignore */
      }
    }

    // 事件委托：即使 B 站重建/克隆了 header 内部节点，按钮仍然可点击。
    // 放在 capture 阶段，先于 B 站自己的排序点击处理，避免点“已屏蔽肥鱼”被当成排序。
    if (!filterHeaderClickBound.has(headerShadow)) {
      filterHeaderClickBound.add(headerShadow);
      headerShadow.addEventListener(
        'click',
        function (event) {
          const target = event.target;
          if (!target || !target.closest) return;
          const button = target.closest('[data-pf-filter-button]');
          if (!button) return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
          }
          toggleFishFilter();
        },
        true
      );
    }

    // 筛选状态下点击“最热/最新”应当直接退出筛选，并把点击继续交给 B 站排序。
    if (!filterSortExitBound.has(headerShadow)) {
      filterSortExitBound.add(headerShadow);
      headerShadow.addEventListener(
        'click',
        function (event) {
          if (!fishFilterActive) return;
          const path =
            typeof event.composedPath === 'function' ? event.composedPath() : [];
          let inSort = false;
          let onFilterButton = false;
          for (let i = 0; i < path.length; i += 1) {
            const node = path[i];
            if (!node || node.nodeType !== 1) continue;
            if (node.id === 'sort-actions') inSort = true;
            if (
              node.matches &&
              node.matches('[data-pf-filter-button]')
            ) {
              onFilterButton = true;
            }
          }
          if (!inSort || onFilterButton) return;
          exitFishFilter();
        },
        true
      );
    }

    const existing = headerShadow.querySelector('[data-pf-filter-button]');
    if (existing) {
      filterButton = existing;
      updateFilterButton();
      if (fishFilterActive) relaxFilterMasks();
      return true;
    }

    const sortActions =
      headerShadow.querySelector('#sort-actions') || headerShadow.querySelector('#navbar');
    if (!sortActions) {
      retryFilterHeader(host);
      return false;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-pf-filter-button', '1');
    button.textContent = '已屏蔽肥鱼';
    button.title = '显示已被屏蔽的评论；楼中楼会带出父评论';
    button.setAttribute('aria-pressed', 'false');
    button.style.cssText =
      'all:unset;cursor:pointer;color:inherit;font:inherit;font-size:13px;' +
      'line-height:20px;padding:0 0 0 10px;margin-left:2px;' +
      'border-left:1px solid rgba(128,128,128,0.25);white-space:nowrap;' +
      'position:relative;z-index:5;pointer-events:auto;';
    sortActions.appendChild(button);
    filterButton = button;
    updateFilterButton();
    if (fishFilterActive) relaxFilterMasks();
    return true;
  }

  function relaxFilterMasks() {
    if (!filterHost || !filterHost.shadowRoot) return;
    const header = filterHost.shadowRoot.querySelector('bili-comments-header-renderer');
    const roots = [filterHost.shadowRoot];
    if (header && header.shadowRoot) roots.push(header.shadowRoot);

    for (let r = 0; r < roots.length; r += 1) {
      let masks;
      try {
        masks = roots[r].querySelectorAll('[id^="limit-mask"]');
      } catch (_) {
        masks = [];
      }
      for (let i = 0; i < masks.length; i += 1) {
        const mask = masks[i];
        if (!mask) continue;
        if (!filterMasks.has(mask)) {
          filterMasks.set(mask, mask.style.pointerEvents || '');
        }
        mask.style.pointerEvents = 'none';
      }
    }
  }

  function restoreFilterMasks() {
    for (const [mask, previous] of filterMasks) {
      if (!mask || !mask.isConnected) continue;
      if (previous) mask.style.pointerEvents = previous;
      else mask.style.removeProperty('pointer-events');
    }
    filterMasks = new Map();
  }

  function countConnectedBlockedRecords() {
    let count = 0;
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.restored) continue;
      const nodes = nodeMap.get(record.id);
      if (!nodes) continue;
      for (let j = 0; j < nodes.length; j += 1) {
        if (nodes[j][0] && nodes[j][0].isConnected) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  function updateFilterButton() {
    if (!filterButton || !filterButton.isConnected) {
      filterButton = null;
      return;
    }
    if (filterButton.textContent !== '已屏蔽肥鱼') {
      filterButton.textContent = '已屏蔽肥鱼';
    }
    filterButton.style.opacity = fishFilterActive ? '1' : '0.72';
    filterButton.style.fontWeight = fishFilterActive ? '600' : '400';
    filterButton.style.textDecoration = fishFilterActive ? 'underline' : 'none';
    filterButton.setAttribute('aria-pressed', fishFilterActive ? 'true' : 'false');
    filterButton.title =
      '显示已被屏蔽的评论（本页 ' +
      countConnectedBlockedRecords() +
      ' 条）；楼中楼会带出父评论';
  }

  function filterHide(node) {
    if (!node || !node.isConnected) return;
    if (node === filterNoticeEl) return;
    if (filterHiddenNodes.has(node)) return;
    const previous = node.style.display;
    filterHiddenNodes.set(node, previous);
    node.setAttribute('data-pf-filter-hidden', '1');
    node.style.setProperty('display', 'none', 'important');
  }

  function filterShow(node) {
    if (!node || !node.isConnected) return;
    if (filterHiddenNodes.has(node)) {
      const previous = filterHiddenNodes.get(node);
      if (previous) node.style.display = previous;
      else node.style.removeProperty('display');
      filterHiddenNodes.delete(node);
    }
    node.removeAttribute('data-pf-filter-hidden');
  }

  function clearFilterHides() {
    for (const [node, previous] of filterHiddenNodes) {
      if (!node || !node.isConnected) continue;
      if (previous) node.style.display = previous;
      else node.style.removeProperty('display');
      node.removeAttribute('data-pf-filter-hidden');
    }
    filterHiddenNodes = new Map();
  }

  function clearNormalHidesForFilter() {
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.restored) continue;
      unhideNodes(nodeMap.get(record.id));
    }
  }

  function restoreNormalHidesFromRecords() {
    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.restored) continue;
      const nodes = nodeMap.get(record.id);
      if (!nodes) continue;
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j][0];
        if (!node || !node.isConnected) continue;
        node.removeAttribute('data-pf-filter-hidden');
        node.setAttribute('data-pf-hidden', '1');
        node.setAttribute('data-pf-reason', record.reason || 'rules');
        node.setAttribute('aria-hidden', 'true');
        node.style.setProperty('display', 'none', 'important');
      }
    }
  }

  function collectFilterGroups() {
    const groups = new Map();
    const standalone = new Set();

    for (let i = 0; i < state.log.length; i += 1) {
      const record = state.log[i];
      if (record.restored) continue;
      const nodes = nodeMap.get(record.id);
      if (!nodes || !nodes.length) continue;

      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j][0];
        if (!node || !node.isConnected) continue;

        const thread = getThreadForNode(node);
        if (thread) {
          let group = groups.get(thread);
          if (!group) {
            group = {
              thread: thread,
              rootBlocked: false,
              replies: new Set(),
              records: new Set(),
              count: 0,
              legacy: false
            };
            groups.set(thread, group);
          }
          group.records.add(record.id);
          group.count = group.records.size;

          const tag = node.tagName ? node.tagName.toLowerCase() : '';
          if (node === thread || tag === SELECTORS.newComment || tag === SELECTORS.newThread) {
            group.rootBlocked = true;
          } else {
            const reply = closestComposedTag(node, SELECTORS.newReply);
            if (reply) group.replies.add(reply);
            else group.rootBlocked = true;
          }
          continue;
        }

        const owner =
          node.closest && node.closest('.reply-item, .comment-item')
            ? node.closest('.reply-item, .comment-item')
            : null;

        if (owner) {
          let group = groups.get(owner);
          if (!group) {
            group = {
              thread: owner,
              rootBlocked: false,
              replies: new Set(),
              records: new Set(),
              count: 0,
              legacy: true
            };
            groups.set(owner, group);
          }
          group.records.add(record.id);
          group.count = group.records.size;
          const sub = node.closest ? node.closest('.sub-reply-item') : null;
          if (sub) group.replies.add(sub);
          else group.rootBlocked = true;
        } else {
          standalone.add(node);
        }
      }
    }

    return { groups: groups, standalone: standalone };
  }

  function showThreadRoot(thread) {
    if (!thread || !thread.shadowRoot) return;
    const roots = thread.shadowRoot.querySelectorAll(SELECTORS.newComment);
    for (let i = 0; i < roots.length; i += 1) filterShow(roots[i]);
  }

  function applyThreadReplies(thread, group) {
    if (!thread || !thread.shadowRoot) return;
    const repliesRenderer = thread.shadowRoot.querySelector(SELECTORS.newReplies);
    if (!repliesRenderer) return;

    // 根评论本身命中、且没有命中的楼中楼时，楼中楼整块都不属于筛选结果。
    if (group.rootBlocked && group.replies.size === 0) {
      filterHide(repliesRenderer);
      return;
    }
    filterShow(repliesRenderer);

    const repliesRoot = repliesRenderer.shadowRoot;
    if (!repliesRoot) return;

    const replies = repliesRoot.querySelectorAll(SELECTORS.newReply);
    for (let i = 0; i < replies.length; i += 1) {
      if (group.replies.has(replies[i])) filterShow(replies[i]);
      else filterHide(replies[i]);
    }
  }

  function removeFilterNotice() {
    if (filterNoticeEl && filterNoticeEl.parentNode) {
      filterNoticeEl.parentNode.removeChild(filterNoticeEl);
    }
    filterNoticeEl = null;
  }

  function renderFilterNotice(feed, count) {
    removeFilterNotice();
    if (!feed) return;
    const notice = document.createElement('div');
    notice.setAttribute('data-pf-filter-notice', '1');
    notice.style.cssText =
      'padding:18px 0;color:inherit;opacity:0.6;font-size:13px;' +
      'line-height:1.6;text-align:center;';
    notice.textContent = count
      ? '已屏蔽肥鱼：本页 ' + count + ' 条（仅当前已加载评论）。楼中楼会带出父评论。'
      : '已屏蔽肥鱼：本页暂无记录。';
    feed.insertBefore(notice, feed.firstChild);
    filterNoticeEl = notice;
  }

  function applyFilterView() {
    if (!active || !fishFilterActive) return;
    const feed = getFilterFeed();
    if (!feed) return;

    clearFilterHides();
    clearNormalHidesForFilter();
    relaxFilterMasks();

    const collected = collectFilterGroups();
    const groups = collected.groups;
    let visible = 0;

    const threads = feed.querySelectorAll(SELECTORS.newThread);
    for (let i = 0; i < threads.length; i += 1) {
      const thread = threads[i];
      const group = groups.get(thread);
      if (!group) {
        filterHide(thread);
        continue;
      }
      filterShow(thread);
      showThreadRoot(thread);
      applyThreadReplies(thread, group);
      visible += group.count;
    }

    for (const node of collected.standalone) {
      if (node && node.isConnected) {
        filterShow(node);
        visible += 1;
      }
    }

    renderFilterNotice(feed, visible);
    updateFilterButton();
  }

  function scheduleFilterRefresh() {
    if (!active || !fishFilterActive || filterDebounce) return;
    filterDebounce = setTimeout(function () {
      filterDebounce = null;
      if (active && fishFilterActive) applyFilterView();
    }, 60);
  }

  function toggleFishFilter() {
    if (!active) return;
    if (fishFilterActive) exitFishFilter();
    else enterFishFilter();
  }

  function enterFishFilter() {
    if (!active) return;
    fishFilterActive = true;
    updateFilterButton();
    applyFilterView();
  }

  function exitFishFilter() {
    if (!fishFilterActive) return;
    fishFilterActive = false;
    if (filterDebounce) {
      clearTimeout(filterDebounce);
      filterDebounce = null;
    }
    clearFilterHides();
    removeFilterNotice();
    restoreFilterMasks();
    restoreNormalHidesFromRecords();
    updateFilterButton();
  }

  /* ==========================================================================
   * 设置面板（白底黑字，无动画、无图标、无 emoji）
   * ========================================================================== */

  const PANEL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .pf-launcher {
      position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;
      width: 34px; height: 34px; padding: 0; border: 1px solid #b8b8b8;
      background: #fff; color: #333; border-radius: 2px;
      font: 11px/32px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-align: center; cursor: pointer;
    }
    .pf-launcher:hover { background: #f3f3f3; }
    .pf-panel {
      position: fixed; right: 14px; bottom: 56px; z-index: 2147483647;
      width: 388px; max-width: calc(100vw - 28px);
      max-height: min(74vh, 640px); background: #fff; color: #1a1a1a;
      border: 1px solid #b8b8b8; border-radius: 2px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
        "Microsoft YaHei", sans-serif;
      display: flex; flex-direction: column; text-align: left;
    }
    .pf-head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid #e3e3e3;
    }
    .pf-brand { font-weight: 600; letter-spacing: 0.2px; }
    .pf-ver { color: #888; font-size: 11px; }
    .pf-close {
      margin-left: auto; border: 0; background: transparent;
      color: #555; font: inherit; cursor: pointer; padding: 2px 4px;
    }
    .pf-tabs { display: flex; border-bottom: 1px solid #e3e3e3; }
    .pf-tab {
      flex: 1; border: 0; border-bottom: 2px solid transparent;
      background: transparent; padding: 6px 0; font: inherit;
      color: #555; cursor: pointer;
    }
    .pf-tab.active { color: #111; border-bottom-color: #333; }
    .pf-notice-bar { padding: 0 10px; }
    .pf-notice-bar .pf-note { margin: 6px 0; }
    .pf-body { padding: 10px; overflow-y: auto; overflow-x: hidden; }
    .pf-row textarea.pf-textarea { flex: 1; min-width: 0; }
    .pf-section-title {
      margin: 12px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #eee;
      font-weight: 600; color: #333;
    }
    .pf-section-title:first-child { margin-top: 0; }
    .pf-row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
    .pf-row > label:first-child { flex: 0 0 100px; color: #444; }
    .pf-row input[type="text"], .pf-row input[type="number"] {
      flex: 1; min-width: 0; border: 1px solid #cfcfcf; background: #fff;
      color: #111; padding: 3px 5px; font: inherit; border-radius: 2px;
    }
    .pf-check { display: flex; align-items: center; gap: 8px; margin: 7px 0; cursor: pointer; }
    .pf-check input { margin: 0; }
    .pf-btn {
      border: 1px solid #c6c6c6; background: #fff; color: #222;
      padding: 3px 9px; font: inherit; cursor: pointer; border-radius: 2px;
    }
    .pf-btn:hover { background: #f4f4f4; }
    .pf-btn:disabled { color: #999; border-color: #ddd; cursor: default; background: #fafafa; }
    .pf-note { color: #666; font-size: 11px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
    .pf-error { color: #8a1f1f; }
    .pf-kv {
      display: flex; justify-content: space-between; gap: 8px;
      padding: 3px 0; border-bottom: 1px dotted #eee;
    }
    .pf-kv span:last-child { text-align: right; }
    .pf-log-item { border-bottom: 1px solid #eee; padding: 7px 0; }
    .pf-log-meta { color: #666; font-size: 11px; }
    .pf-log-text {
      margin: 3px 0; white-space: pre-wrap; word-break: break-word;
      max-height: 4.6em; overflow: hidden;
    }
    .pf-log-actions { display: flex; gap: 8px; align-items: center; }
    .pf-linkbtn {
      border: 0; background: transparent; color: #555;
      text-decoration: underline; cursor: pointer; padding: 0; font: inherit;
    }
    .pf-linkbtn:disabled { color: #aaa; text-decoration: none; cursor: default; }
    textarea.pf-textarea {
      width: 100%; min-height: 64px; border: 1px solid #cfcfcf;
      padding: 4px; font: 11px/1.5 ui-monospace, Consolas, monospace;
      resize: vertical; color: #111; background: #fff; border-radius: 2px;
      max-width: 100%;
    }
    .pf-queue {
      position: fixed; left: 14px; bottom: 14px; z-index: 2147483644;
      width: 330px; max-width: calc(100vw - 28px); max-height: 46vh;
      background: #fff; color: #1a1a1a; border: 1px solid #b8b8b8;
      border-radius: 2px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
      display: flex; flex-direction: column;
      font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
        "Microsoft YaHei", sans-serif; text-align: left;
    }
    .pf-queue-head {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 9px; border-bottom: 1px solid #e3e3e3;
      font-weight: 600;
    }
    .pf-queue-head .pf-linkbtn { margin-left: auto; font-weight: 400; }
    .pf-queue-list { overflow-y: auto; overflow-x: hidden; padding: 0 9px; }
    .pf-queue-item { padding: 6px 0; border-bottom: 1px solid #eee; }
    .pf-queue-item:last-child { border-bottom: 0; }
    .pf-queue-meta { color: #555; font-size: 11px; }
    .pf-queue-text {
      margin: 2px 0; max-height: 3.2em; overflow: hidden;
      white-space: pre-wrap; word-break: break-word;
    }
    .pf-queue-actions { display: flex; gap: 8px; align-items: center; }
    .pf-queue-actions .pf-linkbtn { color: #777; }
    .pf-queue-foot {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 9px; border-top: 1px solid #eee;
    }
    .pf-queue-foot .pf-btn { margin-left: auto; }
    .pf-queue-notice { padding: 0 9px 7px; }
    .pf-foot {
      padding: 6px 10px; border-top: 1px solid #eee;
      color: #777; font-size: 11px;
    }
  `;

  const PANEL_HTML = `
    <button id="pf-launcher" class="pf-launcher" type="button"
      title="pkillFish 设置面板" aria-label="pkillFish 设置面板" hidden>pf</button>

    <section id="pf-panel" class="pf-panel" role="dialog" aria-label="pkillFish 设置面板" hidden>
      <div class="pf-head">
        <span class="pf-brand">pkillFish</span>
        <span class="pf-ver">${VERSION}</span>
        <button id="pf-close" class="pf-close" type="button">关闭</button>
      </div>

      <div class="pf-tabs">
        <button class="pf-tab active" data-tab="status" type="button">状态</button>
        <button class="pf-tab" data-tab="settings" type="button">设置</button>
        <button class="pf-tab" data-tab="log" type="button">日志</button>
      </div>
      <div class="pf-notice-bar"><span id="pf-notice" class="pf-note"></span></div>

      <div class="pf-body">
        <section data-pane="status">
          <div class="pf-kv"><span>拦截总数</span><span id="pf-st-total">0</span></div>
          <div class="pf-kv"><span>其中黑名单</span><span id="pf-st-blacklist">0</span></div>
          <div class="pf-kv"><span>其中关键词</span><span id="pf-st-keyword">0</span></div>
          <div class="pf-kv"><span>其中规则</span><span id="pf-st-rules">0</span></div>
          <div class="pf-kv"><span>其中本地模型</span><span id="pf-st-model">0</span></div>
          <div class="pf-kv"><span>其中实验模型</span><span id="pf-st-ml">0</span></div>
          <div class="pf-kv"><span>本次页面</span><span id="pf-st-page">0</span></div>
          <div class="pf-kv"><span>今日</span><span id="pf-st-today">0</span></div>
          <div class="pf-kv"><span>黑名单条目</span><span id="pf-st-blcount">0</span></div>
          <div class="pf-kv"><span>关键词条目</span><span id="pf-st-kwcount">0</span></div>
          <div class="pf-kv"><span>关键词更新时间</span><span id="pf-st-kwupdated">从未更新</span></div>
          <div class="pf-kv"><span>黑名单版本</span><span id="pf-st-version">0</span></div>
          <div class="pf-kv"><span>最后更新</span><span id="pf-st-updated">从未更新</span></div>
          <div class="pf-kv"><span>白名单</span><span id="pf-st-whitelist">0</span></div>
          <div class="pf-kv"><span>状态</span><span id="pf-st-state">就绪</span></div>
          <div class="pf-row">
            <button id="pf-update" class="pf-btn" type="button">更新黑名单</button>
            <span id="pf-update-state" class="pf-note"></span>
          </div>
          <div class="pf-note">
            屏蔽只发生在本地 DOM，不调用 B 站 API，不自动举报。离线模式下不会发起任何网络请求。
          </div>
        </section>

        <section data-pane="settings" hidden>
          <div class="pf-section-title">开关</div>
          <label class="pf-check"><input type="checkbox" id="pf-enabled"> 启用屏蔽</label>
          <label class="pf-check"><input type="checkbox" id="pf-rules"> 启用规则扫描</label>
          <label class="pf-check"><input type="checkbox" id="pf-keyword-rules"> 启用关键词规则（昵称/话术，当前默认关闭）</label>
          <label class="pf-check"><input type="checkbox" id="pf-keyword-block"> 启用独立关键词屏蔽（keywords.json）</label>
          <label class="pf-check"><input type="checkbox" id="pf-offline"> 离线模式（不拉取远端黑名单）</label>
          <label class="pf-check"><input type="checkbox" id="pf-report"> 显示“上报可疑鱼”按钮</label>
          <label class="pf-check"><input type="checkbox" id="pf-debug"> 调试日志（仅输出到控制台）</label>
          <label class="pf-check"><input type="checkbox" id="pf-model"> 启用本地轻量模型钩子</label>

          <div class="pf-section-title">实验性：本地文本模型</div>
          <label class="pf-check"><input type="checkbox" id="pf-ml-enabled"> 启用实验性模型（手动加载，不自动占内存）</label>
          <label class="pf-check"><input type="checkbox" id="pf-ml-only-badge"> 仅在名称旁标记，不隐藏</label>
          <div class="pf-row">
            <label for="pf-ml-url">模型地址</label>
            <input id="pf-ml-url" type="text" spellcheck="false" placeholder="留空使用模型仓库默认地址">
          </div>
          <div class="pf-row">
            <button id="pf-ml-load" class="pf-btn" type="button">加载本页模型</button>
            <button id="pf-ml-unload" class="pf-btn" type="button">卸载</button>
            <span id="pf-ml-state" class="pf-note">未加载</span>
          </div>
          <div class="pf-note">
            模型只在点击“加载本页模型”时请求和解析；切换页面或卸载后释放内存。关闭“仅标记”后，命中评论会折叠进“已屏蔽肥鱼”，但仍显示红色标识。
          </div>

          <div class="pf-section-title">黑名单与上报</div>
          <div class="pf-row">
            <label for="pf-repo">上报仓库</label>
            <input id="pf-repo" type="text" spellcheck="false" placeholder="owner/repo">
          </div>
          <div class="pf-note">支持 owner/repo 或 https://github.com/owner/repo。</div>
          <div class="pf-row">
            <label for="pf-bl-url">黑名单地址</label>
            <input id="pf-bl-url" type="text" spellcheck="false" placeholder="留空使用项目默认地址">
          </div>
          <div class="pf-row">
            <label for="pf-kw-url">关键词地址</label>
            <input id="pf-kw-url" type="text" spellcheck="false" placeholder="留空使用项目默认 keywords.json">
          </div>
          <div class="pf-row">
            <label for="pf-interval">更新间隔</label>
            <input id="pf-interval" type="number" min="0.25" max="720" step="0.25">
            <span class="pf-note">小时</span>
          </div>

          <div class="pf-section-title">阈值与规则</div>
          <div class="pf-row">
            <label for="pf-threshold">拦截阈值</label>
            <input id="pf-threshold" type="number" min="1" max="12" step="1">
            <span class="pf-note">加权分</span>
          </div>
          <div class="pf-row">
            <label for="pf-burst-count">高频条数</label>
            <input id="pf-burst-count" type="number" min="2" max="100" step="1">
            <span class="pf-note">条 /</span>
            <input id="pf-burst-window" type="number" min="1" max="1440" step="1" style="max-width:68px">
            <span class="pf-note">分钟</span>
          </div>
          <div class="pf-row" style="align-items:flex-start">
            <label for="pf-keywords">昵称关键词</label>
            <textarea id="pf-keywords" class="pf-textarea" spellcheck="false"></textarea>
          </div>
          <div class="pf-note">每行一个，不区分大小写；与远端规则取并集。</div>
          <div class="pf-row" style="align-items:flex-start">
            <label for="pf-patterns">固定话术</label>
            <textarea id="pf-patterns" class="pf-textarea" spellcheck="false"></textarea>
          </div>
          <div class="pf-note">每行一个正则表达式，区分大小写不敏感（iu）。留空表示不启用话术规则。</div>
          <div class="pf-row" style="align-items:flex-start">
            <label for="pf-avatars">头像指纹</label>
            <textarea id="pf-avatars" class="pf-textarea" spellcheck="false"></textarea>
          </div>
          <div class="pf-note">每行一个头像文件名的 8 位十六进制哈希或文件名；用于识别批量头像。</div>

          <div class="pf-section-title">白名单</div>
          <div class="pf-note" id="pf-wl-count">UID 0 / 单条 0</div>
          <textarea id="pf-wl" class="pf-textarea" spellcheck="false"
            placeholder="每行一个 UID，优先级高于远端黑名单"></textarea>
          <div class="pf-row">
            <button id="pf-wl-save" class="pf-btn" type="button">保存白名单</button>
            <button id="pf-wl-clear" class="pf-btn" type="button">清空白名单</button>
          </div>

          <div class="pf-section-title">维护</div>
          <div class="pf-row">
            <button id="pf-save" class="pf-btn" type="button">保存设置</button>
            <button id="pf-reset" class="pf-btn" type="button">恢复默认</button>
          </div>
          <div class="pf-row">
            <button id="pf-clear-stats" class="pf-btn" type="button">清空统计</button>
            <button id="pf-clear-log" class="pf-btn" type="button">清空日志</button>
          </div>
          <div class="pf-note">
            日志仅保存在本机 GM 存储。点击“恢复”会解除本条屏蔽；点击“加入白名单”会放行该 UID 的所有评论。
          </div>
        </section>

        <section data-pane="log" hidden>
          <div class="pf-note">按时间倒序，最多保留 200 条。恢复历史记录时若 DOM 已销毁，只写入白名单。</div>
          <div id="pf-log-list"></div>
        </section>
      </div>

      <div class="pf-foot">仅本地运行。不调用 B 站 API，不上传评论。</div>
    </section>

    <section id="pf-queue" class="pf-queue" hidden aria-label="待上报评论">
      <div class="pf-queue-head">
        <span>待上报评论 <span id="pf-queue-count">0</span></span>
        <button id="pf-queue-clear" class="pf-linkbtn" type="button">清空</button>
      </div>
      <div id="pf-queue-list" class="pf-queue-list"></div>
      <div class="pf-queue-foot">
        <label class="pf-check"><input type="checkbox" id="pf-queue-all"> 全选</label>
        <button id="pf-queue-submit" class="pf-btn" type="button">提交选中</button>
      </div>
      <div id="pf-queue-notice" class="pf-note pf-queue-notice"></div>
    </section>
  `;

  function q(selector) {
    return ui && ui.shadow ? ui.shadow.querySelector(selector) : null;
  }

  function ensureUI() {
    if (ui) return ui;
    if (!document.documentElement) return null;

    host = document.createElement('div');
    host.id = 'pkillfish-root';
    host.setAttribute('data-pkillfish', '1');
    host.style.cssText = 'all: initial;';

    let shadow;
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch (_) {
      return null;
    }

    shadow.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.documentElement.appendChild(host);

    ui = {
      host: host,
      shadow: shadow,
      launcher: shadow.querySelector('#pf-launcher'),
      panel: shadow.querySelector('#pf-panel'),
      close: shadow.querySelector('#pf-close'),
      tabs: shadow.querySelectorAll('.pf-tab'),
      panes: shadow.querySelectorAll('[data-pane]'),
      notice: shadow.querySelector('#pf-notice'),
      update: shadow.querySelector('#pf-update'),
      updateState: shadow.querySelector('#pf-update-state'),
      stTotal: shadow.querySelector('#pf-st-total'),
      stBlacklist: shadow.querySelector('#pf-st-blacklist'),
      stKeyword: shadow.querySelector('#pf-st-keyword'),
      stRules: shadow.querySelector('#pf-st-rules'),
      stModel: shadow.querySelector('#pf-st-model'),
      stMl: shadow.querySelector('#pf-st-ml'),
      stPage: shadow.querySelector('#pf-st-page'),
      stToday: shadow.querySelector('#pf-st-today'),
      stBlCount: shadow.querySelector('#pf-st-blcount'),
      stKwCount: shadow.querySelector('#pf-st-kwcount'),
      stKwUpdated: shadow.querySelector('#pf-st-kwupdated'),
      stVersion: shadow.querySelector('#pf-st-version'),
      stUpdated: shadow.querySelector('#pf-st-updated'),
      stWhitelist: shadow.querySelector('#pf-st-whitelist'),
      stState: shadow.querySelector('#pf-st-state'),
      enabled: shadow.querySelector('#pf-enabled'),
      rules: shadow.querySelector('#pf-rules'),
      keywordRules: shadow.querySelector('#pf-keyword-rules'),
      keywordBlock: shadow.querySelector('#pf-keyword-block'),
      offline: shadow.querySelector('#pf-offline'),
      report: shadow.querySelector('#pf-report'),
      debug: shadow.querySelector('#pf-debug'),
      model: shadow.querySelector('#pf-model'),
      mlEnabled: shadow.querySelector('#pf-ml-enabled'),
      mlOnlyBadge: shadow.querySelector('#pf-ml-only-badge'),
      mlUrl: shadow.querySelector('#pf-ml-url'),
      mlLoad: shadow.querySelector('#pf-ml-load'),
      mlUnload: shadow.querySelector('#pf-ml-unload'),
      mlState: shadow.querySelector('#pf-ml-state'),
      repo: shadow.querySelector('#pf-repo'),
      blUrl: shadow.querySelector('#pf-bl-url'),
      kwUrl: shadow.querySelector('#pf-kw-url'),
      interval: shadow.querySelector('#pf-interval'),
      threshold: shadow.querySelector('#pf-threshold'),
      burstCount: shadow.querySelector('#pf-burst-count'),
      burstWindow: shadow.querySelector('#pf-burst-window'),
      keywords: shadow.querySelector('#pf-keywords'),
      patterns: shadow.querySelector('#pf-patterns'),
      avatars: shadow.querySelector('#pf-avatars'),
      wl: shadow.querySelector('#pf-wl'),
      wlCount: shadow.querySelector('#pf-wl-count'),
      wlSave: shadow.querySelector('#pf-wl-save'),
      wlClear: shadow.querySelector('#pf-wl-clear'),
      save: shadow.querySelector('#pf-save'),
      reset: shadow.querySelector('#pf-reset'),
      clearStats: shadow.querySelector('#pf-clear-stats'),
      clearLog: shadow.querySelector('#pf-clear-log'),
      logList: shadow.querySelector('#pf-log-list'),
      queue: shadow.querySelector('#pf-queue'),
      queueCount: shadow.querySelector('#pf-queue-count'),
      queueList: shadow.querySelector('#pf-queue-list'),
      queueAll: shadow.querySelector('#pf-queue-all'),
      queueSubmit: shadow.querySelector('#pf-queue-submit'),
      queueClear: shadow.querySelector('#pf-queue-clear'),
      queueNotice: shadow.querySelector('#pf-queue-notice')
    };

    bindUI();
    renderSettings();
    renderReportQueue();
    refreshUI();
    return ui;
  }

  function bindUI() {
    ui.launcher.addEventListener('click', function () {
      if (ui.panel.hidden) openPanel();
      else closePanel();
    });

    ui.close.addEventListener('click', closePanel);

    for (let i = 0; i < ui.tabs.length; i += 1) {
      ui.tabs[i].addEventListener('click', function (event) {
        setTab(event.currentTarget.getAttribute('data-tab'));
      });
    }

    const checkboxRefs = [
      ui.enabled,
      ui.rules,
      ui.keywordRules,
      ui.keywordBlock,
      ui.offline,
      ui.report,
      ui.debug,
      ui.model
    ];
    for (let i = 0; i < checkboxRefs.length; i += 1) {
      checkboxRefs[i].addEventListener('change', function () {
        applyForm(false);
      });
    }

    const textRefs = [
      ui.repo,
      ui.blUrl,
      ui.kwUrl,
      ui.interval,
      ui.threshold,
      ui.burstCount,
      ui.burstWindow,
      ui.keywords,
      ui.patterns,
      ui.avatars
    ];
    for (let i = 0; i < textRefs.length; i += 1) {
      textRefs[i].addEventListener('change', function () {
        applyForm(false);
      });
    }

    ui.update.addEventListener('click', function () {
      updateAll(true);
    });

    ui.mlLoad.addEventListener('click', function () {
      loadMlModel();
    });

    ui.mlUnload.addEventListener('click', function () {
      unloadMlModel(false);
    });

    ui.save.addEventListener('click', function () {
      applyForm(true);
    });

    ui.reset.addEventListener('click', function () {
      resetSettings();
    });

    ui.wlSave.addEventListener('click', function () {
      saveWhitelistFromPanel();
    });

    ui.wlClear.addEventListener('click', function () {
      clearWhitelist();
    });

    ui.clearStats.addEventListener('click', function () {
      if (!window.confirm('清空统计计数？日志与屏蔽状态不受影响。')) return;
      state.stats = { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0, ml: 0, byDay: {} };
      pageStats = { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0, ml: 0 };
      saveState(true);
      refreshUI();
      setNotice('统计已清空。');
    });

    ui.clearLog.addEventListener('click', function () {
      if (!window.confirm('清空日志？已隐藏的评论不会自动恢复。')) return;
      if (fishFilterActive) exitFishFilter();
      state.log = [];
      nodeMap.clear();
      recordCandidates.clear();
      saveState(true);
      renderLog();
      refreshUI();
      scheduleFilterRefresh();
      setNotice('日志已清空。');
    });

    ui.queueAll.addEventListener('change', function () {
      const selected = !!ui.queueAll.checked;
      for (let i = 0; i < state.reportQueue.length; i += 1) {
        state.reportQueue[i].selected = selected;
      }
      saveState();
      renderReportQueue();
    });

    ui.queueSubmit.addEventListener('click', function () {
      submitSelectedReports();
    });

    ui.queueClear.addEventListener('click', function () {
      if (!state.reportQueue.length) return;
      if (!window.confirm('清空待上报列表？已经提交到 GitHub 的内容不受影响。')) return;
      state.reportQueue = [];
      saveState(true);
      renderReportQueue();
    });

    ui.queueList.addEventListener('change', function (event) {
      const target = event.target;
      if (!target || target.getAttribute('data-queue-select') === null) return;
      const id = target.getAttribute('data-queue-select');
      const item = state.reportQueue.find(function (entry) {
        return entry.id === id;
      });
      if (!item) return;
      item.selected = !!target.checked;
      saveState();
      updateQueueControls();
    });

    ui.queueList.addEventListener('click', function (event) {
      const target = event.target;
      if (!target || !target.getAttribute) return;
      const id = target.getAttribute('data-queue-remove');
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      state.reportQueue = state.reportQueue.filter(function (entry) {
        return entry.id !== id;
      });
      saveState();
      renderReportQueue();
    });

    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key === 'Escape' && ui && !ui.panel.hidden) closePanel();
      },
      true
    );

    document.addEventListener(
      'click',
      function (event) {
        if (!ui || ui.panel.hidden) return;
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (path.indexOf(host) !== -1) return;
        closePanel();
      },
      true
    );
  }

  function setTab(name) {
    if (name !== 'status' && name !== 'settings' && name !== 'log') name = 'status';
    currentTab = name;
    for (let i = 0; i < ui.tabs.length; i += 1) {
      const tab = ui.tabs[i];
      if (tab.getAttribute('data-tab') === name) tab.classList.add('active');
      else tab.classList.remove('active');
    }
    for (let i = 0; i < ui.panes.length; i += 1) {
      ui.panes[i].hidden = ui.panes[i].getAttribute('data-pane') !== name;
    }
    if (name === 'log') renderLog();
    if (name === 'status') refreshUI();
  }

  function openPanel(tab) {
    ensureUI();
    if (!ui) return;
    ui.panel.hidden = false;
    ui.launcher.setAttribute('aria-expanded', 'true');
    renderSettings();
    refreshUI();
    setTab(tab || currentTab);
    try {
      ui.close.focus();
    } catch (_) {
      /* ignore */
    }
  }

  function closePanel() {
    if (!ui) return;
    ui.panel.hidden = true;
    ui.launcher.setAttribute('aria-expanded', 'false');
  }

  function setNotice(text, isError) {
    noticeText = String(text == null ? '' : text);
    noticeIsError = !!isError;
    if (ui && ui.notice) {
      ui.notice.textContent = noticeText;
      ui.notice.className = 'pf-note' + (noticeIsError ? ' pf-error' : '');
    }
  }

  function refreshUI() {
    if (!ui) return;
    renderStatus();
    if (!ui.panel.hidden && currentTab === 'log') renderLog();
  }

  function renderStatus() {
    if (!ui || !state) return;
    ui.stTotal.textContent = String(state.stats.total);
    ui.stBlacklist.textContent = String(state.stats.blacklist);
    ui.stKeyword.textContent = String(state.stats.keyword || 0);
    ui.stRules.textContent = String(state.stats.rules);
    ui.stModel.textContent = String(state.stats.model);
    ui.stMl.textContent = String(state.stats.ml || 0);
    ui.stPage.textContent = String(pageStats.total);
    ui.stToday.textContent = String(state.stats.byDay[todayKey()] || 0);
    ui.stBlCount.textContent = String(blacklistDoc.entries.length);
    ui.stKwCount.textContent = String(
      (keywordDoc.nameKeywords || []).length + (keywordDoc.commentKeywords || []).length
    );
    ui.stKwUpdated.textContent = keywordMeta.fetchedAt
      ? formatTime(keywordMeta.fetchedAt)
      : keywordDoc.updatedAt
        ? '缓存 ' + formatTime(Date.parse(keywordDoc.updatedAt))
        : '从未更新';
    ui.stVersion.textContent = String(blacklistDoc.version || 0);
    ui.stUpdated.textContent = blacklistMeta.fetchedAt
      ? formatTime(blacklistMeta.fetchedAt)
      : blacklistDoc.updatedAt
        ? '缓存 ' + formatTime(Date.parse(blacklistDoc.updatedAt))
        : '从未更新';

    const wlCount =
      state.whitelist.mids.length +
      state.whitelist.rpids.length +
      state.whitelist.fingerprints.length;
    ui.stWhitelist.textContent = String(wlCount);

    let stateText = '就绪';
    if (blacklistMeta.updating || keywordMeta.updating) stateText = '更新中';
    else if (settings.offline) stateText = '离线模式';
    else if (blacklistMeta.error || keywordMeta.error) stateText = '上次更新失败';
    else if (
      !blacklistDoc.entries.length &&
      !(keywordDoc.nameKeywords || []).length &&
      !(keywordDoc.commentKeywords || []).length
    ) {
      stateText = '使用本地缓存（空）';
    }
    ui.stState.textContent = stateText;

    ui.update.disabled =
      blacklistMeta.updating || keywordMeta.updating || settings.offline;
    ui.update.textContent =
      blacklistMeta.updating || keywordMeta.updating ? '更新中' : '更新黑名单/关键词';
    const updateError = blacklistMeta.error || keywordMeta.error;
    ui.updateState.textContent = updateError
      ? truncate(updateError, 80)
      : settings.offline
        ? '离线模式：不联网'
        : blacklistMeta.checkedAt || keywordMeta.checkedAt
          ? '上次检查 ' +
            formatTime(Math.max(blacklistMeta.checkedAt, keywordMeta.checkedAt))
          : '尚未检查';

    if (ui.notice) {
      ui.notice.textContent = noticeText;
      ui.notice.className = 'pf-note' + (noticeIsError ? ' pf-error' : '');
    }
  }

  function renderSettings() {
    if (!ui || !state) return;
    ui.enabled.checked = !!settings.enabled;
    ui.rules.checked = !!settings.rulesEnabled;
    ui.keywordRules.checked = !!settings.keywordRulesEnabled;
    ui.keywordBlock.checked = !!settings.keywordBlockEnabled;
    ui.offline.checked = !!settings.offline;
    ui.report.checked = !!settings.reportEnabled;
    ui.debug.checked = !!settings.debug;
    ui.model.checked = !!settings.enableLocalModel;
    ui.mlEnabled.checked = !!settings.mlEnabled;
    ui.mlOnlyBadge.checked = !!settings.mlOnlyBadge;
    ui.mlUrl.value = settings.mlModelUrl || '';
    mlStateApply();

    ui.repo.value = settings.reportRepo || '';
    ui.blUrl.value = settings.blacklistUrl || '';
    ui.kwUrl.value = settings.keywordUrl || '';
    ui.interval.value = String(settings.updateIntervalHours);
    ui.threshold.value = String(settings.threshold);
    ui.burstCount.value = String(settings.burst.count);
    ui.burstWindow.value = String(settings.burst.windowMinutes);
    ui.keywords.value = (settings.nicknameKeywords || []).join('\n');
    ui.patterns.value = (settings.phrasePatterns || []).join('\n');
    ui.avatars.value = (settings.avatarHashes || []).join('\n');
    ui.wl.value = state.whitelist.mids.join('\n');
    ui.wlCount.textContent =
      'UID ' +
      state.whitelist.mids.length +
      ' / 单条 ' +
      (state.whitelist.rpids.length + state.whitelist.fingerprints.length);
  }

  function rulesSignature() {
    return JSON.stringify({
      rulesEnabled: settings.rulesEnabled,
      keywordRulesEnabled: settings.keywordRulesEnabled,
      keywordBlockEnabled: settings.keywordBlockEnabled,
      threshold: settings.threshold,
      weights: settings.weights,
      burst: settings.burst,
      keywords: settings.nicknameKeywords,
      patterns: settings.phrasePatterns,
      avatars: settings.avatarHashes
    });
  }

  function applyForm(rerender) {
    if (!state) return;
    const previousReport = settings.reportEnabled;
    const previousEnabled = settings.enabled;
    const previousMlEnabled = settings.mlEnabled;
    const previousMlOnlyBadge = settings.mlOnlyBadge;
    const previousMlUrl = settings.mlModelUrl;
    const previousSignature = rulesSignature();
    let repoInvalid = false;

    settings.enabled = !!ui.enabled.checked;
    settings.rulesEnabled = !!ui.rules.checked;
    settings.keywordRulesEnabled = !!ui.keywordRules.checked;
    settings.keywordBlockEnabled = !!ui.keywordBlock.checked;
    settings.offline = !!ui.offline.checked;
    settings.reportEnabled = !!ui.report.checked;
    settings.debug = !!ui.debug.checked;
    settings.enableLocalModel = !!ui.model.checked;
    settings.mlEnabled = !!ui.mlEnabled.checked;
    settings.mlOnlyBadge = !!ui.mlOnlyBadge.checked;
    settings.mlModelUrl = cleanText(ui.mlUrl.value, 500, false);

    const repoInput = cleanText(ui.repo.value, 140, false);
    const repoNormalized = normalizeRepo(repoInput);
    if (repoInput && !repoNormalized) {
      repoInvalid = true;
    } else {
      settings.reportRepo = repoNormalized || DEFAULT_REPORT_REPO;
    }
    settings.blacklistUrl = cleanText(ui.blUrl.value, 500, false);
    settings.keywordUrl = cleanText(ui.kwUrl.value, 500, false);
    settings.updateIntervalHours = clampNumber(
      parseFloat(ui.interval.value),
      0.25,
      720,
      DEFAULT_SETTINGS.updateIntervalHours
    );
    settings.threshold = clampInt(
      parseInt(ui.threshold.value, 10),
      1,
      12,
      DEFAULT_SETTINGS.threshold
    );
    settings.burst.count = clampInt(
      parseInt(ui.burstCount.value, 10),
      2,
      100,
      DEFAULT_SETTINGS.burst.count
    );
    settings.burst.windowMinutes = clampInt(
      parseInt(ui.burstWindow.value, 10),
      1,
      1440,
      DEFAULT_SETTINGS.burst.windowMinutes
    );
    settings.nicknameKeywords = splitList(ui.keywords.value).slice(0, LIMITS.maxRules);
    settings.phrasePatterns = splitList(ui.patterns.value, /\r?\n/).slice(0, 50);
    settings.avatarHashes = splitList(ui.avatars.value)
      .map(function (s) {
        return s.toLowerCase();
      })
      .filter(function (s) {
        return /^[a-z0-9._-]+$/.test(s);
      })
      .slice(0, LIMITS.maxRules);

    rebuildRules();
    saveState();

    if (previousReport !== settings.reportEnabled) {
      if (settings.reportEnabled) injectAllReportButtons();
      else removeReportButtons();
    }

    if (!settings.mlEnabled && mlModel) {
      unloadMlModel(true);
    } else if (mlModel && previousMlUrl !== settings.mlModelUrl) {
      unloadMlModel(true);
      setNotice('模型地址已改变，请重新点击“加载本页模型”。');
    } else if (mlModel && previousMlOnlyBadge !== settings.mlOnlyBadge) {
      mlReloadForModeChange();
    }

    if (!settings.enabled && fishFilterActive) {
      exitFishFilter();
    }

    if (settings.enabled) {
      if (!previousEnabled || previousSignature !== rulesSignature()) {
        rescanCandidates();
      } else if (settings.enableLocalModel) {
        for (const candidate of candidates) {
          if (candidate && !candidate.hidden && !candidate.modelPending) queueModel(candidate);
        }
      }
    }

    if (settings.offline) setNotice('离线模式已开启：不会拉取远端黑名单。');
    else if (!blacklistMeta.checkedAt && !blacklistMeta.updating) {
      // 首次打开面板并切回在线时，允许手动更新；不自动请求。
    }

    if (rerender) {
      renderSettings();
      setNotice(
        repoInvalid ? '上报仓库地址无效，已保留原值。' : '设置已保存。',
        repoInvalid
      );
    } else if (repoInvalid) {
      setNotice('上报仓库地址无效，已保留原值。', true);
    }
    refreshUI();
  }

  function resetSettings() {
    if (!window.confirm('恢复默认设置？本地白名单、日志与黑名单缓存会保留。')) return;
    state.settings = defaultSettings();
    settings = state.settings;
    rebuildRules();
    rebuildWhitelistSets();
    saveState(true);
    renderSettings();
    if (settings.reportEnabled) injectAllReportButtons();
    else removeReportButtons();
    rescanCandidates();
    refreshUI();
    setNotice('已恢复默认设置。');
  }

  function saveWhitelistFromPanel() {
    const values = splitList(ui.wl.value).filter(function (s) {
      return MID_RE.test(s);
    });
    const before = new Set(state.whitelist.mids);
    state.whitelist.mids = uniq(state.whitelist.mids.concat(values)).slice(
      -LIMITS.maxWhitelist
    );
    rebuildWhitelistSets();
    saveState(true);

    let restored = 0;
    for (let i = 0; i < state.whitelist.mids.length; i += 1) {
      const mid = state.whitelist.mids[i];
      if (before.has(mid)) continue;
      for (let j = 0; j < state.log.length; j += 1) {
        const record = state.log[j];
        if (record.mid === mid && !record.restored) {
          unhideNodes(nodeMap.get(record.id));
          record.restored = true;
          const candidate = recordCandidates.get(record.id);
          if (candidate) {
            candidate.hidden = false;
            candidate.restored = true;
            injectReportButton(candidate);
          }
          restored += 1;
        }
      }
    }
    saveState();
    renderSettings();
    renderLog();
    refreshUI();
    setNotice('白名单已保存，恢复 ' + restored + ' 条。');
  }

  function clearWhitelist() {
    if (!window.confirm('清空白名单？已隐藏的评论不会自动恢复。')) return;
    state.whitelist = { mids: [], rpids: [], fingerprints: [] };
    rebuildWhitelistSets();
    saveState(true);
    renderSettings();
    renderLog();
    refreshUI();
    setNotice('白名单已清空。');
  }

  function isBilibiliCommentUrl(value) {
    try {
      const url = new URL(String(value));
      return (
        url.protocol === 'https:' &&
        /(^|\.)bilibili\.com$/i.test(url.hostname) &&
        url.pathname !== '/'
      );
    } catch (_) {
      return false;
    }
  }

  function setQueueNotice(text, isError) {
    if (!ui || !ui.queueNotice) return;
    ui.queueNotice.textContent = String(text || '');
    ui.queueNotice.className = 'pf-note pf-queue-notice' + (isError ? ' pf-error' : '');
  }

  function updateQueueControls() {
    if (!ui || !state) return;
    const total = state.reportQueue.length;
    const selected = state.reportQueue.filter(function (item) {
      return item.selected !== false;
    }).length;

    ui.queue.hidden = total === 0;
    ui.queueCount.textContent = String(total);
    ui.queueSubmit.textContent = '提交选中 (' + selected + ')';
    ui.queueSubmit.disabled = selected === 0;
    ui.queueAll.checked = total > 0 && selected === total;
    ui.queueAll.indeterminate = selected > 0 && selected < total;
  }

  function renderReportQueue() {
    if (!ui || !state) return;
    const list = ui.queueList;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!state.reportQueue.length) {
      updateQueueControls();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < state.reportQueue.length; i += 1) {
      const item = state.reportQueue[i];
      const row = document.createElement('div');
      row.className = 'pf-queue-item';

      const label = document.createElement('label');
      label.className = 'pf-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.selected !== false;
      checkbox.setAttribute('data-queue-select', item.id);
      label.appendChild(checkbox);

      const meta = document.createElement('span');
      meta.className = 'pf-queue-meta';
      meta.textContent =
        'UID ' + item.mid + (item.uname ? ' · ' + item.uname : '');
      label.appendChild(meta);
      row.appendChild(label);

      const text = document.createElement('div');
      text.className = 'pf-queue-text';
      text.textContent = item.text || '（无文本）';
      row.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'pf-queue-actions';

      const open = document.createElement('a');
      open.href = item.link;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.className = 'pf-linkbtn';
      open.textContent = '打开评论';
      actions.appendChild(open);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pf-linkbtn';
      remove.setAttribute('data-queue-remove', item.id);
      remove.textContent = '移除';
      actions.appendChild(remove);

      row.appendChild(actions);
      fragment.appendChild(row);
    }

    list.appendChild(fragment);
    updateQueueControls();
  }

  function enqueueReport(candidate) {
    if (!candidate) return;
    const resolved = resolvePageMeta(candidate);
    const mid = digitsOnly(resolved.mid);
    const link = resolved ? commentPermalink(resolved) : '';

    if (!mid) {
      setQueueNotice('无法获取该评论的 UID，暂时不能上报。', true);
      return;
    }
    if (!isBilibiliCommentUrl(link)) {
      setQueueNotice('评论链接无效，暂时不能上报。', true);
      return;
    }

    const rpid = digitsOnly(resolved.rpid);
    const key = mid + '|' + (rpid || fingerprintOf(resolved));
    if (
      state.reportQueue.some(function (item) {
        return item.key === key;
      })
    ) {
      setQueueNotice('这条评论已经在待上报列表里。');
      if (ui) ui.queue.hidden = false;
      return;
    }
    if (state.reportQueue.length >= MAX_REPORT_QUEUE) {
      setQueueNotice('待上报列表已满（' + MAX_REPORT_QUEUE + ' 条），请先提交或清空。', true);
      if (ui) ui.queue.hidden = false;
      return;
    }

    const item = {
      id: 'q-' + Date.now().toString(36) + '-' + (state.reportQueue.length + 1).toString(36),
      key: key,
      mid: mid,
      rpid: rpid,
      oid: digitsOnly(resolved.oid),
      type: digitsOnly(resolved.type),
      link: link,
      uname: cleanText(resolved.uname || '', 80, false),
      text: cleanText(resolved.text || '', 500, true),
      selected: true,
      queuedAt: Date.now()
    };

    state.reportQueue.push(item);
    saveState();
    renderReportQueue();
    if (ui) ui.queue.hidden = false;
    setQueueNotice('已加入待上报列表，可继续勾选后一次提交。');
  }

  function markdownCell(value, maxLength) {
    return cleanText(value || '', maxLength === undefined ? 200 : maxLength, false)
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
  }

  function buildBatchIssueUrl(items) {
    const repo = normalizeRepo(settings.reportRepo);
    if (!repo) return { error: '上报仓库地址无效，请填写 owner/repo。' };
    if (!items.length) return { error: '请先勾选要提交的评论。' };
    if (items.length > MAX_BATCH_REPORTS) {
      return { error: '一次最多提交 ' + MAX_BATCH_REPORTS + ' 条，请减少勾选。' };
    }

    const safeMetaText = function (value, max) {
      return cleanText(value || '', max, false)
        .replace(/-->/g, '-- >')
        .replace(/<!--/g, '< !--');
    };

    const reports = items.map(function (item) {
      return {
        mid: digitsOnly(item.mid),
        rpid: digitsOnly(item.rpid),
        oid: digitsOnly(item.oid),
        type: digitsOnly(item.type),
        link: item.link,
        uname: safeMetaText(item.uname, 80),
        text: safeMetaText(item.text, 50)
      };
    });
    if (
      reports.some(function (report) {
        return !report.mid || !isBilibiliCommentUrl(report.link);
      })
    ) {
      return { error: '待上报列表中存在无效 UID 或链接，请先移除。' };
    }

    const meta = '<!-- pkillfish:batch\n' + JSON.stringify(reports) + '\n-->';
    const title = '[fish-report] 批量可疑评论（' + items.length + ' 条）';

    function composeBody(excerptLength) {
      const rows = items.map(function (item, index) {
        const link = item.link;
        const nickname = markdownCell(item.uname || '未知', 60);
        const excerpt = excerptLength > 0
          ? markdownCell(item.text || '', excerptLength)
          : '（见评论链接）';
        return (
          '| ' +
          (index + 1) +
          ' | `' +
          item.mid +
          '` | ' +
          nickname +
          ' | [打开](' +
          link +
          ') | ' +
          excerpt +
          ' |'
        );
      });

      return [
        meta,
        '',
        '### 批量上报（' + items.length + ' 条）',
        '',
        '> 来自 pkillFish 左下角待上报面板。摘要为节选，完整评论请点评论链接。',
        '>',
        '> 提交后不会自动加入黑名单。维护者审核后打 `resolved` 或关闭为 `completed` 才会加入；打 `wontfix` 或关闭为 `not planned` 表示不加入。',
        '',
        '| # | UID | 昵称 | 评论链接 | 摘要 |',
        '|---|---|---|---|---|',
        rows.join('\n'),
        '',
        '### 判断依据',
        '',
        '- [ ] 批量 / 模板化评论',
        '- [ ] 捏造事实、答非所问或与视频无关',
        '- [ ] 昵称、头像或话术指向 DSH / 大肥鱼 Agent',
        '',
        '### 确认',
        '',
        '- [ ] 我只提交了公开评论信息，没有提交任何账号凭据或隐私数据',
        '- [ ] 我理解该 Issue 是公开的，并同意按项目黑名单流程审核'
      ].join('\n');
    }

    let excerptLength = 80;
    let lastUrl = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const params = new URLSearchParams();
      params.set('labels', 'report');
      params.set('title', title);
      params.set('body', composeBody(excerptLength));
      lastUrl = 'https://github.com/' + repo + '/issues/new?' + params.toString();
      if (lastUrl.length <= 7200) break;
      excerptLength = Math.max(0, excerptLength - 20);
    }

    if (lastUrl.length > 7200) {
      return {
        error: '所选评论过多，生成的上报链接过长，请减少勾选后重试。'
      };
    }
    return { url: lastUrl };
  }

  function submitSelectedReports() {
    if (!state) return;
    const selected = state.reportQueue.filter(function (item) {
      return item.selected !== false;
    });
    if (!selected.length) {
      setQueueNotice('请先勾选要提交的评论。', true);
      return;
    }
    if (selected.length > MAX_BATCH_REPORTS) {
      setQueueNotice('一次最多提交 ' + MAX_BATCH_REPORTS + ' 条，请减少勾选。', true);
      return;
    }

    const built = buildBatchIssueUrl(selected);
    if (built.error) {
      setQueueNotice(built.error, true);
      if (built.error.indexOf('仓库') !== -1) openPanel('settings');
      return;
    }

    const ok = gmOpenTab(built.url);
    if (!ok) {
      setQueueNotice('浏览器拦截了新标签页，请允许弹窗后重试。', true);
      return;
    }
    setQueueNotice(
      '已打开 GitHub Issue 新建页。确认提交后，可以点“清空”移除这些条目。'
    );
  }

  function renderLog() {
    if (!ui || !state) return;
    const list = ui.logList;
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!state.log.length) {
      const empty = document.createElement('div');
      empty.className = 'pf-note';
      empty.textContent = '暂无记录。被屏蔽的评论会出现在这里。';
      list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    const shown = state.log.slice(0, 100);

    for (let i = 0; i < shown.length; i += 1) {
      const record = shown[i];
      const item = document.createElement('div');
      item.className = 'pf-log-item';

      const meta = document.createElement('div');
      meta.className = 'pf-log-meta';
      const reasonLabel =
        record.reason === 'blacklist'
          ? '黑名单'
          : record.reason === 'keyword'
            ? '关键词'
            : record.reason === 'model'
              ? '本地模型'
              : record.reason === 'ml'
                ? '实验模型'
                : '规则';
      meta.textContent =
        formatTime(record.ts) +
        ' · UID ' +
        (record.mid || '未知') +
        ' · ' +
        reasonLabel +
        (record.detail ? ' / ' + record.detail : '') +
        (record.score ? ' · 分数 ' + record.score : '');
      item.appendChild(meta);

      const text = document.createElement('div');
      text.className = 'pf-log-text';
      text.textContent = record.text || '（无文本）';
      if (record.text) text.title = record.text;
      item.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'pf-log-actions';

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'pf-linkbtn';
      restore.textContent = record.restored ? '已恢复' : '恢复';
      restore.disabled = !!record.restored;
      restore.addEventListener('click', function () {
        restoreRecord(record.id, 'single');
        setNotice('已恢复该条评论并加入白名单。');
      });
      actions.appendChild(restore);

      const white = document.createElement('button');
      white.type = 'button';
      white.className = 'pf-linkbtn';
      const already = record.mid && whitelistSets.mids.has(record.mid);
      white.textContent = already ? '已在白名单' : '加入白名单';
      white.disabled = !record.mid || already;
      white.addEventListener('click', function () {
        if (!record.mid) return;
        restoreByMid(record.mid);
      });
      actions.appendChild(white);

      item.appendChild(actions);
      fragment.appendChild(item);
    }

    list.appendChild(fragment);
  }

  /* ==========================================================================
   * 生命周期
   * ========================================================================== */

  function shouldRun() {
    try {
      const hostName = location.hostname;
      if (!/(^|\.)bilibili\.com$/.test(hostName)) return false;
      const path = location.pathname;
      if (hostName === 't.bilibili.com') return true;
      if (COMMENT_PAGE_RE.test(path)) return true;
      if (/^\/\d+\/dynamic(\/|$)/.test(path)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function pageKey() {
    try {
      return location.origin + location.pathname;
    } catch (_) {
      return location.href;
    }
  }

  function resetPageState() {
    if (mlModel) unloadMlModel(true);
    if (fishFilterActive) {
      fishFilterActive = false;
      clearFilterHides();
      removeFilterNotice();
    }
    filterButton = null;
    filterHost = null;
    restoreFilterMasks();
    if (filterDebounce) {
      clearTimeout(filterDebounce);
      filterDebounce = null;
    }
    candidates = new Set();
    candidateList = [];
    processed = new WeakSet();
    retryCount = new WeakMap();
    injectionRetry = new WeakMap();
    reportHosts = new WeakSet();
    reportButtons = new Set();
    nodeMap = new Map();
    recordCandidates = new Map();
    pageStats = { total: 0, blacklist: 0, keyword: 0, rules: 0, model: 0 };
    resetRuleTrackers();
    pendingRoots.clear();
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function start() {
    if (active) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }

    active = true;
    ensureUI();
    if (ui && ui.launcher) ui.launcher.hidden = false;
    renderReportQueue();

    startDocumentObserver();
    scheduleInitialScans();

    if (!settings.offline) {
      setTimeout(function () {
        if (active) updateAll(false);
      }, 2500);
    }
    debug('started on', location.href);
  }

  function scheduleInitialScans() {
    queueScan(document);
    setTimeout(function () {
      if (active) queueScan(document);
    }, 700);
    setTimeout(function () {
      if (active) queueScan(document);
    }, 2200);
    setTimeout(function () {
      if (active) queueScan(document);
    }, 5000);
    setTimeout(function () {
      if (active) queueScan(document);
    }, 10000);
  }

  function stop() {
    if (!active) return;
    if (fishFilterActive) exitFishFilter();
    active = false;
    stopObservers();
    closePanel();
    if (ui && ui.launcher) ui.launcher.hidden = true;
    if (ui && ui.queue) ui.queue.hidden = true;
    resetPageState();
    debug('stopped');
  }

  function registerMenuCommands() {
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('pkillFish 设置面板', function () {
          openPanel();
        });
        GM_registerMenuCommand('pkillFish 立即扫描', function () {
          if (active) queueScan(document);
          else openPanel();
        });
      }
    } catch (err) {
      debug('menu registration failed', err && err.message);
    }
  }

  function watchNavigation() {
    if (pageWatcher) return;
    lastHref = location.href;
    lastPageKey = pageKey();

    pageWatcher = setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      const nextKey = pageKey();
      const changed = nextKey !== lastPageKey;
      lastPageKey = nextKey;

      if (changed) resetPageState();

      const should = shouldRun();
      if (should && !active) {
        start();
      } else if (!should && active) {
        stop();
      } else if (should) {
        queueScan(document);
        refreshUI();
        if (changed) {
          setTimeout(function () {
            if (active) queueScan(document);
          }, 400);
        }
      }
    }, 1500);
  }

  function exposeApi() {
    const api = {
      version: VERSION,
      registerClassifier: registerClassifier,
      scanNow: function () {
        if (active) queueScan(document);
      },
      getStats: function () {
        return {
          total: state.stats.total,
          blacklist: state.stats.blacklist,
          keyword: state.stats.keyword,
          rules: state.stats.rules,
          model: state.stats.model,
          ml: state.stats.ml,
          page: pageStats.total
        };
      },
      getLog: function () {
        return state.log.map(function (record) {
          return {
            id: record.id,
            ts: record.ts,
            mid: record.mid,
            rpid: record.rpid,
            reason: record.reason,
            detail: record.detail,
            text: record.text,
            restored: record.restored
          };
        });
      },
      getSettings: function () {
        return safeJsonParse(JSON.stringify(settings));
      },
      restore: function (id) {
        restoreRecord(id, 'single');
      },
      whitelistMid: function (mid) {
        restoreByMid(digitsOnly(mid));
      },
      refreshBlacklist: function () {
        return updateAll(true);
      },
      refreshKeywords: function () {
        return updateKeywords(true);
      },
      loadMlModel: function () {
        return loadMlModel();
      },
      unloadMlModel: function () {
        unloadMlModel(false);
      },
      getMlStatus: function () {
        return {
          status: mlStatus,
          error: mlError,
          version: mlModel ? mlModel.version : '',
          threshold: mlModel ? mlModel.threshold : 0
        };
      },
      openPanel: openPanel,
      _internals: {
        evaluateRules: evaluateRules,
        normalizeDoc: normalizeDoc,
        mergeDocs: mergeDocs,
        buildIssueUrl: buildIssueUrl,
        mlScoreText: mlScoreText
      }
    };

    try {
      window.pkillFish = api;
    } catch (_) {
      /* ignore */
    }

    try {
      const page = pageWindow();
      if (page && page !== window) {
        page.pkillFish = api;
      }
    } catch (_) {
      /* ignore */
    }

    try {
      document.dispatchEvent(new CustomEvent('pkillfish:ready', { detail: api }));
    } catch (_) {
      /* ignore */
    }
  }

  function init() {
    try {
      loadState();
      loadBlacklistCache();
      loadKeywordCache();
      rebuildRules();
      rebuildWhitelistSets();
      registerMenuCommands();
      exposeApi();
      watchNavigation();

      // 长时间挂页时按设置间隔检查黑名单；updateBlacklist 内部会做 due 判断。
      setInterval(function () {
        if (active && !settings.offline && !blacklistMeta.updating) {
          updateAll(false);
        }
      }, 5 * 60 * 1000);

      if (shouldRun()) start();
      else {
        // 非评论页不启动监听；用户仍可通过菜单打开面板。
      }

      document.addEventListener(
        'DOMContentLoaded',
        function () {
          if (shouldRun() && !active) start();
        },
        { once: true }
      );

      window.addEventListener(
        'pagehide',
        function () {
          flushState();
        },
        { capture: true }
      );
    } catch (err) {
      try {
        console.warn('[pkillFish] 初始化失败', err);
      } catch (_) {
        /* ignore */
      }
    }
  }

  init();
})();
