export type ReaderTheme = 'light' | 'paper' | 'dark'
export type ReaderFont = 'song' | 'hei' | 'kai' | 'fangsong' | 'system'
export type ReaderPageMode = 'scroll' | 'paginate'
export type ReaderColumnMode = 'auto' | 'single' | 'double'
export type TtsEngineType = 'webSpeech' | 'edge' | 'custom'

export type ReaderSettings = {
  theme: ReaderTheme
  fontSize: number
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  contentPadding: number
  font: ReaderFont
  pageMode: ReaderPageMode
  maxWidth: number
  columnMode: ReaderColumnMode
  sidebarPinned: boolean
  ttsEngine: TtsEngineType
  ttsVoice: string
  ttsSpeed: number
  ttsPitch: number
  ttsAutoNextChapter: boolean
  ttsFilterSymbols: boolean
  ttsHttpTtsId?: number
  ttsCustomUrl?: string
  ttsCustomHeader?: string
  ttsCustomBody?: string
  ttsCustomMethod?: string
}

/** 文档与小说各自独立持久化的排版与布局字段集合（不包含全站主题与 TTS 听书设置）。 */
export type ReaderTypographySettings = Pick<
  ReaderSettings,
  | 'fontSize'
  | 'lineHeight'
  | 'letterSpacing'
  | 'paragraphSpacing'
  | 'contentPadding'
  | 'font'
  | 'pageMode'
  | 'maxWidth'
  | 'columnMode'
  | 'sidebarPinned'
>

const storageKey = 'legado-reader-settings-v2'
export const documentTypographyStorageKey = 'legado-doc-reader-settings-v1'

export const defaultReaderSettings: ReaderSettings = {
  theme: 'light',
  fontSize: 19,
  lineHeight: 1.95,
  letterSpacing: 0,
  paragraphSpacing: 1.15,
  contentPadding: 80,
  font: 'song',
  pageMode: 'scroll',
  maxWidth: 860,
  columnMode: 'auto',
  sidebarPinned: false,
  ttsEngine: 'edge',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsSpeed: 1.0,
  ttsPitch: 1.0,
  ttsAutoNextChapter: true,
  ttsFilterSymbols: true,
  ttsCustomUrl: '',
  ttsCustomHeader: '',
  ttsCustomBody: '',
  ttsCustomMethod: 'GET',
}

/**
 * Markdown / Word 文档专属开箱默认排版：
 * 贴合 Obsidian Everforest Clarity 中英混排长文习惯，并与书架小说默认设置完全隔离。
 */
export const defaultDocumentTypographySettings: ReaderTypographySettings = {
  fontSize: 17,
  lineHeight: 1.75,
  letterSpacing: 0,
  paragraphSpacing: 0.95,
  contentPadding: 60,
  font: 'system',
  pageMode: 'scroll',
  maxWidth: 860,
  columnMode: 'single',
  sidebarPinned: false,
}

export function clampScrollPosition(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

export function scrollPosition(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return clampScrollPosition(scrollTop / Math.max(1, scrollHeight - clientHeight))
}

export function parseReaderFont(font: unknown, fallback: ReaderFont = 'song'): ReaderFont {
  if (font === 'song' || font === 'hei' || font === 'kai' || font === 'fangsong' || font === 'system') return font
  return fallback
}

export function parsePageMode(mode: unknown, fallback: ReaderPageMode = 'scroll'): ReaderPageMode {
  if (mode === 'scroll' || mode === 'paginate') return mode
  return fallback
}

export function parseColumnMode(mode: unknown, fallback: ReaderColumnMode = 'auto'): ReaderColumnMode {
  if (mode === 'single' || mode === 'double' || mode === 'auto') return mode
  return fallback
}

export function parseMaxWidth(width: unknown, fallback: number = defaultReaderSettings.maxWidth): number {
  if (typeof width === 'number' && Number.isFinite(width)) {
    return Math.min(1400, Math.max(560, Math.round(width)))
  }
  return fallback
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, value))
  }
  return fallback
}

