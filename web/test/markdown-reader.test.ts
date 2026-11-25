import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { splitParagraphs } from '../src/readerInteractions'
import { cleanTextForSpeech, processChapterForTts } from '../src/ttsTextProcessor'
import {
  MARKDOWN_BLOCK_PREFIX,
  MARKDOWN_CONTENT_MARKER,
  MarkdownBlock,
  isMarkdownBlock,
  isMarkdownContent,
  splitMarkdownBlocks,
  stripMarkdownForTts,
} from '../src/markdownReader'

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
