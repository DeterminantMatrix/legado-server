import { isLocalBook } from './localBook'

export type DocumentFormat = 'md' | 'docx'
export type LocalBookFormat = 'txt' | 'epub' | DocumentFormat

export const DOCUMENT_ACCEPT_ATTR = '.md,.markdown,.docx'

/** 是否为文档页支持的本地文档扩展名（Markdown / Word .docx，大小写不敏感）。 */
export function isSupportedDocumentFile(filename: string): boolean {
  return /\.(md|markdown|docx)$/i.test(filename)
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
  const raw = item.variable?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const fmt = typeof parsed.localFormat === 'string' ? parsed.localFormat.trim().toLowerCase() : ''
    if (fmt === 'md' || fmt === 'markdown') return 'md'
    if (fmt === 'docx') return 'docx'
    if (fmt === 'txt' || fmt === 'text') return 'txt'
    if (fmt === 'epub') return 'epub'
    return null
  } catch {
    return null
  }
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
