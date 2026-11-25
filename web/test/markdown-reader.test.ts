import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { splitParagraphs } from '../src/readerInteractions'
import { cleanTextForSpeech, processChapterForTts } from '../src/ttsTextProcessor'
import {
  MARKDOWN_BLOCK_PREFIX,
  MARKDOWN_CONTENT_MARKER,
  MarkdownBlock,
  buildDocumentOutline,
  cleanMarkdownHeadingText,
  extractMarkdownHeadings,
  isMarkdownBlock,
  isMarkdownContent,
  splitMarkdownBlocks,
  stripMarkdownForTts,
} from '../src/markdownReader'
import type { Chapter } from '../src/api'

test('MarkdownReader - plain novel text bypasses markdown parser completely', () => {
  const plain = '第一段，包含 *星号*。\n# 不该变成标题\n> 不该变成引用'
  assert.equal(isMarkdownContent(plain), false)

  const paragraphs = splitParagraphs(plain)
  assert.deepEqual(paragraphs, ['第一段，包含 *星号*。', '# 不该变成标题', '> 不该变成引用'])
  for (const p of paragraphs) {
    assert.equal(isMarkdownBlock(p), false)
  }
})

test('MarkdownReader - splitParagraphs preserves code fences, tables, blockquotes and lists intact', () => {
  const mdChapter = [
    MARKDOWN_CONTENT_MARKER,
    '## 一级子标题',
    '',
    '这是包含 **加粗**、`code` 和 [链接](https://example.com) 的段落。',
    '',
    '```ts',
    'const x = 1',
    '',
    '# 代码块内空行与井号都不会切碎本块',
    'console.log(x)',
    '```',
    '',
    '> 第一行引用',
    '> 第二行引用',
    '',
    '| 姓名 | 分数 |',
    '| :--- | ---: |',
    '| 张三 | 95 |',
    '',
    '- [x] 完成解析',
    '- [ ] 待验证',
  ].join('\n')

  assert.equal(isMarkdownContent(mdChapter), true)
  const blocks = splitParagraphs(mdChapter)
  assert.equal(blocks.length, 6)
  for (const b of blocks) {
    assert.equal(b.startsWith(MARKDOWN_BLOCK_PREFIX), true)
  }
  assert.equal(splitMarkdownBlocks(mdChapter).length, 6)
})

test('MarkdownReader - MarkdownBlock renders semantic HTML without <h1> and blocks unsafe URLs', () => {
  const blocks = splitMarkdownBlocks([
    MARKDOWN_CONTENT_MARKER,
    '# 子节标题',
    '',
    '含 **加粗**、*斜体*、~~删除~~、`const a=1`、[安全](https://example.com) 与 [危险](javascript:alert(1))。',
    '',
    '```js',
    'const k = 42',
    '```',
    '',
    '| 列1 | 列2 |',
    '| --- | :---: |',
    '| 值1 | 值2 |',
    '',
    '> 引用内容',
    '',
    '- [x] 已完成',
    '',
    '![附图](/api/local-books/abcd1234abcd1234/media/img_1.png)',
  ].join('\n'))

  const html = blocks
    .map((block, idx) =>
      renderToStaticMarkup(
        React.createElement(MarkdownBlock, {
          key: idx,
          block,
          paragraphIndex: idx,
          highlightText: idx === 1 ? '斜体' : undefined,
        }),
      ),
    )
    .join('\n')

  assert.equal(html.includes('<h1'), false, 'Markdown 正文中禁止输出 h1（章节标题专用）')
  assert.equal(html.includes('<h2 class="md-heading md-h1">子节标题</h2>'), true)
  assert.equal(html.includes('<strong>加粗</strong>'), true)
  assert.equal(html.includes('<em><span class="tts-active-sentence">斜体</span></em>'), true)
  assert.equal(html.includes('<del>删除</del>'), true)
  assert.equal(html.includes('<code class="md-inline-code">const a=1</code>'), true)
  assert.equal(html.includes('href="https://example.com"'), true)
  assert.equal(html.includes('javascript:'), false, '危险 javascript: 链接必须被拦截降级为纯文本')
  assert.equal(html.includes('class="tts-active-sentence"'), true, 'Markdown 行内文本同样支持 TTS 句高亮')
  assert.equal(html.includes('<pre class="md-code-block">'), true)
  assert.equal(html.includes('<table class="md-table">'), true)
  assert.equal(html.includes('<blockquote class="md-blockquote">'), true)
  assert.equal(html.includes('md-task-box is-checked'), true)
  assert.equal(html.includes('/api/local-books/abcd1234abcd1234/media/img_1.png'), true)
})