/** 对排版与布局字段进行统一夹紧及回退归一化，供小说与文档配置共用。 */
function normalizeTypographySettings(
  raw: Partial<Record<keyof ReaderTypographySettings, unknown>> | null | undefined,
  fallback: ReaderTypographySettings,
): ReaderTypographySettings {
  const saved = raw ?? {}
  return {
    fontSize: clampFinite(saved.fontSize, 15, 28, fallback.fontSize),
    lineHeight: clampFinite(saved.lineHeight, 1.45, 2.4, fallback.lineHeight),
    letterSpacing: clampFinite(saved.letterSpacing, -0.25, 1.5, fallback.letterSpacing),
    paragraphSpacing: clampFinite(saved.paragraphSpacing, 0.7, 2, fallback.paragraphSpacing),
    contentPadding: clampFinite(saved.contentPadding, 20, 120, fallback.contentPadding),
    font: parseReaderFont(saved.font, fallback.font),
    pageMode: parsePageMode(saved.pageMode, fallback.pageMode),
    maxWidth: parseMaxWidth(saved.maxWidth, fallback.maxWidth),
    columnMode: parseColumnMode(saved.columnMode, fallback.columnMode),
    sidebarPinned: typeof saved.sidebarPinned === 'boolean' ? saved.sidebarPinned : fallback.sidebarPinned,
  }
}

export function parseTtsEngine(engine: unknown): TtsEngineType {
  if (engine === 'webSpeech' || engine === 'edge' || engine === 'custom') return engine
  return defaultReaderSettings.ttsEngine
}

/**
 * 确保 TTS 设置处于合法可用状态：
 * 若引擎为 custom 但未配置有效 customUrl，降级回退到稳定的默认 Edge 引擎，
 * 避免向服务端提交非法 chunk 触发 "customUrl 不能为空" 报错。
 */
export function ensureValidTtsSettings(settings: ReaderSettings): ReaderSettings {
  if (settings.ttsEngine === 'custom' && !settings.ttsHttpTtsId && (!settings.ttsCustomUrl || !settings.ttsCustomUrl.trim())) {
    return {
      ...settings,
      ttsEngine: defaultReaderSettings.ttsEngine,
      ttsVoice: defaultReaderSettings.ttsVoice,
    }
  }
  return settings
}

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem('legado-reader-settings-v1')
    const saved = JSON.parse(raw ?? '{}') as Partial<ReaderSettings> & { font?: string }
    const loadedEngine = parseTtsEngine(saved.ttsEngine)
    const customUrl = typeof saved.ttsCustomUrl === 'string' ? saved.ttsCustomUrl : ''
    const ttsHttpTtsId = typeof saved.ttsHttpTtsId === 'number' ? saved.ttsHttpTtsId : undefined
    // 若保存的引擎是 custom 但并未配置接口 URL 或有效 ID，安全回退到默认引擎
    const ttsEngine = loadedEngine === 'custom' && !ttsHttpTtsId && !customUrl.trim() ? defaultReaderSettings.ttsEngine : loadedEngine
    const ttsVoice = ttsEngine === 'edge' && (!saved.ttsVoice || saved.ttsVoice === 'zh-CN-XiaoxiaoNeural' || !saved.ttsVoice.trim())
      ? defaultReaderSettings.ttsVoice
      : (typeof saved.ttsVoice === 'string' && saved.ttsVoice.trim() ? saved.ttsVoice : defaultReaderSettings.ttsVoice)
    return {
      theme: saved.theme === 'paper' || saved.theme === 'dark' ? saved.theme : defaultReaderSettings.theme,
      ...normalizeTypographySettings(saved, defaultReaderSettings),
      ttsEngine,
      ttsVoice,
      ttsSpeed: typeof saved.ttsSpeed === 'number' && Number.isFinite(saved.ttsSpeed) ? Math.min(3.0, Math.max(0.5, saved.ttsSpeed)) : defaultReaderSettings.ttsSpeed,
      ttsPitch: typeof saved.ttsPitch === 'number' && Number.isFinite(saved.ttsPitch) ? Math.min(1.5, Math.max(0.5, saved.ttsPitch)) : defaultReaderSettings.ttsPitch,
      ttsAutoNextChapter: typeof saved.ttsAutoNextChapter === 'boolean' ? saved.ttsAutoNextChapter : defaultReaderSettings.ttsAutoNextChapter,
      ttsFilterSymbols: typeof saved.ttsFilterSymbols === 'boolean' ? saved.ttsFilterSymbols : defaultReaderSettings.ttsFilterSymbols,
      ttsHttpTtsId,
      ttsCustomUrl: customUrl,
      ttsCustomHeader: typeof saved.ttsCustomHeader === 'string' ? saved.ttsCustomHeader : '',
      ttsCustomBody: typeof saved.ttsCustomBody === 'string' ? saved.ttsCustomBody : '',
      ttsCustomMethod: saved.ttsCustomMethod === 'POST' ? 'POST' : 'GET',
    }
  } catch {
    return defaultReaderSettings
  }
}

