import type { BookshelfItem, DocFolder } from './api'
import { isLocalBook } from './localBook'

export type DocumentFormat = 'md' | 'docx'
export type LocalBookFormat = 'txt' | 'epub' | DocumentFormat

export const DOCUMENT_ACCEPT_ATTR = '.md,.markdown,.docx'
export const DOC_VIEW_ALL = '__all__'
export const DOC_VIEW_UNFILED = '__unfiled__'
export const DOC_SIDEBAR_DEFAULT_WIDTH = 268
export const DOC_SIDEBAR_MIN_WIDTH = 200
export const DOC_SIDEBAR_MAX_WIDTH = 480

export type DocFolderNode = {
  folder: DocFolder
  children: DocFolderNode[]
  directDocs: BookshelfItem[]
  totalDocCount: number
}

export type DocFolderTreeData = {
  roots: DocFolderNode[]
  unfiledDocs: BookshelfItem[]
  nodeMap: Map<string, DocFolderNode>
  validFolderIds: Set<string>
}

export type DocFolderSelectOption = {
  id: string
  name: string
  depth: number
  path: string
}

/** 是否为文档页支持的本地文档扩展名（Markdown / Word .docx，大小写不敏感）。 */
export function isSupportedDocumentFile(filename: string): boolean {
  return /\.(md|markdown|docx)$/i.test(filename)
}

