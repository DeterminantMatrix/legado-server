import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, BookshelfItem, DocFolder } from './api'
import {
  buildFolderTree,
  DOC_VIEW_ALL,
  DOC_VIEW_UNFILED,
  DocFolderNode,
  DOCUMENT_ACCEPT_ATTR,
  DocumentFormat,
  filterDocumentsBySelection,
  flattenFoldersForSelect,
  getDocumentFolderId,
  getDocumentFormat,
  getFolderBreadcrumb,
  getFolderDisplayPath,
  isDocumentItem,
  isSupportedDocumentFile,
} from './documents'
import { Icon } from './icons'
import { toast } from './Toast'
import { formatDavTime } from './WebDavSettingsPage'

const DRAG_DOC_MIME = 'application/x-legado-doc'

type DragDocRef = { sourceId: string; bookUrl: string }

export type DocumentsPageProps = {
  onOpen: (item: BookshelfItem) => void
  /** 主要用于无 DOM 异步加载的单测渲染注入，生产环境留空自动从服务端拉取。 */
  initialItems?: BookshelfItem[]
  /** 单测注入初始文件夹树；传入 `initialItems` 时默认不触发网络请求。 */
  initialFolders?: DocFolder[]
}

type FolderModalState =
  | { type: 'create'; parentId: string | null; name: string }
  | { type: 'rename'; folder: DocFolder; name: string }
  | { type: 'move'; items: DragDocRef[]; label: string; targetFolderId: string | null }

