import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppHeader } from '../src/AppHeader'
import { defaultReaderSettings } from '../src/readerSettings'
import type { BookshelfItem, DocFolder } from '../src/api'
import {
  buildFolderTree,
  DOC_VIEW_ALL,
  DOC_VIEW_UNFILED,
  DOCUMENT_ACCEPT_ATTR,
  filterDocumentsBySelection,
  flattenFoldersForSelect,
  getDocumentFolderId,
  getDocumentFormat,
  getFolderBreadcrumb,
  getFolderDisplayPath,
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
  assert.ok(!populatedHtml.includes('doc-cover'), '文档卡片不得再渲染冗余封面区域')
  assert.ok(populatedHtml.includes('docs-sidebar'), '应包含左侧竖向资源管理器')
  assert.ok(populatedHtml.includes('shelf-btn-read'), '主阅读按钮应复用书架风格类')
  assert.ok(populatedHtml.includes('shelf-btn-manage'), '更多操作按钮应复用书架风格类')
  assert.ok(populatedHtml.includes('doc-badge-md') && populatedHtml.includes('>MD<'))
  assert.ok(populatedHtml.includes('doc-badge-docx') && populatedHtml.includes('>DOCX<'))
  assert.ok(populatedHtml.includes('Markdown (1)'))
  assert.ok(populatedHtml.includes('Word (1)'))
})

test('Documents - folder tree building, breadcrumbs, selection filtering and cycle safety', () => {
  const folders: DocFolder[] = [
    { id: 'f-root', name: '历史档案', parentId: null, sortOrder: 0, createdAt: 10 },
    { id: 'f-sub', name: '1972-1978', parentId: 'f-root', sortOrder: 0, createdAt: 20 },
    { id: 'f-leaf', name: '第五章', parentId: 'f-sub', sortOrder: 0, createdAt: 30 },
    { id: 'f-other', name: '技术专栏', parentId: null, sortOrder: 1, createdAt: 40 },
  ]
  const base: BookshelfItem = {
    sourceId: 'loc_book',
    bookUrl: 'local://1',
    name: 'doc',
    tocUrl: 'local://1/toc',
    lastReadAt: Date.now(),
    cachedChapters: 2,
    totalChapters: 2,
    cacheState: 'ready',
    completed: false,
    bookKind: 'local',
    variable: JSON.stringify({ localFormat: 'md' }),
  }
  const items: BookshelfItem[] = [
    { ...base, bookUrl: 'local://d1', name: '逐段细纲', variable: JSON.stringify({ localFormat: 'md', docFolderId: 'f-leaf' }) },
    { ...base, bookUrl: 'local://d2', name: '年表汇总', variable: JSON.stringify({ localFormat: 'docx', docFolderId: 'f-root' }) },
    { ...base, bookUrl: 'local://d3', name: '未归档笔记', variable: JSON.stringify({ localFormat: 'md' }) },
    { ...base, bookUrl: 'local://d4', name: '孤儿目录文档', variable: JSON.stringify({ localFormat: 'md', docFolderId: 'missing-id' }) },
    { ...base, bookUrl: 'local://txt', name: '普通小说', variable: JSON.stringify({ localFormat: 'txt', docFolderId: 'f-root' }) },
  ]

  assert.equal(getDocumentFolderId(items[0]), 'f-leaf')
  assert.equal(getDocumentFolderId(items[2]), null)
  assert.equal(getDocumentFolderId({ variable: '{broken' }), null)

  const tree = buildFolderTree(folders, items)
  assert.equal(tree.roots.length, 2)
  assert.equal(tree.unfiledDocs.length, 2) // 未归档笔记 + 孤儿目录文档，不含 TXT
  assert.equal(tree.nodeMap.get('f-root')?.totalDocCount, 2) // 直属 d2 + 子树 d1
  assert.equal(tree.nodeMap.get('f-leaf')?.directDocs.length, 1)

  const crumb = getFolderBreadcrumb(folders, 'f-leaf')
  assert.deepEqual(crumb.map(f => f.name), ['历史档案', '1972-1978', '第五章'])
  assert.equal(getFolderDisplayPath(folders, 'f-leaf'), '历史档案 / 1972-1978 / 第五章')

  assert.equal(filterDocumentsBySelection(items, folders, DOC_VIEW_ALL).length, 4)
  assert.equal(filterDocumentsBySelection(items, folders, DOC_VIEW_UNFILED).length, 2)
  assert.deepEqual(filterDocumentsBySelection(items, folders, 'f-leaf').map(i => i.name), ['逐段细纲'])
  assert.deepEqual(filterDocumentsBySelection(items, folders, 'nonexistent'), [])

  const flat = flattenFoldersForSelect(folders)
  assert.deepEqual(flat.map(o => [o.name, o.depth]), [
    ['历史档案', 0],
    ['1972-1978', 1],
    ['第五章', 2],
    ['技术专栏', 0],
  ])

  // 异常成环目录防死循环
  const cyclic: DocFolder[] = [
    { id: 'a', name: 'A', parentId: 'b' },
    { id: 'b', name: 'B', parentId: 'a' },
  ]
  const cyclicCrumb = getFolderBreadcrumb(cyclic, 'a')
  assert.ok(cyclicCrumb.length <= 2)
  const cyclicTree = buildFolderTree(cyclic, [])
  assert.ok(cyclicTree.roots.length >= 1)

  // SSR 渲染带目录树和文件夹归属的文档页
  const treeHtml = renderToStaticMarkup(
    React.createElement(DocumentsPage, {
      onOpen: () => undefined,
      initialItems: items,
      initialFolders: folders,
    }),
  )
  assert.ok(treeHtml.includes('历史档案'))
  assert.ok(treeHtml.includes('1972-1978'))
  assert.ok(treeHtml.includes('docs-tree-file'), '展开的文件夹下应列出可直接点击打开的文档文件')
  assert.ok(treeHtml.includes('doc-folder-pill'), '已归类文档卡片应展示所属文件夹标签')
})
