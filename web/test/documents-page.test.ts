import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppHeader } from '../src/AppHeader'
import { defaultReaderSettings } from '../src/readerSettings'
import type { BookshelfItem } from '../src/api'
import {
  DOCUMENT_ACCEPT_ATTR,
  getDocumentFormat,
  getLocalBookFormat,
  isDocumentItem,
  isSupportedDocumentFile,
} from '../src/documents'
import { DocumentsPage } from '../src/DocumentsPage'

test('Documents - classification distinguishes md/docx from txt/epub and online books', () => {
  const mdItem: BookshelfItem = {
    sourceId: 'loc_book',
    bookUrl: 'local://md-1',
    name: '架构笔记',
    tocUrl: 'local://md-1/toc',
    lastReadAt: Date.now(),
    cachedChapters: 3,
    totalChapters: 3,
    cacheState: 'ready',
    completed: false,
    bookKind: 'local',
    variable: JSON.stringify({ localFormat: 'md' }),
  }
  const docxItem: BookshelfItem = {
    ...mdItem,
    bookUrl: 'local://docx-1',
    name: '项目周报',
    variable: JSON.stringify({ localFormat: 'docx' }),
  }
  const txtItem: BookshelfItem = {
    ...mdItem,
    bookUrl: 'local://txt-1',
    name: '凡人修仙传',
    variable: JSON.stringify({ localFormat: 'txt' }),
  }
  const onlineNovel: BookshelfItem = {
    ...mdItem,
    sourceId: 'https://example.com',
    bookUrl: 'https://example.com/book/1',
    name: '在线小说',
    bookKind: 'novel',
    variable: JSON.stringify({ localFormat: 'md' }), // 非本地书绝不误归类到文档页
  }

  assert.equal(getLocalBookFormat(mdItem), 'md')
  assert.equal(getLocalBookFormat(docxItem), 'docx')
  assert.equal(getLocalBookFormat(txtItem), 'txt')
  assert.equal(getLocalBookFormat(onlineNovel), null)

  assert.equal(isDocumentItem(mdItem), true)
  assert.equal(isDocumentItem(docxItem), true)
  assert.equal(isDocumentItem(txtItem), false)
  assert.equal(isDocumentItem(onlineNovel), false)

  assert.equal(getDocumentFormat(mdItem), 'md')
  assert.equal(getDocumentFormat(docxItem), 'docx')
  assert.equal(getDocumentFormat(txtItem), null)
})

test('Documents - upload filter accepts only .md/.markdown/.docx', () => {
  assert.equal(DOCUMENT_ACCEPT_ATTR, '.md,.markdown,.docx')
  assert.equal(isSupportedDocumentFile('notes.md'), true)
  assert.equal(isSupportedDocumentFile('NOTES.MARKDOWN'), true)
  assert.equal(isSupportedDocumentFile('spec.DoCx'), true)
  assert.equal(isSupportedDocumentFile('novel.txt'), false)
  assert.equal(isSupportedDocumentFile('book.epub'), false)
  assert.equal(isSupportedDocumentFile('legacy.doc'), false)
})

test('DocumentsPage - renders empty state, upload picker, filters and populated cards safely', () => {
  const headerHtml = renderToStaticMarkup(
    React.createElement(AppHeader, {
      page: 'documents',
      settings: { ...defaultReaderSettings },
      onSettingsChange: () => undefined,
      onNavigate: () => undefined,
      onLogout: () => undefined,
    }),
  )
  assert.ok(headerHtml.includes('文档 library') === false)
  assert.ok(headerHtml.includes('class="active"'), 'documents tab should be active')
  assert.ok(headerHtml.includes('文档'), 'header should show 文档 tab')

  const emptyHtml = renderToStaticMarkup(
    React.createElement(DocumentsPage, {
      onOpen: () => undefined,
      initialItems: [],
    }),
  )
  assert.ok(emptyHtml.includes(`accept="${DOCUMENT_ACCEPT_ATTR}"`), 'upload input must restrict to MD/DOCX')
  assert.ok(emptyHtml.includes('上传 MD / DOCX'))
  assert.ok(emptyHtml.includes('还没有导入文档'))

  const items: BookshelfItem[] = [
    {
      sourceId: 'loc_book',
      bookUrl: 'local://md-doc',
      name: '设计方案',
      author: '系统架构师',
      tocUrl: 'local://md-doc/toc',
      lastReadAt: Date.now() - 120_000,
      cachedChapters: 5,
      totalChapters: 5,
      chapterIndex: 1,
      cacheState: 'ready',
      completed: false,
      bookKind: 'local',
      variable: JSON.stringify({ localFormat: 'md' }),
    },
    {
      sourceId: 'loc_book',
      bookUrl: 'local://docx-doc',
      name: '需求说明书',
      tocUrl: 'local://docx-doc/toc',
      lastReadAt: Date.now(),
      cachedChapters: 3,
      totalChapters: 3,
      cacheState: 'ready',
      completed: false,
      bookKind: 'local',
      variable: JSON.stringify({ localFormat: 'docx' }),
    },
    {
      sourceId: 'loc_book',
      bookUrl: 'local://txt-ignored',
      name: '普通TXT小说',
      tocUrl: 'local://txt-ignored/toc',
      lastReadAt: Date.now(),
      cachedChapters: 100,
      totalChapters: 100,
      cacheState: 'ready',
      completed: false,
      bookKind: 'local',
      variable: JSON.stringify({ localFormat: 'txt' }),
    },
  ]

  const populatedHtml = renderToStaticMarkup(
    React.createElement(DocumentsPage, {
      onOpen: () => undefined,
      initialItems: items,
    }),
  )
  assert.ok(populatedHtml.includes('设计方案'))
  assert.ok(populatedHtml.includes('需求说明书'))
  assert.ok(!populatedHtml.includes('普通TXT小说'), 'TXT小说绝不能混入文档页列表')
  assert.ok(populatedHtml.includes('doc-badge-md') && populatedHtml.includes('>MD<'))
  assert.ok(populatedHtml.includes('doc-badge-docx') && populatedHtml.includes('>DOCX<'))
  assert.ok(populatedHtml.includes('Markdown (1)'))
  assert.ok(populatedHtml.includes('Word (1)'))
})