export function DocumentsPage({ onOpen, initialItems, initialFolders }: DocumentsPageProps) {
  const { t } = useTranslation()
  const [items, setItems] = useState<BookshelfItem[]>(() => (initialItems ?? []).filter(isDocumentItem))
  const [folders, setFolders] = useState<DocFolder[]>(() => initialFolders ?? [])
  const [loading, setLoading] = useState(() => initialItems === undefined)
  const [message, setMessage] = useState('')
  const [selectedView, setSelectedView] = useState<string>(DOC_VIEW_ALL)
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => {
    const init = new Set<string>()
    for (const f of initialFolders ?? []) init.add(f.id)
    return init
  })
  const [formatFilter, setFormatFilter] = useState<'all' | DocumentFormat>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'reading' | 'completed'>('all')
  const [keyword, setKeyword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [dragTargetView, setDragTargetView] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false)
  const [modal, setModal] = useState<FolderModalState | null>(null)
  const [modalBusy, setModalBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const explorerHydratedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      setMessage('')
      const [shelfList, folderList] = await Promise.all([
        api.bookshelf(),
        api.docFolders().catch(() => [] as DocFolder[]),
      ])
      setItems(shelfList.filter(isDocumentItem))
      setFolders(folderList)
      if (!explorerHydratedRef.current) {
        explorerHydratedRef.current = true
        setExpandedFolderIds(new Set(folderList.map(f => f.id)))
      }
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

  // 若选中的文件夹被删除或不存在，安全退回全部文档
  useEffect(() => {
    if (selectedView !== DOC_VIEW_ALL && selectedView !== DOC_VIEW_UNFILED) {
      if (!folders.some(f => f.id === selectedView)) {
        setSelectedView(DOC_VIEW_ALL)
      }
    }
  }, [folders, selectedView])

  // 点击页面空白处或按下 Esc 时关闭卡片更多菜单或弹窗
  useEffect(() => {
    if (!openMenuKey) return
    const onDocClick = () => setOpenMenuKey(null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuKey(null)
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenuKey])

  useEffect(() => {
    if (!modal) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modalBusy) setModal(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [modal, modalBusy])

  const treeData = useMemo(() => buildFolderTree(folders, items), [folders, items])
  const breadcrumb = useMemo(() => {
    if (selectedView === DOC_VIEW_ALL || selectedView === DOC_VIEW_UNFILED) return []
    return getFolderBreadcrumb(folders, selectedView)
  }, [folders, selectedView])

  const currentFolder = useMemo(
    () => (selectedView !== DOC_VIEW_ALL && selectedView !== DOC_VIEW_UNFILED
      ? folders.find(f => f.id === selectedView) ?? null
      : null),
    [folders, selectedView],
  )

  const currentSubfolders = useMemo(() => {
    if (!currentFolder) return []
    return treeData.nodeMap.get(currentFolder.id)?.children ?? []
  }, [currentFolder, treeData])

  const folderScopedItems = useMemo(
    () => filterDocumentsBySelection(items, folders, selectedView),
    [items, folders, selectedView],
  )

  const counts = useMemo(() => {
    let md = 0
    let docx = 0
    let reading = 0
    let completed = 0
    for (const item of folderScopedItems) {
      const fmt = getDocumentFormat(item)
      if (fmt === 'md') md++
      else if (fmt === 'docx') docx++
      if (item.completed) completed++
      else reading++
    }
    return { all: folderScopedItems.length, md, docx, reading, completed }
  }, [folderScopedItems])

  const visibleItems = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return folderScopedItems.filter(item => {
      const fmt = getDocumentFormat(item)
      if (formatFilter !== 'all' && fmt !== formatFilter) return false
      if (statusFilter === 'completed' && !item.completed) return false
      if (statusFilter === 'reading' && item.completed) return false
      if (!q) return true
      return (
        item.name.toLowerCase().includes(q) ||
        (item.author ?? '').toLowerCase().includes(q)
      )
    })
  }, [folderScopedItems, formatFilter, statusFilter, keyword])

  const folderSelectOptions = useMemo(() => flattenFoldersForSelect(folders), [folders])

  const toggleExpandFolder = (folderId: string) => {
    setExpandedFolderIds(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const expandFolderChain = (folderId: string | null) => {
    if (!folderId) return
    const crumb = getFolderBreadcrumb(folders, folderId)
    setExpandedFolderIds(prev => {
      const next = new Set(prev)
      next.add(folderId)
      for (const f of crumb) next.add(f.id)
      return next
    })
  }

  const selectView = (view: string, keepOpenOnMobile = false) => {
    setSelectedView(view)
    if (view !== DOC_VIEW_ALL && view !== DOC_VIEW_UNFILED) {
      setExpandedFolderIds(prev => {
        const next = new Set(prev)
        next.add(view)
        return next
      })
    }
    setSelectedKeys(new Set())
    if (!keepOpenOnMobile) setMobileExplorerOpen(false)
  }

  const activeUploadFolderId =
    selectedView !== DOC_VIEW_ALL && selectedView !== DOC_VIEW_UNFILED ? selectedView : null

  const handleUploadFiles = async (files: FileList | File[] | null, targetFolderId: string | null = activeUploadFolderId) => {
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
      const resp = await api.importLocalBooks(supported, targetFolderId)
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
      if (targetFolderId) expandFolderChain(targetFolderId)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.importFailed', '导入文档失败'))
    } finally {
      setUploading(false)
    }
  }

  const updateLocalItemFolderId = (refs: DragDocRef[], folderId: string | null) => {
    const keySet = new Set(refs.map(r => `${r.sourceId}\u0000${r.bookUrl}`))
    setItems(prev => prev.map(it => {
      const k = `${it.sourceId}\u0000${it.bookUrl}`
      if (!keySet.has(k)) return it
      let vars: Record<string, unknown> = {}
      try {
        if (it.variable) vars = JSON.parse(it.variable) as Record<string, unknown>
      } catch {
        vars = {}
      }
      if (folderId) vars.docFolderId = folderId
      else delete vars.docFolderId
      return { ...it, variable: Object.keys(vars).length > 0 ? JSON.stringify(vars) : undefined }
    }))
  }

  const handleMoveDocuments = async (refs: DragDocRef[], folderId: string | null) => {
    if (refs.length === 0) return
    try {
      await api.assignDocumentsFolder(refs, folderId)
      updateLocalItemFolderId(refs, folderId)
      const folderName = folderId
        ? folders.find(f => f.id === folderId)?.name ?? ''
        : t('documents.unfiledDocs', '未归类')
      toast.success(t('documents.moveSuccess', { folder: folderName, defaultValue: `已将文档移入「${folderName}」` }))
      if (folderId) expandFolderChain(folderId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
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

  const handleDeleteFolder = async (folder: DocFolder) => {
    if (!window.confirm(t('documents.folderDeleteConfirm', {
      name: folder.name,
      defaultValue: `确定删除文件夹「${folder.name}」及其子文件夹？其中的文档不会被删除，将自动移回上级目录或「未归类」。`,
    }))) {
      return
    }
    try {
      const res = await api.deleteDocFolder(folder.id)
      const deletedSet = new Set(res.deletedFolderIds)
      if (deletedSet.has(selectedView)) {
        setSelectedView(folder.parentId ?? DOC_VIEW_ALL)
      }
      toast.success(t('documents.folderDeleted', { name: folder.name, defaultValue: `已删除文件夹「${folder.name}」` }))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    }
  }

  const submitModal = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!modal || modalBusy) return

    if (modal.type === 'create') {
      const trimmed = modal.name.trim()
      if (!trimmed) {
        toast.warning(t('documents.folderNameEmpty', '文件夹名称不能为空'))
        return
      }
      setModalBusy(true)
      try {
        const created = await api.createDocFolder(trimmed, modal.parentId)
        toast.success(t('documents.folderCreated', { name: created.name, defaultValue: `已创建文件夹「${created.name}」` }))
        setFolders(prev => [...prev, created])
        setExpandedFolderIds(prev => {
          const next = new Set(prev)
          next.add(created.id)
          if (modal.parentId) next.add(modal.parentId)
          return next
        })
        setSelectedView(created.id)
        setModal(null)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
      } finally {
        setModalBusy(false)
      }
      return
    }

    if (modal.type === 'rename') {
      const trimmed = modal.name.trim()
      if (!trimmed) {
        toast.warning(t('documents.folderNameEmpty', '文件夹名称不能为空'))
        return
      }
      setModalBusy(true)
      try {
        const updated = await api.updateDocFolder(modal.folder.id, { name: trimmed })
        setFolders(prev => prev.map(f => (f.id === updated.id ? updated : f)))
        toast.success(t('documents.folderRenamed', { name: updated.name, defaultValue: `文件夹已重命名为「${updated.name}」` }))
        setModal(null)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
      } finally {
        setModalBusy(false)
      }
      return
    }

    if (modal.type === 'move') {
      setModalBusy(true)
      try {
        await handleMoveDocuments(modal.items, modal.targetFolderId)
        setSelectedKeys(new Set())
        setModal(null)
      } finally {
        setModalBusy(false)
      }
    }
  }

  // 批量操作
  const selectedRefs: DragDocRef[] = useMemo(() => {
    const out: DragDocRef[] = []
    for (const item of items) {
      const key = `${item.sourceId}\u0000${item.bookUrl}`
      if (selectedKeys.has(key)) out.push({ sourceId: item.sourceId, bookUrl: item.bookUrl })
    }
    return out
  }, [items, selectedKeys])

  const toggleSelectKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleBatchCompleted = async (completed: boolean) => {
    if (selectedRefs.length === 0) return
    try {
      await api.batchBookshelf({ action: 'mark_completed', items: selectedRefs, completed })
      const keySet = new Set(selectedRefs.map(r => `${r.sourceId}\u0000${r.bookUrl}`))
      setItems(prev => prev.map(it => (keySet.has(`${it.sourceId}\u0000${it.bookUrl}`) ? { ...it, completed } : it)))
      toast.success(t('documents.batchCompletedUpdated', '已批量更新阅读状态'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedRefs.length === 0) return
    if (!window.confirm(t('documents.batchDeleteConfirm', {
      count: selectedRefs.length,
      defaultValue: `确定删除选中的 ${selectedRefs.length} 份文档？原文件与内嵌图片将一并清除。`,
    }))) {
      return
    }
    try {
      await api.batchBookshelf({ action: 'delete', items: selectedRefs })
      const keySet = new Set(selectedRefs.map(r => `${r.sourceId}\u0000${r.bookUrl}`))
      setItems(prev => prev.filter(it => !keySet.has(`${it.sourceId}\u0000${it.bookUrl}`)))
      toast.success(t('documents.batchDeleted', { count: selectedRefs.length, defaultValue: `已删除 ${selectedRefs.length} 份文档` }))
      setSelectedKeys(new Set())
      setBatchMode(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('documents.actionFailed', '操作失败'))
    }
  }

  // 拖拽接收辅助（同时支持从本机拖文件到指定文件夹 & 从界面拖文档卡/树文件到文件夹）
  const readDragDocRefs = (dataTransfer: DataTransfer): DragDocRef[] | null => {
    const raw = dataTransfer.getData(DRAG_DOC_MIME)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as DragDocRef[]
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
    } catch {
      return null
    }
  }

  const handleTargetDragOver = (e: React.DragEvent, targetKey: string) => {
    const hasDoc = e.dataTransfer?.types?.includes(DRAG_DOC_MIME)
    const hasFiles = e.dataTransfer?.types?.includes('Files')
    if (!hasDoc && !hasFiles) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = hasDoc ? 'move' : 'copy'
    if (dragTargetView !== targetKey) setDragTargetView(targetKey)
  }

  const handleTargetDrop = (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    setDragTargetView(null)
    setDragOver(false)
    const refs = readDragDocRefs(e.dataTransfer)
    if (refs) {
      void handleMoveDocuments(refs, targetFolderId)
      return
    }
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void handleUploadFiles(e.dataTransfer.files, targetFolderId)
    }
  }

  const renderTreeFile = (item: BookshelfItem, depth: number) => {
    const fmt = getDocumentFormat(item) ?? 'md'
    const key = `${item.sourceId}\u0000${item.bookUrl}`
    return (
      <div
        key={`tree-file-${key}`}
        className="docs-tree-file"
        style={{ paddingLeft: `${12 + depth * 16 + 18}px` }}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(DRAG_DOC_MIME, JSON.stringify([{ sourceId: item.sourceId, bookUrl: item.bookUrl }]))
        }}
        onClick={() => {
          setMobileExplorerOpen(false)
          onOpen(item)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setMobileExplorerOpen(false)
            onOpen(item)
          }
        }}
        title={item.name}
      >
        <Icon name="file" className="docs-tree-file-icon" />
        <span className="docs-tree-label">{item.name}</span>
        <span className={`docs-tree-ext doc-badge-${fmt}`}>{fmt === 'docx' ? 'DOCX' : 'MD'}</span>
      </div>
    )
  }

  const renderFolderBranch = (node: DocFolderNode, depth: number): React.ReactNode => {
    const isExpanded = expandedFolderIds.has(node.folder.id)
    const isActive = selectedView === node.folder.id
    const isDropOver = dragTargetView === node.folder.id
    const hasInner = node.children.length > 0 || node.directDocs.length > 0

    return (
      <div key={node.folder.id} className="docs-tree-branch">
        <div
          className={`docs-tree-row${isActive ? ' active' : ''}${isDropOver ? ' drop-over' : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          role="treeitem"
          aria-expanded={isExpanded}
          aria-selected={isActive}
          onClick={() => selectView(node.folder.id)}
          onDragOver={e => handleTargetDragOver(e, node.folder.id)}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragTargetView(prev => (prev === node.folder.id ? null : prev))
            }
          }}
          onDrop={e => handleTargetDrop(e, node.folder.id)}
        >
          <button
            type="button"
            className={`docs-tree-chevron${hasInner ? '' : ' is-empty'}`}
            onClick={e => {
              e.stopPropagation()
              toggleExpandFolder(node.folder.id)
            }}
            aria-label={isExpanded ? t('documents.collapseAll', '折叠') : t('documents.expandAll', '展开')}
          >
            <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} />
          </button>
          <Icon name={isExpanded ? 'folderOpen' : 'folder'} className="docs-tree-folder-icon" />
          <span className="docs-tree-label" title={node.folder.name}>{node.folder.name}</span>
          <small className="docs-tree-count">{node.totalDocCount}</small>
          <div className="docs-tree-row-actions" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="docs-tree-icon-btn"
              title={t('documents.newSubfolder', '新建子文件夹')}
              aria-label={t('documents.newSubfolder', '新建子文件夹')}
              onClick={() => setModal({ type: 'create', parentId: node.folder.id, name: '' })}
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="docs-tree-icon-btn"
              title={t('documents.renameFolder', '重命名文件夹')}
              aria-label={t('documents.renameFolder', '重命名文件夹')}
              onClick={() => setModal({ type: 'rename', folder: node.folder, name: node.folder.name })}
            >
              <Icon name="edit" />
            </button>
            <button
              type="button"
              className="docs-tree-icon-btn danger"
              title={t('documents.deleteFolder', '删除文件夹')}
              aria-label={t('documents.deleteFolder', '删除文件夹')}
              onClick={() => void handleDeleteFolder(node.folder)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
        {isExpanded && (
          <div className="docs-tree-children" role="group">
            {node.children.map(child => renderFolderBranch(child, depth + 1))}
            {node.directDocs.map(doc => renderTreeFile(doc, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const allExpanded = folders.length > 0 && folders.every(f => expandedFolderIds.has(f.id))
  const unfiledExpanded = expandedFolderIds.has(DOC_VIEW_UNFILED)

  return (
    <main
      className={`docs-page${dragOver ? ' drag-active' : ''}`}
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
        if (readDragDocRefs(e.dataTransfer)) return
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          void handleUploadFiles(e.dataTransfer.files, activeUploadFolderId)
        }
      }}
    >
      {dragOver && (
        <div className="docs-drop-overlay" aria-hidden="true">
          <Icon name="upload" />
          <strong>{t('documents.dropHint', '释放鼠标即可导入 Markdown / Word 文档')}</strong>
        </div>
      )}

      {mobileExplorerOpen && (
        <div
          className="docs-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileExplorerOpen(false)}
        />
      )}

      <div className="docs-workspace">
        {/* 最左侧竖向资源管理器 */}
        <aside
          className={`docs-sidebar${mobileExplorerOpen ? ' is-open' : ''}`}
          aria-label={t('documents.explorerTitle', '资源管理器')}
        >
          <div className="docs-sidebar-header">
            <span className="docs-sidebar-title">{t('documents.explorerTitle', '资源管理器')}</span>
            <div className="docs-sidebar-tools">
              <button
                type="button"
                className="docs-tree-icon-btn"
                title={t('documents.newFolder', '新建文件夹')}
                aria-label={t('documents.newFolder', '新建文件夹')}
                onClick={() => setModal({ type: 'create', parentId: null, name: '' })}
              >
                <Icon name="folderPlus" />
              </button>
              {folders.length > 0 && (
                <button
                  type="button"
                  className="docs-tree-icon-btn"
                  title={allExpanded ? t('documents.collapseAll', '折叠全部') : t('documents.expandAll', '展开全部')}
                  aria-label={allExpanded ? t('documents.collapseAll', '折叠全部') : t('documents.expandAll', '展开全部')}
                  onClick={() => {
                    if (allExpanded) setExpandedFolderIds(new Set())
                    else setExpandedFolderIds(new Set(folders.map(f => f.id)))
                  }}
                >
                  <Icon name={allExpanded ? 'chevronDown' : 'chevronRight'} />
                </button>
              )}
              <button
                type="button"
                className="docs-tree-icon-btn docs-sidebar-close"
                title={t('common.close', '关闭')}
                aria-label={t('common.close', '关闭')}
                onClick={() => setMobileExplorerOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
          </div>

          <nav className="docs-tree" role="tree" aria-label={t('documents.explorerTitle', '资源管理器')}>
            <div
              className={`docs-tree-row docs-tree-root${selectedView === DOC_VIEW_ALL ? ' active' : ''}`}
              role="treeitem"
              aria-selected={selectedView === DOC_VIEW_ALL}
              onClick={() => selectView(DOC_VIEW_ALL)}
            >
              <Icon name="book" className="docs-tree-folder-icon" />
              <span className="docs-tree-label">{t('documents.allDocs', '全部文档')}</span>
              <small className="docs-tree-count">{items.length}</small>
            </div>

            <div className="docs-tree-branch">
              <div
                className={`docs-tree-row${selectedView === DOC_VIEW_UNFILED ? ' active' : ''}${dragTargetView === DOC_VIEW_UNFILED ? ' drop-over' : ''}`}
                role="treeitem"
                aria-expanded={unfiledExpanded}
                aria-selected={selectedView === DOC_VIEW_UNFILED}
                onClick={() => selectView(DOC_VIEW_UNFILED)}
                onDragOver={e => handleTargetDragOver(e, DOC_VIEW_UNFILED)}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragTargetView(prev => (prev === DOC_VIEW_UNFILED ? null : prev))
                  }
                }}
                onDrop={e => handleTargetDrop(e, null)}
              >
                <button
                  type="button"
                  className={`docs-tree-chevron${treeData.unfiledDocs.length > 0 ? '' : ' is-empty'}`}
                  onClick={e => {
                    e.stopPropagation()
                    toggleExpandFolder(DOC_VIEW_UNFILED)
                  }}
                  aria-label={unfiledExpanded ? t('documents.collapseAll', '折叠') : t('documents.expandAll', '展开')}
                >
                  <Icon name={unfiledExpanded ? 'chevronDown' : 'chevronRight'} />
                </button>
                <Icon name="file" className="docs-tree-folder-icon" />
                <span className="docs-tree-label">{t('documents.unfiledDocs', '未归类')}</span>
                <small className="docs-tree-count">{treeData.unfiledDocs.length}</small>
              </div>
              {unfiledExpanded && treeData.unfiledDocs.length > 0 && (
                <div className="docs-tree-children" role="group">
                  {treeData.unfiledDocs.map(doc => renderTreeFile(doc, 0))}
                </div>
              )}
            </div>

            {treeData.roots.map(root => renderFolderBranch(root, 0))}
          </nav>
        </aside>

        {/* 右侧文档主界面（风格向书架对齐） */}
        <div className="docs-main">
          <header className="page-title shelf-page-header docs-page-header">
            <div>
              <span className="section-kicker">{t('documents.kicker', '文档阅读')}</span>
              <h1>{t('documents.title', '文档')}</h1>
              <p>{t('documents.subtitle', '集中管理与阅读 Markdown (.md) 和 Word (.docx) 文档，支持富文本排版、表格、代码块与听书。')}</p>
            </div>
            <div className="shelf-header-actions">
              <button
                type="button"
                className="shelf-import-btn docs-explorer-toggle"
                onClick={() => setMobileExplorerOpen(true)}
              >
                <Icon name="folder" />
                <span>{t('documents.toggleExplorer', '目录树')}</span>
              </button>
              <button
                type="button"
                className="shelf-import-btn"
                onClick={() => setModal({ type: 'create', parentId: activeUploadFolderId, name: '' })}
              >
                <Icon name="folderPlus" />
                <span>{activeUploadFolderId ? t('documents.newSubfolder', '新建子文件夹') : t('documents.newFolder', '新建文件夹')}</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={DOCUMENT_ACCEPT_ATTR}
                style={{ display: 'none' }}
                onChange={e => {
                  if (e.target.files && e.target.files.length > 0) {
                    void handleUploadFiles(e.target.files, activeUploadFolderId)
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
              <small>{t('documents.countLabel', { count: visibleItems.length, defaultValue: `共 ${visibleItems.length} 份` })}</small>
              <button
                type="button"
                className={`shelf-batch-toggle-btn ${batchMode ? 'active' : ''}`}
                onClick={() => {
                  if (batchMode) {
                    setBatchMode(false)
                    setSelectedKeys(new Set())
                  } else {
                    setBatchMode(true)
                  }
                }}
              >
                <Icon name={batchMode ? 'check' : 'list'} />
                {batchMode ? t('common.ok', '完成') : t('shelf.batchManage', '批量管理')}
              </button>
            </div>
          </header>

          {/* 路径面包屑栏（对齐书架 Tabs 下划线节奏） */}
          <nav className="docs-breadcrumb" aria-label={t('documents.explorerTitle', '资源管理器')}>
            <button
              type="button"
              className={`docs-crumb-btn${selectedView === DOC_VIEW_ALL ? ' active' : ''}`}
              onClick={() => selectView(DOC_VIEW_ALL)}
            >
              {t('documents.allDocs', '全部文档')}
            </button>
            {selectedView === DOC_VIEW_UNFILED ? (
              <>
                <span className="docs-crumb-sep">/</span>
                <span className="docs-crumb-btn active">{t('documents.unfiledDocs', '未归类')}</span>
              </>
            ) : (
              breadcrumb.map((f, idx) => (
                <React.Fragment key={f.id}>
                  <span className="docs-crumb-sep">/</span>
                  <button
                    type="button"
                    className={`docs-crumb-btn${idx === breadcrumb.length - 1 ? ' active' : ''}`}
                    onClick={() => selectView(f.id)}
                  >
                    {f.name}
                  </button>
                </React.Fragment>
              ))
            )}
          </nav>

          {/* 次级筛选与搜索行（对齐 shelf-subfilter-bar） */}
          <div className="shelf-subfilter-bar docs-toolbar">
            <div className="docs-filter-group">
              <div className="shelf-status-pills" role="tablist" aria-label={t('documents.filterLabel', '文档格式筛选')}>
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

              <div className="shelf-status-pills">
                <button
                  type="button"
                  className={`shelf-pill-btn${statusFilter === 'all' ? ' active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  {t('common.all', '全部')}
                </button>
                <button
                  type="button"
                  className={`shelf-pill-btn${statusFilter === 'reading' ? ' active' : ''}`}
                  onClick={() => setStatusFilter('reading')}
                >
                  {t('documents.statusReading', '在读')} ({counts.reading})
                </button>
                <button
                  type="button"
                  className={`shelf-pill-btn${statusFilter === 'completed' ? ' active' : ''}`}
                  onClick={() => setStatusFilter('completed')}
                >
                  {t('documents.statusCompleted', '已读完')} ({counts.completed})
                </button>
              </div>
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

          {/* 当前文件夹下包含子文件夹时展示直接子目录快捷条 */}
          {currentSubfolders.length > 0 && (
            <section className="docs-subfolders" aria-label={t('documents.subfoldersLabel', '子文件夹')}>
              {currentSubfolders.map(sub => {
                const isDropOver = dragTargetView === sub.folder.id
                return (
                  <button
                    key={sub.folder.id}
                    type="button"
                    className={`docs-subfolder-chip${isDropOver ? ' drop-over' : ''}`}
                    onClick={() => selectView(sub.folder.id)}
                    onDragOver={e => handleTargetDragOver(e, sub.folder.id)}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragTargetView(prev => (prev === sub.folder.id ? null : prev))
                      }
                    }}
                    onDrop={e => handleTargetDrop(e, sub.folder.id)}
                  >
                    <Icon name="folder" />
                    <span className="docs-subfolder-name">{sub.folder.name}</span>
                    <small>{sub.totalDocCount}</small>
                  </button>
                )
              })}
            </section>
          )}

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
          ) : folderScopedItems.length === 0 ? (
            <section className="shelf-empty docs-empty">
              <Icon name="folder" />
              <h2>
                {selectedView === DOC_VIEW_UNFILED
                  ? t('documents.unfiledEmptyTitle', '没有未归类的文档')
                  : t('documents.folderEmptyTitle', '这个文件夹还是空的')}
              </h2>
              <p>
                {selectedView === DOC_VIEW_UNFILED
                  ? t('documents.unfiledEmptyDesc', '所有文档都已整理进文件夹中，也可以直接拖放本地文件到这里。')
                  : t('documents.folderEmptyDesc', '可以直接将本地文档拖入这里，或从其他文件夹把文档拖拽进来。')}
              </p>
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
                const isSelected = selectedKeys.has(key)
                const menuOpen = openMenuKey === key
                const itemFolderId = getDocumentFolderId(item)
                const itemFolderPath = getFolderDisplayPath(folders, itemFolderId)
                const total = item.totalChapters || item.cachedChapters || 0
                const cur = item.chapterIndex !== undefined ? item.chapterIndex + 1 : 0
                const progressPercent = total > 0 && cur > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0
                const progressText = item.completed
                  ? t('documents.completedLabel', '已读完')
                  : cur > 0 && total > 0
                    ? t('documents.progressRead', { cur, total, defaultValue: `已读 ${cur} / ${total} 节` })
                    : total > 0
                      ? t('documents.chapterCount', { count: total, defaultValue: `共 ${total} 节` })
                      : t('documents.notReadYet', '未开始阅读')

                return (
                  <article
                    key={key}
                    className={`doc-card${item.completed ? ' is-completed' : ''}${batchMode ? ' batch-selectable' : ''}${isSelected ? ' selected' : ''}`}
                    draggable={!batchMode}
                    onDragStart={e => {
                      if (batchMode) return
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData(DRAG_DOC_MIME, JSON.stringify([{ sourceId: item.sourceId, bookUrl: item.bookUrl }]))
                    }}
                    onClick={batchMode ? () => toggleSelectKey(key) : undefined}
                  >
                    {/* 无封面紧凑顶部行：文件图标 + 所属文件夹徽签 + MD/DOCX 角标 */}
                    <div className="doc-card-head">
                      <div className="doc-card-head-left">
                        {batchMode ? (
                          <span className={`doc-card-checkbox${isSelected ? ' checked' : ''}`}>
                            {isSelected && <Icon name="check" />}
                          </span>
                        ) : (
                          <span className={`doc-kind-icon doc-kind-${fmt}`} aria-hidden="true">
                            <Icon name="file" />
                          </span>
                        )}
                        {itemFolderId && itemFolderPath ? (
                          <button
                            type="button"
                            className="shelf-card-group-tag doc-folder-pill"
                            title={itemFolderPath}
                            onClick={e => {
                              e.stopPropagation()
                              if (!batchMode) selectView(itemFolderId)
                            }}
                          >
                            {itemFolderPath}
                          </button>
                        ) : null}
                      </div>
                      <span className={`doc-badge doc-badge-${fmt}`}>
                        {fmt === 'docx' ? 'DOCX' : 'MD'}
                      </span>
                    </div>

                    {/* 中部信息：标题、作者、阅读进度与时间 */}
                    <div
                      className="doc-card-body"
                      onClick={batchMode ? undefined : () => onOpen(item)}
                      role={batchMode ? undefined : 'button'}
                      tabIndex={batchMode ? undefined : 0}
                      onKeyDown={batchMode ? undefined : e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(item)
                        }
                      }}
                    >
                      <h3 className="doc-title" title={item.name}>{item.name}</h3>
                      {item.author && <p className="doc-author">{item.author}</p>}
                      <div className="doc-meta-row">
                        <span className={`shelf-meta-chapter${item.completed ? ' completed' : ''}`}>{progressText}</span>
                        <span className="doc-time">{formatDavTime(item.lastReadAt, Date.now(), t)}</span>
                      </div>
                      {progressPercent > 0 && !item.completed && (
                        <div className="doc-progress-track" aria-hidden="true">
                          <div className="doc-progress-fill" style={{ width: `${progressPercent}%` }} />
                        </div>
                      )}
                    </div>

                    {/* 底部操作栏：100% 复用书架按钮体系 */}
                    {!batchMode && (
                      <div className="shelf-card-footer doc-card-footer">
                        <button type="button" className="shelf-btn-read" onClick={() => onOpen(item)}>
                          {item.completed
                            ? t('documents.reRead', '重新阅读')
                            : cur > 0
                              ? t('documents.continueRead', '继续阅读')
                              : t('documents.startRead', '开始阅读')}
                        </button>
                        <div className="doc-more-wrap" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            className="shelf-btn-manage"
                            disabled={isBusy}
                            aria-label={t('documents.moreActions', '更多操作')}
                            title={t('documents.moreActions', '更多操作')}
                            aria-expanded={menuOpen}
                            onClick={() => setOpenMenuKey(menuOpen ? null : key)}
                          >
                            <Icon name="more" />
                          </button>
                          {menuOpen && (
                            <div className="doc-more-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenMenuKey(null)
                                  setModal({
                                    type: 'move',
                                    items: [{ sourceId: item.sourceId, bookUrl: item.bookUrl }],
                                    label: item.name,
                                    targetFolderId: itemFolderId,
                                  })
                                }}
                              >
                                <Icon name="folder" />
                                <span>{t('documents.moveToFolder', '移动到文件夹')}</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenMenuKey(null)
                                  void handleToggleCompleted(item)
                                }}
                              >
                                <Icon name="check" />
                                <span>{item.completed ? t('documents.markUnread', '标为未读') : t('documents.markRead', '标为已读')}</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenMenuKey(null)
                                  void handleReparse(item)
                                }}
                              >
                                <Icon name="refresh" />
                                <span>{t('documents.reparseTitle', '重新解析排版')}</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => {
                                  setOpenMenuKey(null)
                                  void handleDelete(item)
                                }}
                              >
                                <Icon name="trash" />
                                <span>{t('common.delete', '删除')}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                )
              })}
            </section>
          )}
        </div>
      </div>

      {/* 批量管理底栏（复用书架浮条样式） */}
      {batchMode && selectedRefs.length > 0 && (
        <aside className="shelf-batch-bar" role="toolbar" aria-label={t('shelf.batchToolbar', '批量操作栏')}>
          <div className="shelf-batch-info">
            <strong>{t('common.selectedBooks', { count: selectedRefs.length, defaultValue: `已选 ${selectedRefs.length} 项` })}</strong>
            <button
              type="button"
              className="subtle-button"
              onClick={() => {
                if (selectedKeys.size === visibleItems.length && visibleItems.length > 0) {
                  setSelectedKeys(new Set())
                } else {
                  setSelectedKeys(new Set(visibleItems.map(it => `${it.sourceId}\u0000${it.bookUrl}`)))
                }
              }}
            >
              {selectedKeys.size === visibleItems.length && visibleItems.length > 0
                ? t('common.clear', '取消全选')
                : t('common.selectAllCurrent', '全选当前')}
            </button>
          </div>
          <div className="shelf-batch-buttons">
            <button
              type="button"
              className="shelf-batch-action-btn"
              onClick={() => setModal({
                type: 'move',
                items: selectedRefs,
                label: t('documents.moveDocsCount', { count: selectedRefs.length, defaultValue: `移动 ${selectedRefs.length} 份文档` }),
                targetFolderId: activeUploadFolderId,
              })}
            >
              <Icon name="folder" />
              <span>{t('documents.moveToFolder', '移动到文件夹')}</span>
            </button>
            <button
              type="button"
              className="shelf-batch-action-btn"
              onClick={() => void handleBatchCompleted(true)}
            >
              <Icon name="check" />
              <span>{t('documents.markRead', '标为已读')}</span>
            </button>
            <button
              type="button"
              className="shelf-batch-action-btn"
              onClick={() => void handleBatchCompleted(false)}
            >
              <Icon name="book" />
              <span>{t('documents.markUnread', '标为未读')}</span>
            </button>
            <button
              type="button"
              className="shelf-batch-action-btn danger"
              onClick={() => void handleBatchDelete()}
            >
              <Icon name="trash" />
              <span>{t('common.delete', '删除')}</span>
            </button>
          </div>
        </aside>
      )}

      {/* 文件夹创建 / 重命名 / 移动文档弹窗 */}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!modalBusy) setModal(null)
          }}
        >
          <form
            className="group-manage-modal docs-folder-modal"
            onClick={e => e.stopPropagation()}
            onSubmit={e => void submitModal(e)}
          >
            <header className="group-manage-header">
              <div>
                <h2>
                  {modal.type === 'create'
                    ? (modal.parentId ? t('documents.newSubfolder', '新建子文件夹') : t('documents.newFolder', '新建文件夹'))
                    : modal.type === 'rename'
                      ? t('documents.renameFolder', '重命名文件夹')
                      : t('documents.moveToFolder', '移动到文件夹')}
                </h2>
                {modal.type === 'create' && modal.parentId && (
                  <small>
                    {t('documents.parentFolderLabel', {
                      path: getFolderDisplayPath(folders, modal.parentId),
                      defaultValue: `所在位置：${getFolderDisplayPath(folders, modal.parentId)}`,
                    })}
                  </small>
                )}
                {modal.type === 'move' && <small>{modal.label}</small>}
              </div>
              <button
                type="button"
                className="reader-icon-button"
                disabled={modalBusy}
                onClick={() => setModal(null)}
                aria-label={t('common.close', '关闭')}
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="group-manage-body">
              {modal.type === 'move' ? (
                <div className="docs-move-list">
                  <button
                    type="button"
                    className={`docs-move-option${modal.targetFolderId === null ? ' selected' : ''}`}
                    onClick={() => setModal({ ...modal, targetFolderId: null })}
                  >
                    <Icon name="file" />
                    <div className="docs-move-option-text">
                      <strong>{t('documents.unfiledDocs', '未归类')}</strong>
                      <small>{t('documents.rootFolderHint', '移出所有文件夹，放回「未归类」')}</small>
                    </div>
                    {modal.targetFolderId === null && <Icon name="check" className="docs-move-check" />}
                  </button>
                  {folderSelectOptions.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`docs-move-option${modal.targetFolderId === opt.id ? ' selected' : ''}`}
                      style={{ paddingLeft: `${12 + opt.depth * 18}px` }}
                      onClick={() => setModal({ ...modal, targetFolderId: opt.id })}
                    >
                      <Icon name="folder" />
                      <span className="docs-move-option-name">{opt.name}</span>
                      {modal.targetFolderId === opt.id && <Icon name="check" className="docs-move-check" />}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  autoFocus
                  maxLength={80}
                  className="docs-modal-input"
                  value={modal.name}
                  placeholder={t('documents.folderNamePlaceholder', '输入文件夹名称（不支持 / 或 \\）')}
                  onChange={e => setModal({ ...modal, name: e.target.value })}
                />
              )}
            </div>

            <footer className="docs-modal-footer">
              <button
                type="button"
                className="subtle-button"
                disabled={modalBusy}
                onClick={() => setModal(null)}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={modalBusy}
              >
                {modalBusy ? t('common.saving', '保存中...') : t('common.confirm', '确认')}
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  )
}
