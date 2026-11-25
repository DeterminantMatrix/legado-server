import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scrollTapZone,
  paginateTapZone,
  mobileTapZone,
  isAtTopBoundary,
  isAtBottomBoundary,
  isTapGesture,
  swipeDirection,
  isInteractiveReaderTarget,
  calculatePaginationLayout,
  isDoubleColumnActive,
} from '../src/readerInteractions.ts'
import {
  clampScrollPosition,
  scrollPosition,
  parseReaderFont,
  parsePageMode,
  parseColumnMode,
  parseMaxWidth,
  loadReaderSettings,
  saveReaderSettings,
  getReaderFontFamily,
  defaultReaderSettings,
  documentTypographyStorageKey,
  defaultDocumentTypographySettings,
  loadDocumentTypographySettings,
  saveDocumentTypographySettings,
  extractTypographySettings,
  mergeDocumentSettings,
  mergeSharedReaderSettings,
} from '../src/readerSettings.ts'

test('reader interactions - tap zones and gestures', () => {
  // Scroll mode tap zones
  assert.equal(scrollTapZone(100, 1000), 'previous') // 10%
  assert.equal(scrollTapZone(500, 1000), 'toggle')   // 50%
  assert.equal(scrollTapZone(900, 1000), 'next')     // 90%
  assert.equal(mobileTapZone(100, 1000), 'previous')

  // Paginated mode tap zones
  assert.equal(paginateTapZone(100, 1000), 'previous') // 10%
  assert.equal(paginateTapZone(500, 1000), 'toggle')   // 50%
  assert.equal(paginateTapZone(900, 1000), 'next')     // 90%

  // Boundaries
  assert.equal(isAtTopBoundary(0), true)
  assert.equal(isAtTopBoundary(5), true)
  assert.equal(isAtTopBoundary(10), false)
  assert.equal(isAtBottomBoundary(980, 2000, 1000, 20), true) // 980 + 1000 = 1980 >= 2000 - 20
  assert.equal(isAtBottomBoundary(500, 2000, 1000, 20), false)

  // Gestures
  assert.equal(isTapGesture(100, 100, 105, 105), true)
  assert.equal(isTapGesture(100, 100, 150, 100), false)

  assert.equal(swipeDirection(200, 100, 100, 100), 'left')
  assert.equal(swipeDirection(100, 100, 200, 100), 'right')
  assert.equal(swipeDirection(100, 100, 110, 100), null) // too short
  assert.equal(swipeDirection(100, 100, 150, 200), null) // vertical diagonal
})

test('reader settings - parsing, math clamping and localStorage persistence', () => {
  assert.equal(clampScrollPosition(0.5), 0.5)
  assert.equal(clampScrollPosition(-1), 0)
  assert.equal(clampScrollPosition(2), 1)
  assert.equal(clampScrollPosition(NaN), 0)

  assert.equal(scrollPosition(500, 1500, 500), 0.5) // 500 / 1000 = 0.5

  assert.equal(parseReaderFont('kai'), 'kai')
  assert.equal(parseReaderFont('invalid-font'), 'song')

  assert.equal(parsePageMode('paginate'), 'paginate')
  assert.equal(parsePageMode('other'), 'scroll')

  assert.equal(parseColumnMode('double'), 'double')
  assert.equal(parseColumnMode('invalid'), 'auto')

  assert.equal(parseMaxWidth(1000), 1000)
  assert.equal(parseMaxWidth(200), 560)
  assert.equal(parseMaxWidth(3000), 1400)
  assert.equal(parseMaxWidth('invalid'), defaultReaderSettings.maxWidth)

  // Fonts
  assert.ok(getReaderFontFamily('kai').includes('Kaiti'))
  assert.ok(getReaderFontFamily('system').includes('system-ui') || getReaderFontFamily('system').includes('-apple-system'))

  // LocalStorage
  const mockStorage: Record<string, string> = {}
  const originalWindow = globalThis.window
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => { mockStorage[key] = val },
    },
  }

  try {
    const loadedDefault = loadReaderSettings()
    assert.equal(loadedDefault.theme, 'light')

    saveReaderSettings({ ...defaultReaderSettings, theme: 'dark', fontSize: 24 })
    const loadedSaved = loadReaderSettings()
    assert.equal(loadedSaved.theme, 'dark')
    assert.equal(loadedSaved.fontSize, 24)
  } finally {
    globalThis.window = originalWindow
  }
})