/** 仅提取 10 个排版与布局字段，避免将全站主题或 TTS 配置混入文档排版存储键。 */
export function extractTypographySettings(settings: ReaderTypographySettings): ReaderTypographySettings {
  return {
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    paragraphSpacing: settings.paragraphSpacing,
    contentPadding: settings.contentPadding,
    font: settings.font,
    pageMode: settings.pageMode,
    maxWidth: settings.maxWidth,
    columnMode: settings.columnMode,
    sidebarPinned: settings.sidebarPinned,
  }
}

/** 从独立的 `legado-doc-reader-settings-v1` 加载文档阅读排版设置。 */
export function loadDocumentTypographySettings(): ReaderTypographySettings {
  try {
    const raw = window.localStorage.getItem(documentTypographyStorageKey)
    if (!raw) return { ...defaultDocumentTypographySettings }
    const saved = JSON.parse(raw) as Partial<Record<keyof ReaderTypographySettings, unknown>>
    return normalizeTypographySettings(saved, defaultDocumentTypographySettings)
  } catch {
    return { ...defaultDocumentTypographySettings }
  }
}

/** 将文档排版设置独立持久化到 `legado-doc-reader-settings-v1`。 */
export function saveDocumentTypographySettings(settings: ReaderTypographySettings): void {
  window.localStorage.setItem(
    documentTypographyStorageKey,
    JSON.stringify(extractTypographySettings(settings)),
  )
}

/** 合成文档阅读器生效配置：保留全站主题与 TTS，替换成文档专属排版字段。 */
export function mergeDocumentSettings(
  base: ReaderSettings,
  docTypography: ReaderTypographySettings,
): ReaderSettings {
  return {
    ...base,
    ...extractTypographySettings(docTypography),
  }
}

/**
 * 将文档模式下修改的共享字段（全站主题、TTS 设置）回写到全局设置，
 * 同时 100% 保留 `base` 原有的书架小说排版字段不受污染。
 */
export function mergeSharedReaderSettings(
  base: ReaderSettings,
  updated: ReaderSettings,
): ReaderSettings {
  return {
    ...updated,
    ...extractTypographySettings(base),
  }
}

export const readerFontFamilies: Record<ReaderFont, string> = {
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti", STSongti, serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", sans-serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "SimKai", "KaiTi_GB2312", "STKaiti-SC-Regular", "BiauKai", "DFKai-SB", 楷体, 楷体_GB2312, serif',
  fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "STFangsong-SC-Regular", "SimFang", 仿宋, 仿宋_GB2312, serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
}

export function getReaderFontFamily(font: ReaderFont): string {
  return readerFontFamilies[font] || readerFontFamilies.song
}

export function saveReaderSettings(settings: ReaderSettings): void {
  window.localStorage.setItem(storageKey, JSON.stringify(settings))
}