test('MarkdownReader - TTS strips markdown markers and keeps paragraph indices aligned', () => {
  const mdChapter = [
    MARKDOWN_CONTENT_MARKER,
    '## 第一节 引言',
    '',
    '查看 **[文档](https://example.com)** 与 `代码`。',
    '',
    '```python',
    'print("skip me")',
    '```',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 延迟 | 12ms |',
  ].join('\n')

  const blocks = splitParagraphs(mdChapter)
  assert.equal(cleanTextForSpeech(blocks[0]), '第一节 引言')
  assert.equal(cleanTextForSpeech(blocks[1]), '查看 文档 与 代码。')
  assert.equal(cleanTextForSpeech(blocks[2]), '', '围栏代码块朗读时应安全跳过')
  assert.equal(stripMarkdownForTts(blocks[3]), '指标，数值。延迟，12ms')

  const tts = processChapterForTts('第一章', blocks, true)
  assert.equal(tts.paragraphs.length, blocks.length)
  assert.equal(tts.paragraphs[2].sentences.length, 0)
  assert.equal(tts.chunks.some(c => c.paragraphIndex === 3 && c.text.includes('延迟')), true)
})

test('MarkdownReader - adjacent unordered and ordered lists split into separate ul and ol blocks', () => {
  const md = [
    MARKDOWN_CONTENT_MARKER,
    '- 无序第一项',
    '1. 有序第一项',
  ].join('\n')

  const blocks = splitMarkdownBlocks(md)
  assert.equal(blocks.length, 2)
  const html = blocks
    .map((block, idx) => renderToStaticMarkup(React.createElement(MarkdownBlock, { key: idx, block })))
    .join('\n')
  assert.equal(html.includes('<ul '), true)
  assert.equal(html.includes('<ol '), true)
})

test('MarkdownReader - supports Everforest Clarity ==highlight==, combo highlight and callout blocks', () => {
  const md = [
    MARKDOWN_CONTENT_MARKER,
    '普通 ==默认黄底== 与 **==橙底强调==** 混排。',
    '',
    '> [!tip] 实用技巧',
    '> 这里支持 Obsidian Callout 与 *==绿底高亮==*。',
  ].join('\n')

  const blocks = splitMarkdownBlocks(md)
  assert.equal(blocks.length, 2)
  assert.equal(stripMarkdownForTts(blocks[0]), '普通 默认黄底 与 橙底强调 混排。')
  assert.equal(stripMarkdownForTts(blocks[1]), '实用技巧。这里支持 Obsidian Callout 与 绿底高亮。')

  const html = blocks
    .map((block, idx) => renderToStaticMarkup(React.createElement(MarkdownBlock, { key: idx, block })))
    .join('\n')
  assert.equal(html.includes('<mark class="md-mark">默认黄底</mark>'), true)
  assert.equal(html.includes('<strong><mark class="md-mark">橙底强调</mark></strong>'), true)
  assert.equal(html.includes('md-callout md-callout-aqua'), true)
  assert.equal(html.includes('<em><mark class="md-mark">绿底高亮</mark></em>'), true)
})

