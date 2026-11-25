import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, BookshelfItem } from './api'
import {
  DOCUMENT_ACCEPT_ATTR,
  DocumentFormat,
  getDocumentFormat,
  isDocumentItem,
  isSupportedDocumentFile,
} from './documents'
import { Icon } from './icons'
import { toast } from './Toast'
import { formatDavTime } from './WebDavSettingsPage'

export type DocumentsPageProps = {
  onOpen: (item: BookshelfItem) => void
  /** 主要用于无 DOM 异步加载的单测渲染注入，生产环境留空自动从服务端拉取。 */
  initialItems?: BookshelfItem[]
}

export function DocumentsPage({ onOpen, initialItems }: DocumentsPageProps) {
  const { t } = useTranslation()
  const [items, setItems] = useState<BookshelfItem[]>(() => (initialItems ?? []).filter(isDocumentItem))
  const [loading, setLoading] = useState(() => initialItems === undefined)
  const [message, setMessage] = useState('')
  const [formatFilter, setFormatFilter] = useState<'all' | DocumentFormat>('all')
  const [keyword, setKeyword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setMessage('')
      const list = await api.bookshelf()
      setItems(list.filter(isDocumentItem))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('documents.loadFailed', '无法加载文档列表'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (initialItems !== undefined) return
    void load()
  }, [initialItems, load])

  const counts = useMemo(() => {
    let md = 0
    let docx = 0
    items.forEach(item => {
      const fmt = getDocumentFormat(item)
      if (fmt === 'md') md++
      else if (fmt === 'docx') docx++
    })
    return { all: items.length, md, docx }
  }, [items])

  const visibleItems = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return items.filter(item => {
      const fmt = getDocumentFormat(item)
      if (formatFilter !== 'all' && fmt !== formatFilter) return false
      if (!q) return true
      return (
        item.name.toLowerCase().includes(q) ||
        (item.author ?? '').toLowerCase().includes(q)
      )
    })
  }, [items, formatFilter, keyword])

  const handleUploadFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    const all = Array.from(files)
    const supported = all.filter(f => isSupportedDocumentFile(f.name))
    const rejected = all.filter(f => !isSupportedDocumentFile(f.name))

    if (supported.length === 0) {
      toast.warning(t('documents.onlyDocsAllowed', '请选择 .md、.markdown 或 .docx 格式的文档'))
      return
    }

    setUploading(true)
    toast.info(t('documents.importingToast', { count: supported.length, defaultValue: `正在解析并导入 ${supported.length} 份文档...` }))
    try {
      const resp = await api.importLocalBooks(supported)
      if (resp.imported > 0 && resp.failed === 0 && rejected.length === 0) {
        toast.success(t('documents.importSuccess', { count: resp.imported, defaultValue: `成功导入 ${resp.imported} 份文档` }))
      } else {
        const parts: string[] = []
        if (resp.imported > 0) parts.push(t('documents.importSuccess', { count: resp.imported, defaultValue: `成功导入 ${resp.imported} 份文档` }))
        if (resp.failed > 0) {
          const detail = resp.results.filter(r => !r.success).map(r => `${r.filename}: ${r.error ?? ''}`).join('; ')
          parts.push(t('documents.importFailedDetail', { count: resp.failed, error: detail, defaultValue: `失败 ${resp.failed} 份：${detail}` }))
        }
        if (rejected.length > 0) {
          parts.push(t('documents.importIgnored', { count: rejected.length, defaultValue: `已忽略 ${rejected.length} 个非 MD/DOCX 文件` }))
        }
        toast.warning(parts.join('；'))
      }
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.importFailed', '导入文档失败'))
    } finally {
      setUploading(false)
    }
  }

  const handleToggleCompleted = async (item: BookshelfItem) => {
    const key = `${item.sourceId}\u0000${item.bookUrl}`
    setBusyKey(key)
    try {
      const updated = await api.setBookshelfCompleted(item.sourceId, item.bookUrl, !item.completed)
      setItems(prev => prev.map(it => (it.sourceId === item.sourceId && it.bookUrl === item.bookUrl ? updated : it)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleReparse = async (item: BookshelfItem) => {
    const key = `${item.sourceId}\u0000${item.bookUrl}`
    setBusyKey(key)
    try {
      const res = await api.reparseLocalBooks({ sourceId: item.sourceId, bookUrl: item.bookUrl })
      if (res.reparsed > 0) {
        toast.success(t('documents.reparseSuccess', { name: item.name, chapters: res.chapters, defaultValue: `《${item.name}》已重新解析（共 ${res.chapters} 节）` }))
        await load()
      } else {
        const msg = res.items[0]?.error || t('documents.actionFailed', '操作失败')
        toast.warning(msg)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleDelete = async (item: BookshelfItem) => {
    if (!window.confirm(t('documents.deleteConfirm', { name: item.name, defaultValue: `确定删除文档《${item.name}》？将同时清除原文件与内嵌图片。` }))) {
      return
    }
    const key = `${item.sourceId}\u0000${item.bookUrl}`
    setBusyKey(key)
    try {
      await api.removeFromBookshelf(item.sourceId, item.bookUrl)
      setItems(prev => prev.filter(it => !(it.sourceId === item.sourceId && it.bookUrl === item.bookUrl)))
      toast.success(t('documents.deleted', { name: item.name, defaultValue: `已删除《${item.name}》` }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <main
      className={`page-shell docs-page${dragOver ? ' is-drag-over' : ''}`}
      onDragOver={e => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          void handleUploadFiles(e.dataTransfer.files)
        }
      }}
    >
      {dragOver && (
        <div className="docs-drop-overlay" aria-hidden="true">
          <Icon name="upload" />
          <strong>{t('documents.dropHint', '释放鼠标即可导入 Markdown / Word 文档')}</strong>
        </div>
      )}

      <header className="page-title docs-page-header">
        <div>
          <span className="section-kicker">{t('documents.kicker', '文档阅读')}</span>
          <h1>{t('documents.title', '文档')}</h1>
          <p>{t('documents.subtitle', '集中管理与阅读 Markdown (.md) 和 Word (.docx) 文档，支持富文本排版、表格、代码块与听书。')}</p>
        </div>
        <div className="docs-header-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={DOCUMENT_ACCEPT_ATTR}
            style={{ display: 'none' }}
            onChange={e => {
              if (e.target.files && e.target.files.length > 0) {
                void handleUploadFiles(e.target.files)
                e.target.value = ''
              }
            }}
          />
          <button
            type="button"
            className="shelf-import-btn"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" />
            <span>{uploading ? t('common.loading', '导入中...') : t('documents.uploadBtn', '上传 MD / DOCX')}</span>
          </button>
          <small className="docs-count">{t('documents.countLabel', { count: visibleItems.length, defaultValue: `共 ${visibleItems.length} 份` })}</small>
        </div>
      </header>

      <div className="docs-toolbar">
        <div className="docs-filter-pills" role="tablist" aria-label={t('documents.filterLabel', '文档格式筛选')}>
          <button
            type="button"
            role="tab"
            aria-selected={formatFilter === 'all'}
            className={`shelf-pill-btn${formatFilter === 'all' ? ' active' : ''}`}
            onClick={() => setFormatFilter('all')}
          >
            {t('common.all', '全部')} ({counts.all})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={formatFilter === 'md'}
            className={`shelf-pill-btn${formatFilter === 'md' ? ' active' : ''}`}
            onClick={() => setFormatFilter('md')}
          >
            Markdown ({counts.md})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={formatFilter === 'docx'}
            className={`shelf-pill-btn${formatFilter === 'docx' ? ' active' : ''}`}
            onClick={() => setFormatFilter('docx')}
          >
            Word ({counts.docx})
          </button>
        </div>

        <label className="docs-search-box">
          <Icon name="search" />
          <input
            type="search"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder={t('documents.searchPlaceholder', '搜索文档标题或作者...')}
            aria-label={t('documents.searchPlaceholder', '搜索文档标题或作者...')}
          />
          {keyword && (
            <button
              type="button"
              className="docs-search-clear"
              onClick={() => setKeyword('')}
              aria-label={t('common.clear', '清空')}
            >
              <Icon name="close" />
            </button>
          )}
        </label>
      </div>

      {message && <p className="form-error">{message}</p>}

      {loading ? (
        <section className="shelf-empty">
          <Icon name="file" />
          <p>{t('common.loading', '正在加载...')}</p>
        </section>
      ) : items.length === 0 ? (
        <section className="shelf-empty docs-empty">
          <Icon name="file" />
          <h2>{t('documents.emptyTitle', '还没有导入文档')}</h2>
          <p>{t('documents.emptyDesc', '可将 .md、.markdown 或 .docx 文档直接拖到此处，或点击下方按钮选择上传。')}</p>
          <button
            type="button"
            className="shelf-import-btn"
            style={{ marginTop: '12px' }}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" />
            <span>{t('documents.uploadBtn', '上传 MD / DOCX')}</span>
          </button>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="shelf-empty docs-empty">
          <Icon name="search" />
          <h2>{t('documents.noMatchTitle', '未找到匹配的文档')}</h2>
          <p>{t('documents.noMatchDesc', '请尝试切换格式筛选或清空搜索关键字。')}</p>
        </section>
      ) : (
        <section className="docs-grid">
          {visibleItems.map(item => {
            const fmt = getDocumentFormat(item) ?? 'md'
            const key = `${item.sourceId}\u0000${item.bookUrl}`
            const isBusy = busyKey === key
            const coverSrc = item.coverKey ? api.cover(item.coverKey) : item.coverUrl
            const total = item.totalChapters || item.cachedChapters || 0
            const cur = item.chapterIndex !== undefined ? item.chapterIndex + 1 : 0
            const progressText = cur > 0 && total > 0
              ? t('documents.progressRead', { cur, total, defaultValue: `已读 ${cur} / ${total} 节` })
              : total > 0
                ? t('documents.chapterCount', { count: total, defaultValue: `共 ${total} 节` })
                : t('documents.notReadYet', '未开始阅读')

            return (
              <article key={key} className={`doc-card${item.completed ? ' is-completed' : ''}`}>
                <div className="doc-card-main" onClick={() => onOpen(item)}>
                  <div className="doc-cover">
                    {coverSrc ? (
                      <img src={coverSrc} alt={item.name} loading="lazy" />
                    ) : (
                      <div className="doc-cover-fallback">
                        <Icon name="file" />
                      </div>
                    )}
                    <span className={`doc-badge doc-badge-${fmt}`}>
                      {fmt === 'docx' ? 'DOCX' : 'MD'}
                    </span>
                  </div>
                  <div className="doc-meta">
                    <h3 className="doc-title" title={item.name}>{item.name}</h3>
                    {item.author && <p className="doc-author">{item.author}</p>}
                    <p className="doc-progress">{progressText}</p>
                    <p className="doc-time">{formatDavTime(item.lastReadAt, Date.now(), t)}</p>
                  </div>
                </div>

                <div className="doc-actions">
                  <button
                    type="button"
                    className="primary-button doc-read-btn"
                    onClick={() => onOpen(item)}
                  >
                    {cur > 0 ? t('documents.continueRead', '继续阅读') : t('documents.startRead', '开始阅读')}
                  </button>
                  <button
                    type="button"
                    className="subtle-button"
                    disabled={isBusy}
                    onClick={() => void handleToggleCompleted(item)}
                    title={item.completed ? t('documents.markUnread', '标为未读') : t('documents.markRead', '标为已读')}
                  >
                    <Icon name="check" />
                    <span>{item.completed ? t('documents.completedLabel', '已读完') : t('documents.markRead', '标为已读')}</span>
                  </button>
                  <button
                    type="button"
                    className="subtle-button"
                    disabled={isBusy}
                    onClick={() => void handleReparse(item)}
                    title={t('documents.reparseTitle', '按保留的源文件重新解析目录与排版')}
                  >
                    <Icon name="refresh" />
                  </button>
                  <button
                    type="button"
                    className="subtle-button doc-delete-btn"
                    disabled={isBusy}
                    onClick={() => void handleDelete(item)}
                    title={t('common.delete', '删除')}
                    aria-label={t('common.delete', '删除')}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </article>
            )
          })}
        </section>
      )}
    </main>
  )
}