function parseVariableObject(variable?: string | null): Record<string, unknown> | null {
  const raw = variable?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 解析本地书籍在服务端 `book_shelf.variable` 中落库的原始格式标识。
 * 非本地书或未记录/非法 JSON 均安全返回 null。
 */
export function getLocalBookFormat(item: {
  sourceId?: string | null
  bookUrl?: string | null
  variable?: string | null
}): LocalBookFormat | null {
  if (!item.sourceId || !item.bookUrl || !isLocalBook({ sourceId: item.sourceId, bookUrl: item.bookUrl })) {
    return null
  }
  const parsed = parseVariableObject(item.variable)
  if (!parsed) return null
  const fmt = typeof parsed.localFormat === 'string' ? parsed.localFormat.trim().toLowerCase() : ''
  if (fmt === 'md' || fmt === 'markdown') return 'md'
  if (fmt === 'docx') return 'docx'
  if (fmt === 'txt' || fmt === 'text') return 'txt'
  if (fmt === 'epub') return 'epub'
  return null
}

/** 判断一条书架记录是否应归类到「文档」页（Markdown / Word .docx）。 */
export function isDocumentItem(item: {
  sourceId?: string | null
  bookUrl?: string | null
  variable?: string | null
}): boolean {
  const fmt = getLocalBookFormat(item)
  return fmt === 'md' || fmt === 'docx'
}

/** 获取文档格式（仅当属于 Markdown 或 Word 时返回 `'md'` / `'docx'`）。 */
export function getDocumentFormat(item: {
  sourceId?: string | null
  bookUrl?: string | null
  variable?: string | null
}): DocumentFormat | null {
  const fmt = getLocalBookFormat(item)
  return fmt === 'md' || fmt === 'docx' ? fmt : null
}

/** 从文档条目的 `variable.docFolderId` 中安全解析所属文件夹 ID（缺失或非字符串返回 null）。 */
export function getDocumentFolderId(item: { variable?: string | null }): string | null {
  const parsed = parseVariableObject(item.variable)
  if (!parsed) return null
  const raw = parsed.docFolderId
  if (typeof raw !== 'string') return null
  const clean = raw.trim()
  return clean.length > 0 ? clean : null
}

function compareFolders(a: DocFolder, b: DocFolder): number {
  const orderDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  if (orderDiff !== 0) return orderDiff
  const timeDiff = (a.createdAt ?? 0) - (b.createdAt ?? 0)
  if (timeDiff !== 0) return timeDiff
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * 构建文档资源管理器文件夹树，挂接直接子文件夹、直属文档以及递归累计文档数。
 * - 若文件夹 `parentId` 指向不存在节点或形成异常环路，安全退回根节点；
 * - 若文档 `docFolderId` 指向已删除/不存在的文件夹，自动归入 `unfiledDocs`；
 * - 递归累计使用 visited 集合防止脏数据引起死循环。
 */
export function buildFolderTree(
  folders: DocFolder[],
  items: BookshelfItem[],
): DocFolderTreeData {
  const sortedFolders = [...folders].sort(compareFolders)
  const validFolderIds = new Set(sortedFolders.map(f => f.id))
  const nodeMap = new Map<string, DocFolderNode>()

  for (const folder of sortedFolders) {
    nodeMap.set(folder.id, {
      folder,
      children: [],
      directDocs: [],
      totalDocCount: 0,
    })
  }

  const unfiledDocs: BookshelfItem[] = []
  for (const item of items) {
    if (!isDocumentItem(item)) continue
    const fid = getDocumentFolderId(item)
    const targetNode = fid ? nodeMap.get(fid) : undefined
    if (targetNode) {
      targetNode.directDocs.push(item)
    } else {
      unfiledDocs.push(item)
    }
  }

  const roots: DocFolderNode[] = []
  const createsCycle = (nodeId: string, candidateParentId: string): boolean => {
    const visited = new Set<string>([nodeId])
    let cursor: string | null | undefined = candidateParentId
    while (cursor) {
      if (visited.has(cursor)) return true
      visited.add(cursor)
      cursor = nodeMap.get(cursor)?.folder.parentId ?? null
    }
    return false
  }

  for (const folder of sortedFolders) {
    const node = nodeMap.get(folder.id)!
    const parentId = folder.parentId?.trim() || null
    const parentNode = parentId && !createsCycle(folder.id, parentId) ? nodeMap.get(parentId) : undefined
    if (parentNode) {
      parentNode.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const countVisited = new Set<string>()
  const computeTotal = (node: DocFolderNode): number => {
    if (countVisited.has(node.folder.id)) return node.directDocs.length
    countVisited.add(node.folder.id)
    let total = node.directDocs.length
    for (const child of node.children) {
      total += computeTotal(child)
    }
    node.totalDocCount = total
    return total
  }
  for (const root of roots) {
    computeTotal(root)
  }

  return { roots, unfiledDocs, nodeMap, validFolderIds }
}

/** 获取指定文件夹从根到自身的有序面包屑数组（含防循环保护）。 */
export function getFolderBreadcrumb(folders: DocFolder[], folderId: string | null): DocFolder[] {
  if (!folderId) return []
  const byId = new Map(folders.map(f => [f.id, f]))
  const chain: DocFolder[] = []
  const visited = new Set<string>()
  let cursorId: string | null | undefined = folderId

  while (cursorId) {
    if (visited.has(cursorId)) break
    const current = byId.get(cursorId)
    if (!current) break
    visited.add(cursorId)
    chain.unshift(current)
    cursorId = current.parentId ?? null
  }
  return chain
}

/** 返回文件夹完整展示路径（例如 `历史档案 / 1972-1978`）。 */
export function getFolderDisplayPath(folders: DocFolder[], folderId: string | null): string {
  const crumb = getFolderBreadcrumb(folders, folderId)
  return crumb.map(f => f.name).join(' / ')
}

/** 按左侧选中的视图（全部 / 未归类 / 具体文件夹 ID）过滤主区域显示的 Markdown 与 Word 文档。 */
export function filterDocumentsBySelection(
  items: BookshelfItem[],
  folders: DocFolder[],
  selectedView: string,
): BookshelfItem[] {
  const docs = items.filter(isDocumentItem)
  if (selectedView === DOC_VIEW_ALL) return docs

  const validIds = new Set(folders.map(f => f.id))
  if (selectedView === DOC_VIEW_UNFILED) {
    return docs.filter(item => {
      const fid = getDocumentFolderId(item)
      return !fid || !validIds.has(fid)
    })
  }

  if (!validIds.has(selectedView)) return []
  return docs.filter(item => getDocumentFolderId(item) === selectedView)
}

/** 将文件夹树先序扁平化为带层级缩进（depth + path）的选项列表，供「移动到文件夹」弹窗使用。 */
export function flattenFoldersForSelect(folders: DocFolder[]): DocFolderSelectOption[] {
  const tree = buildFolderTree(folders, [])
  const options: DocFolderSelectOption[] = []
  const visited = new Set<string>()

  const walk = (node: DocFolderNode, depth: number, prefix: string[]) => {
    if (visited.has(node.folder.id)) return
    visited.add(node.folder.id)
    const parts = [...prefix, node.folder.name]
    options.push({
      id: node.folder.id,
      name: node.folder.name,
      depth,
      path: parts.join(' / '),
    })
    for (const child of node.children) {
      walk(child, depth + 1, parts)
    }
  }

  for (const root of tree.roots) {
    walk(root, 0, [])
  }
  return options
}

/**
 * 收集文件夹自身及其全部后代子文件夹 ID（含 visited 防环保护），
 * 用于「移动文件夹到…」时剔除自身及子孙节点防止循环嵌套。
 */
export function collectDescendantFolderIds(folders: DocFolder[], rootId: string): Set<string> {
  const result = new Set<string>([rootId])
  const childrenByParent = new Map<string, string[]>()
  for (const f of folders) {
    const pid = f.parentId?.trim()
    if (!pid) continue
    const list = childrenByParent.get(pid)
    if (list) list.push(f.id)
    else childrenByParent.set(pid, [f.id])
  }
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = childrenByParent.get(current)
    if (!children) continue
    for (const cid of children) {
      if (!result.has(cid)) {
        result.add(cid)
        queue.push(cid)
      }
    }
  }
  return result
}

/** 计算固定定位右键菜单的安全视口坐标，贴近右缘或底缘时自动向内翻转/夹紧。 */
export function clampContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const safeX = Number.isFinite(x) ? x : margin
  const safeY = Number.isFinite(y) ? y : margin
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin)
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin)
  const left = safeX + menuWidth + margin > viewportWidth
    ? Math.max(margin, Math.min(safeX - menuWidth, maxLeft))
    : Math.max(margin, Math.min(safeX, maxLeft))
  const top = safeY + menuHeight + margin > viewportHeight
    ? Math.max(margin, Math.min(safeY - menuHeight, maxTop))
    : Math.max(margin, Math.min(safeY, maxTop))
  return { left, top }
}

/** 将资源管理器侧栏宽度夹紧在 [200, 480] 区间；非法值安全回退默认值 268。 */
export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DOC_SIDEBAR_DEFAULT_WIDTH
  }
  return Math.min(DOC_SIDEBAR_MAX_WIDTH, Math.max(DOC_SIDEBAR_MIN_WIDTH, Math.round(width)))
}