test('document reader typography settings - isolated persistence, clamping, and bidirectional safety', () => {
  const mockStorage: Record<string, string> = {}
  const originalWindow = globalThis.window
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => { mockStorage[key] = val },
    },
  }

  try {
    // 1. 无缓存时返回文档默认排版，与小说默认设置相互独立
    const initialDoc = loadDocumentTypographySettings()
    assert.deepEqual(initialDoc, defaultDocumentTypographySettings)
    assert.notEqual(initialDoc.font, defaultReaderSettings.font)
    assert.notEqual(initialDoc.fontSize, defaultReaderSettings.fontSize)
    assert.notEqual(initialDoc.columnMode, defaultReaderSettings.columnMode)

    // 2. 存储键与字段严格隔离：保存文档排版不写入 theme / tts*，也不覆盖小说存储键
    const novelBase = {
      ...defaultReaderSettings,
      theme: 'paper' as const,
      fontSize: 23,
      lineHeight: 2.2,
      letterSpacing: 0.5,
      paragraphSpacing: 1.5,
      contentPadding: 90,
      font: 'kai' as const,
      pageMode: 'paginate' as const,
      maxWidth: 1020,
      columnMode: 'double' as const,
      sidebarPinned: true,
      ttsVoice: 'zh-CN-XiaoxiaoNeural',
    }
    saveReaderSettings(novelBase)
    saveDocumentTypographySettings({
      ...defaultDocumentTypographySettings,
      fontSize: 16,
      font: 'hei',
      theme: 'dark',
      ttsVoice: 'other-voice',
    } as typeof defaultDocumentTypographySettings)

    const rawDocSaved = JSON.parse(mockStorage[documentTypographyStorageKey]) as Record<string, unknown>
    assert.equal('theme' in rawDocSaved, false)
    assert.equal('ttsVoice' in rawDocSaved, false)
    assert.equal(loadReaderSettings().fontSize, 23)
    assert.equal(loadReaderSettings().font, 'kai')

    // 3. 范围夹紧与文档专属枚举默认值回退（不可错误回退成小说默认 'song' / 'auto'）
    mockStorage[documentTypographyStorageKey] = JSON.stringify({
      fontSize: 99,
      lineHeight: 0.5,
      letterSpacing: -5,
      paragraphSpacing: 9,
      contentPadding: 200,
      maxWidth: 100,
      font: 'invalid-font',
      pageMode: 'invalid-mode',
      columnMode: 'invalid-column',
      sidebarPinned: 'not-bool',
    })
    const clampedDoc = loadDocumentTypographySettings()
    assert.equal(clampedDoc.fontSize, 28)
    assert.equal(clampedDoc.lineHeight, 1.45)
    assert.equal(clampedDoc.letterSpacing, -0.25)
    assert.equal(clampedDoc.paragraphSpacing, 2)
    assert.equal(clampedDoc.contentPadding, 120)
    assert.equal(clampedDoc.maxWidth, 560)
    assert.equal(clampedDoc.font, 'system')
    assert.equal(clampedDoc.pageMode, 'scroll')
    assert.equal(clampedDoc.columnMode, 'single')
    assert.equal(clampedDoc.sidebarPinned, false)

    // 损坏 JSON 兜底
    mockStorage[documentTypographyStorageKey] = '{broken-json'
    assert.deepEqual(loadDocumentTypographySettings(), defaultDocumentTypographySettings)

    // 4. 双向防污染推演：文档下改全部排版字段 + 切换全站主题/TTS -> 小说排版纹丝不动
    const activeDoc = mergeDocumentSettings(loadReaderSettings(), loadDocumentTypographySettings())
    assert.equal(activeDoc.theme, 'paper')
    assert.equal(activeDoc.fontSize, defaultDocumentTypographySettings.fontSize)
    assert.equal(activeDoc.font, defaultDocumentTypographySettings.font)

    const editedInDocMode = {
      ...activeDoc,
      theme: 'dark' as const,
      ttsVoice: 'zh-CN-YunxiNeural',
      fontSize: 15,
      lineHeight: 1.6,
      letterSpacing: 0.2,
      paragraphSpacing: 0.85,
      contentPadding: 44,
      font: 'hei' as const,
      pageMode: 'scroll' as const,
      maxWidth: 780,
      columnMode: 'single' as const,
      sidebarPinned: false,
    }
    saveDocumentTypographySettings(extractTypographySettings(editedInDocMode))
    const mergedNovelAfterDocEdit = mergeSharedReaderSettings(loadReaderSettings(), editedInDocMode)
    saveReaderSettings(mergedNovelAfterDocEdit)

    const persistedDoc = loadDocumentTypographySettings()
    assert.deepEqual(persistedDoc, extractTypographySettings(editedInDocMode))

    const persistedNovel = loadReaderSettings()
    assert.equal(persistedNovel.theme, 'dark')
    assert.equal(persistedNovel.ttsVoice, 'zh-CN-YunxiNeural')
    assert.deepEqual(extractTypographySettings(persistedNovel), extractTypographySettings(novelBase))

    // 5. 小说模式下修改排版不影响文档排版
    saveReaderSettings({ ...persistedNovel, fontSize: 26, font: 'fangsong' })
    assert.deepEqual(loadDocumentTypographySettings(), persistedDoc)

    // 6. 文档模式恢复默认排版：保留共享 theme 与 TTS，小说排版依然完好无损
    const resetDocAction = {
      ...mergeDocumentSettings(loadReaderSettings(), loadDocumentTypographySettings()),
      ...defaultDocumentTypographySettings,
    }
    saveDocumentTypographySettings(extractTypographySettings(resetDocAction))
    saveReaderSettings(mergeSharedReaderSettings(loadReaderSettings(), resetDocAction))
    assert.deepEqual(loadDocumentTypographySettings(), defaultDocumentTypographySettings)
    assert.equal(loadReaderSettings().theme, 'dark')
    assert.equal(loadReaderSettings().ttsVoice, 'zh-CN-YunxiNeural')
    assert.equal(loadReaderSettings().fontSize, 26)
    assert.equal(loadReaderSettings().font, 'fangsong')
  } finally {
    globalThis.window = originalWindow
  }
})