test('MarkdownReader - styles.css wires Obsidian Everforest Clarity palette tokens cleanly', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const css = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
  assert.ok(css.includes('--ef-fg: #d3c6aa;'), 'Dark foreground should match Everforest Clarity #d3c6aa')
  assert.ok(css.includes('--ef-yellow: #dbbc7f;'), 'Dark bold/yellow should match Everforest Clarity #dbbc7f')
  assert.ok(css.includes('--ef-orange: #e69875;'), 'Dark h1/inline code should match Everforest Clarity #e69875')
  assert.ok(css.includes('--ef-green: #a7c080;'), 'Dark em/h3 should match Everforest Clarity #a7c080')
  assert.ok(css.includes('color: var(--ef-yellow);'), 'Bold text should use --ef-yellow')
  assert.ok(css.includes('color: var(--ef-green);'), 'Italic text should use --ef-green')
  assert.ok(css.includes('color: var(--ef-orange);'), 'Inline code / H1 should use --ef-orange')
})

test('MarkdownReader - extractMarkdownHeadings extracts H1-H4 while skipping code fences', () => {
  const md = [
    MARKDOWN_CONTENT_MARKER,
    '# 第一章 **概览**',
    '',
    '## 二级 `[核心](https://example.com)` 架构',
    '',
    '```bash',
    '## 代码块中的伪标题必须被跳过',
    '### 同样不应出现',
    '```',
    '',
    '### 三级 `detail` 实现 ==高亮==',
    '',
    '#### 四级 尾缀 #',
  ].join('\n')

  assert.equal(cleanMarkdownHeadingText('**加粗** 与 `code` [文字](https://a.b)'), '加粗 与 code 文字')

  const headings = extractMarkdownHeadings(md)
  assert.deepEqual(headings, [
    { level: 1, title: '第一章 概览', ordinal: 0 },
    { level: 2, title: '二级 核心 架构', ordinal: 1 },
    { level: 3, title: '三级 detail 实现 高亮', ordinal: 2 },
    { level: 4, title: '四级 尾缀', ordinal: 3 },
  ])

  const h2Html = renderToStaticMarkup(
    React.createElement(MarkdownBlock, {
      block: `${MARKDOWN_BLOCK_PREFIX}## 二级节点`,
      headingOrdinal: 1,
      isFlashed: true,
    }),
  )
  assert.ok(h2Html.includes('data-md-heading-ordinal="1"'))
  assert.ok(h2Html.includes('md-heading-flash'))
  assert.ok(h2Html.includes('<h2 class="md-heading md-h2">'))
})

test('MarkdownReader - buildDocumentOutline normalizes H1/H2/H3 depths and supports live headings fallback', () => {
  const chapters: Chapter[] = [
    {
      index: 0,
      title: '引言',
      url: 'local://doc/0',
      level: 1,
      headings: [
        { level: 1, title: '引言', ordinal: 0 },
        { level: 2, title: '背景说明', ordinal: 1 },
        { level: 3, title: '历史脉络', ordinal: 2 },
      ],
    },
    {
      index: 1,
      title: '方法论',
      url: 'local://doc/1',
      level: 1,
    },
  ]

  const liveMap = new Map([
    [
      1,
      [
        { level: 2, title: '实验设计', ordinal: 0 },
        { level: 3, title: '对比指标', ordinal: 1 },
      ],
    ],
  ])

  const outline = buildDocumentOutline(chapters, liveMap)
  assert.deepEqual(
    outline.map(o => [o.title, o.depth, o.isChapterRoot, o.headingOrdinal, o.hasChildren]),
    [
      ['引言', 0, true, undefined, true],
      ['背景说明', 1, false, 1, false],
      ['历史脉络', 2, false, 2, false],
      ['方法论', 0, true, undefined, true],
      ['实验设计', 1, false, 0, false],
      ['对比指标', 2, false, 1, false],
    ],
  )

  // 当全篇仅按二级标题分章、内含三级子标题时，章根 depth 自动归零
  const h2RootChapters: Chapter[] = [
    {
      index: 0,
      title: '第一节',
      url: 'local://h2/0',
      level: 2,
      headings: [{ level: 3, title: '子要点 A', ordinal: 0 }],
    },
  ]
  const normalized = buildDocumentOutline(h2RootChapters)
  assert.deepEqual(
    normalized.map(o => [o.title, o.depth, o.isChapterRoot]),
    [
      ['第一节', 0, true],
      ['子要点 A', 1, false],
    ],
  )
})
