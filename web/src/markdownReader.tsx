import React from 'react'
import type { Chapter, ChapterHeading } from './api'

/** 与服务端 [LocalBookParser.MARKDOWN_CONTENT_MARKER] 逐字对齐的正文协议头。 */
export const MARKDOWN_CONTENT_MARKER = '<!--legado:md-->'

/** 前端段落/块级缓存内部标记前缀（保证滚动流相邻章与分页模式识别统一）。 */
export const MARKDOWN_BLOCK_PREFIX = '<!--legado:md:b-->'

const FENCE_START_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const HR_RE = /^ {0,3}(?:(\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/
const UNORDERED_LIST_RE = /^ {0,3}[-*+]\s+(.*)$/
const ORDERED_LIST_RE = /^ {0,3}(\d+)\.\s+(.*)$/
const BLOCKQUOTE_RE = /^ {0,3}>\s?(.*)$/
const STANDALONE_IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/

export function isMarkdownContent(raw: string): boolean {
  if (!raw) return false
  return raw.trimStart().startsWith(MARKDOWN_CONTENT_MARKER)
}

export function isMarkdownBlock(line: string): boolean {
  return typeof line === 'string' && line.startsWith(MARKDOWN_BLOCK_PREFIX)
}

export function stripMarkdownBlockPrefix(line: string): string {
  return line.startsWith(MARKDOWN_BLOCK_PREFIX) ? line.slice(MARKDOWN_BLOCK_PREFIX.length) : line
}

export function isAtxHeadingBlock(block: string): boolean {
  const raw = stripMarkdownBlockPrefix(block).trim()
  if (!raw || raw.includes('\n')) return false
  return ATX_HEADING_RE.test(raw)
}

/** 清洗 Markdown 标题行内的语法标记，保留纯粹可读文本用于目录显示。 */
export function cleanMarkdownHeadingText(raw: string): string {
  let s = raw.trim()
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/==([^=]+)==/g, '$1')
  s = s.replace(/(?<!\\)\*([^*]+)\*/g, '$1')
  s = s.replace(/(?<!\\)_([^_]+)_/g, '$1')
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
  s = s.replace(/\s+#+\s*$/, '')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 从 Markdown 正文字符串或语义块数组中提取多级 ATX 标题，
 * 自动跳过围栏代码块，并为每个标题分配与正文渲染一致的 `ordinal`（从 0 起）。
 */
export function extractMarkdownHeadings(blocksOrRaw: string | string[]): ChapterHeading[] {
  const blocks = Array.isArray(blocksOrRaw)
    ? blocksOrRaw
    : (isMarkdownContent(blocksOrRaw) ? splitMarkdownBlocks(blocksOrRaw) : splitMarkdownBlocks(`${MARKDOWN_CONTENT_MARKER}\n${blocksOrRaw}`))

  const result: ChapterHeading[] = []
  let ordinal = 0

  for (const block of blocks) {
    const raw = stripMarkdownBlockPrefix(block).trim()
    if (!raw || raw.includes('\n')) continue
    if (FENCE_START_RE.test(raw)) continue
    const match = ATX_HEADING_RE.exec(raw)
    if (!match) continue
    const level = Math.min(6, Math.max(1, match[1].length))
    const title = cleanMarkdownHeadingText(match[2])
    if (title) {
      result.push({ level, title, ordinal })
    }
    ordinal += 1
  }

  return result
}

export type DocumentOutlineItem = {
  id: string
  chapterIndex: number
  chapterTitle: string
  level: number
  depth: number
  title: string
  headingOrdinal?: number
  isChapterRoot: boolean
  hasChildren: boolean
}

function normalizeHeadingCompare(text: string): string {
  return cleanMarkdownHeadingText(text).toLowerCase()
}

/**
 * 结合章节元信息与（服务端或客户端实时提取的）章节内 ATX 子标题，
 * 构建可直接用于目录抽屉展示和搜索的多层级大纲列表。
 */
export function buildDocumentOutline(
  chapters: Chapter[],
  liveHeadingsByChapter?: Map<number, ChapterHeading[]>,
): DocumentOutlineItem[] {
  if (chapters.length === 0) return []

  let minRootLevel = 6
  let hasExplicitLevel = false
  for (const ch of chapters) {
    if (typeof ch.level === 'number' && ch.level >= 1 && ch.level <= 6) {
      hasExplicitLevel = true
      if (ch.level < minRootLevel) minRootLevel = ch.level
    }
  }
  const baseMinLevel = hasExplicitLevel ? minRootLevel : 1

  const outline: DocumentOutlineItem[] = []

  for (const ch of chapters) {
    const rootLevel = typeof ch.level === 'number' && ch.level >= 1 && ch.level <= 6 ? ch.level : 1
    const rootDepth = Math.min(3, Math.max(0, rootLevel - baseMinLevel))
    const live = liveHeadingsByChapter?.get(ch.index)
    const rawSubHeadings = live && live.length > 0 ? live : (ch.headings ?? [])

    const chapterCompare = normalizeHeadingCompare(ch.title)
    const filteredSubs = rawSubHeadings.filter((h, idx) => {
      if (!h.title.trim()) return false
      if (idx === 0 && h.level <= rootLevel && normalizeHeadingCompare(h.title) === chapterCompare) {
        return false
      }
      return true
    })

    outline.push({
      id: `ch-${ch.index}`,
      chapterIndex: ch.index,
      chapterTitle: ch.title,
      level: rootLevel,
      depth: rootDepth,
      title: ch.title,
      headingOrdinal: undefined,
      isChapterRoot: true,
      hasChildren: filteredSubs.length > 0,
    })

    for (const sub of filteredSubs) {
      const level = Math.min(6, Math.max(1, sub.level))
      const depth = Math.min(3, Math.max(rootDepth + 1, level - baseMinLevel))
      outline.push({
        id: `ch-${ch.index}-h-${sub.ordinal}`,
        chapterIndex: ch.index,
        chapterTitle: ch.title,
        level,
        depth,
        title: sub.title,
        headingOrdinal: sub.ordinal,
        isChapterRoot: false,
        hasChildren: false,
      })
    }
  }

  return outline
}

export function stripMarkdownContentMarker(raw: string): string {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(MARKDOWN_CONTENT_MARKER)) return raw
  const after = trimmed.slice(MARKDOWN_CONTENT_MARKER.length)
  return after.replace(/^\r?\n/, '')
}

function isTableRowLine(line: string): boolean {
  const t = line.trim()
  return t.length >= 3 && t.includes('|')
}

function isFenceClosing(line: string, fenceChar: string, fenceLen: number): boolean {
  const trimmed = line.trim()
  if (trimmed.length < fenceLen) return false
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== fenceChar) return false
  }
  return true
}

function startsSpecialBlock(line: string, nextLine?: string): boolean {
  if (!line.trim()) return true
  if (FENCE_START_RE.test(line)) return true
  if (ATX_HEADING_RE.test(line)) return true
  if (HR_RE.test(line)) return true
  if (BLOCKQUOTE_RE.test(line)) return true
  if (UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) return true
  if (STANDALONE_IMG_RE.test(line.trim())) return true
  if (isTableRowLine(line) && nextLine !== undefined && TABLE_SEP_RE.test(nextLine.trim())) return true
  return false
}

/**
 * 将带 [MARKDOWN_CONTENT_MARKER] 的章节正文按语义块切分。
 *
 * 每一块统一加 [MARKDOWN_BLOCK_PREFIX] 前缀，使得 `ReaderScreen` 在分页模式与
 * 滚动三章窗口相邻章渲染中都能无需改动数据结构地识别 Markdown 块。
 */
export function splitMarkdownBlocks(raw: string): string[] {
  const body = stripMarkdownContentMarker(raw).replace(/\r\n?/g, '\n')
  if (!body.trim()) return []

  const lines = body.split('\n')
  const blocks: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // 1. 围栏代码块（整块保持不拆散）
    const fenceMatch = FENCE_START_RE.exec(line)
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0]
      const fenceLen = fenceMatch[1].length
      const buf = [line]
      i++
      while (i < lines.length) {
        buf.push(lines[i])
        if (isFenceClosing(lines[i], fenceChar, fenceLen)) {
          i++
          break
        }
        i++
      }
      blocks.push(MARKDOWN_BLOCK_PREFIX + buf.join('\n'))
      continue
    }

    // 2. ATX 标题
    if (ATX_HEADING_RE.test(line)) {
      blocks.push(MARKDOWN_BLOCK_PREFIX + line.trim())
      i++
      continue
    }

    // 3. 水平分割线
    if (HR_RE.test(line)) {
      blocks.push(MARKDOWN_BLOCK_PREFIX + line.trim())
      i++
      continue
    }

    // 4. 独立图片行
    if (STANDALONE_IMG_RE.test(line.trim())) {
      blocks.push(MARKDOWN_BLOCK_PREFIX + line.trim())
      i++
      continue
    }

    // 5. GFM 表格（表头 + 分隔线 + 连续数据行）
    if (i + 1 < lines.length && isTableRowLine(line) && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      const buf = [line, lines[i + 1]]
      i += 2
      while (i < lines.length && lines[i].trim() && isTableRowLine(lines[i])) {
        buf.push(lines[i])
        i++
      }
      blocks.push(MARKDOWN_BLOCK_PREFIX + buf.join('\n'))
      continue
    }

    // 6. 引用块
    if (BLOCKQUOTE_RE.test(line)) {
      const buf = [line]
      i++
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      blocks.push(MARKDOWN_BLOCK_PREFIX + buf.join('\n'))
      continue
    }

    // 7. 列表块（同类型无序/有序才合并；相邻切换列表类型时自动分成两个独立列表块）
    if (UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) {
      const isOrderedBlock = ORDERED_LIST_RE.test(line)
      const isSameListKind = (candidate: string) =>
        isOrderedBlock ? ORDERED_LIST_RE.test(candidate) : UNORDERED_LIST_RE.test(candidate)
      const buf = [line]
      i++
      while (i < lines.length) {
        const cur = lines[i]
        if (!cur.trim()) {
          // 若空行紧接着仍是同类型列表项则合并为同一列表块，否则结束列表
          if (i + 1 < lines.length && isSameListKind(lines[i + 1])) {
            i++
            continue
          }
          break
        }
        if (isSameListKind(cur) || /^ {2,}\S/.test(cur)) {
          buf.push(cur)
          i++
        } else {
          break
        }
      }
      blocks.push(MARKDOWN_BLOCK_PREFIX + buf.join('\n'))
      continue
    }

    // 8. 普通段落：合并相邻普通非空行
    const para = [line.trim()]
    i++
    while (i < lines.length && !startsSpecialBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push(MARKDOWN_BLOCK_PREFIX + para.join('\n'))
  }

  return blocks
}

function stripInlineMarkdownSyntax(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) => alt.trim())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
}

/**
 * 将 Markdown 原文（或单块）清洗为适合 TTS 语音朗读的纯文本：
 * - 跳过围栏代码块与分割线，避免朗读大量编程/标点符号噪音
 * - 剥离 `#`、`>`、`**`、`` ` ``、`[文本](url)`、表格竖线等标记
 * - 表格与列表条目之间自动补齐自然停顿标点
 */
export function stripMarkdownForTts(input: string): string {
  let raw = stripMarkdownBlockPrefix(input)
  raw = stripMarkdownContentMarker(raw).trim()
  if (!raw) return ''

  // 代码块与分割线在朗读时跳过
  if (FENCE_START_RE.test(raw.split('\n')[0])) return ''
  if (HR_RE.test(raw)) return ''

  const lines = raw.split('\n')
  const parts: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    if (TABLE_SEP_RE.test(trimmed)) continue

    if (trimmed.startsWith('|') || (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim()))) {
      const cells = splitTableCells(trimmed)
        .map(c => stripInlineMarkdownSyntax(c).trim())
        .filter(Boolean)
      if (cells.length > 0) {
        parts.push(cells.join('，'))
      }
      continue
    }

    let cleanedLine = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^\[![a-zA-Z]+\][+-]?\s*/, '')
      .replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, '')
    cleanedLine = stripInlineMarkdownSyntax(cleanedLine).replace(/\s+/g, ' ').trim()
    if (cleanedLine) parts.push(cleanedLine)
  }

  return parts.join('。').replace(/。{2,}/g, '。').trim()
}

function splitTableCells(line: string): string[] {
  let raw = line.trim()
  if (raw.startsWith('|')) raw = raw.slice(1)
  if (raw.endsWith('|') && !raw.endsWith('\\|')) raw = raw.slice(0, -1)

  const cells: string[] = []
  let current = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length && raw[i + 1] === '|') {
      current += '|'
      i++
    } else if (ch === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

function parseTableAlignments(sepLine: string, colCount: number): Array<'left' | 'center' | 'right'> {
  const cells = splitTableCells(sepLine)
  return Array.from({ length: colCount }, (_, idx) => {
    const c = (cells[idx] ?? '').trim()
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

export function isSafeLinkUrl(url: string): boolean {
  const t = url.trim()
  return /^https?:\/\//i.test(t) || /^mailto:/i.test(t)
}

export function isSafeImageUrl(url: string): boolean {
  const t = url.trim()
  return t.startsWith('/api/local-books/') || /^https?:\/\//i.test(t)
}

function renderTextWithSentenceHighlight(text: string, highlightText: string | undefined, keyPrefix: string): React.ReactNode {
  if (!highlightText) return text
  const idx = text.indexOf(highlightText)
  if (idx < 0) return text
  return (
    <React.Fragment key={keyPrefix}>
      {text.slice(0, idx)}
      <span className="tts-active-sentence">{highlightText}</span>
      {text.slice(idx + highlightText.length)}
    </React.Fragment>
  )
}

/** 行内 Markdown 安全 AST 渲染（纯 React 节点，禁止 HTML 字符串拼接）。 */
export function renderInlineMarkdown(
  text: string,
  options?: {
    highlightText?: string
    onOpenImage?: (src: string, alt: string) => void
  },
  depth = 0,
): React.ReactNode[] {
  if (!text) return []
  if (depth > 4) {
    return [renderTextWithSentenceHighlight(text, options?.highlightText, 'max-depth')]
  }

  const TOKEN_RE =
    /\\([\\`*_{}\[\]()#+\-.!|>~])|`([^`\n]+)`|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*\*([^\n*]+?)\*\*\*|\*\*([^\n*]+?)\*\*|__([^\n_]+?)__|~~([^\n~]+?)~~|\*([^\n*]+?)\*|(?<![\w])_([^\n_]+?)_(?![\w])|==([^\n=]+?)==/g

  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let tokenIdx = 0

  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index)
      nodes.push(renderTextWithSentenceHighlight(plain, options?.highlightText, `t-${tokenIdx++}`))
    }

    const key = `k-${depth}-${tokenIdx++}`
    if (match[1] !== undefined) {
      // 反斜杠转义字面符号
      nodes.push(match[1])
    } else if (match[2] !== undefined) {
      nodes.push(<code key={key} className="md-inline-code">{match[2]}</code>)
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const alt = match[3]
      const src = match[4]
      if (isSafeImageUrl(src)) {
        nodes.push(
          <img key={key} className="md-inline-img" src={src} alt={alt || '图片'} loading="lazy" />
        )
      } else {
        nodes.push(alt || src)
      }
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const label = match[5]
      const href = match[6]
      if (isSafeLinkUrl(href)) {
        nodes.push(
          <a key={key} className="md-link" href={href} target="_blank" rel="noopener noreferrer">
            {renderInlineMarkdown(label, options, depth + 1)}
          </a>
        )
      } else {
        nodes.push(...renderInlineMarkdown(label, options, depth + 1))
      }
    } else if (match[7] !== undefined) {
      nodes.push(
        <strong key={key}><em>{renderInlineMarkdown(match[7], options, depth + 1)}</em></strong>
      )
    } else if (match[8] !== undefined || match[9] !== undefined) {
      const inner = match[8] ?? match[9] ?? ''
      nodes.push(
        <strong key={key}>{renderInlineMarkdown(inner, options, depth + 1)}</strong>
      )
    } else if (match[10] !== undefined) {
      nodes.push(
        <del key={key}>{renderInlineMarkdown(match[10], options, depth + 1)}</del>
      )
    } else if (match[11] !== undefined || match[12] !== undefined) {
      const inner = match[11] ?? match[12] ?? ''
      nodes.push(
        <em key={key}>{renderInlineMarkdown(inner, options, depth + 1)}</em>
      )
    } else if (match[13] !== undefined) {
      nodes.push(
        <mark key={key} className="md-mark">{renderInlineMarkdown(match[13], options, depth + 1)}</mark>
      )
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(renderTextWithSentenceHighlight(text.slice(lastIndex), options?.highlightText, `t-end-${tokenIdx}`))
  }

  return nodes
}

export type MarkdownBlockProps = {
  block: string
  paragraphIndex?: number
  headingOrdinal?: number
  isActive?: boolean
  isFlashed?: boolean
  onClick?: () => void
  highlightText?: string
  onOpenImage?: (src: string, alt: string) => void
}

/**
 * 渲染单个语义化的 Markdown 块。
 *
 * 注意：**正文中严禁输出 `<h1>`** —— `ReaderScreen.tsx` 使用 `.reading-content h1`
 * 专指章节大标题，`#`~`######` 在此统一映射为 `<h2>`~`<h6>`（靠 `.md-h1`..`.md-h6` 分级视觉样式）。
 */
export function MarkdownBlock({
  block,
  paragraphIndex,
  headingOrdinal,
  isActive = false,
  isFlashed = false,
  onClick,
  highlightText,
  onOpenImage,
}: MarkdownBlockProps) {
  const raw = stripMarkdownBlockPrefix(block).trim()
  if (!raw) return null

  const lines = raw.split('\n')
  const firstLine = lines[0]
  const inlineOpts = { highlightText, onOpenImage }

  const wrap = (kind: string, children: React.ReactNode, headingOrd?: number) => (
    <div
      data-paragraph-index={paragraphIndex}
      data-md-heading-ordinal={headingOrd}
      className={`reader-paragraph md-block md-block-${kind}${isActive ? ' tts-active-paragraph' : ''}${isFlashed ? ' md-heading-flash' : ''}`}
      onClick={onClick}
    >
      {children}
    </div>
  )

  // 1. 围栏代码块
  const fenceStart = FENCE_START_RE.exec(firstLine)
  if (fenceStart) {
    const fenceChar = fenceStart[1][0]
    const fenceLen = fenceStart[1].length
    const lang = fenceStart[2].trim().split(/\s+/)[0] || ''
    const hasClosing = lines.length > 1 && isFenceClosing(lines[lines.length - 1], fenceChar, fenceLen)
    const codeLines = hasClosing ? lines.slice(1, -1) : lines.slice(1)
    return wrap(
      'code',
      <pre className="md-code-block">
        {lang && <span className="md-code-lang">{lang}</span>}
        <code className="md-code-content">{codeLines.join('\n')}</code>
      </pre>,
    )
  }

  // 2. 分割线
  if (lines.length === 1 && HR_RE.test(firstLine)) {
    return wrap('hr', <hr className="md-hr" />)
  }

  // 3. ATX 标题（均渲染为 h2..h6，保留 h1 给章节大标题）
  const headingMatch = lines.length === 1 ? ATX_HEADING_RE.exec(firstLine) : null
  if (headingMatch) {
    const level = Math.min(6, Math.max(1, headingMatch[1].length))
    const headingText = headingMatch[2].trim()
    const content = renderInlineMarkdown(headingText, inlineOpts)
    const cls = `md-heading md-h${level}`
    let headingEl: React.ReactNode
    if (level <= 2) headingEl = <h2 className={cls}>{content}</h2>
    else if (level === 3) headingEl = <h3 className={cls}>{content}</h3>
    else if (level === 4) headingEl = <h4 className={cls}>{content}</h4>
    else if (level === 5) headingEl = <h5 className={cls}>{content}</h5>
    else headingEl = <h6 className={cls}>{content}</h6>
    return wrap(`h${level}`, headingEl, headingOrdinal)
  }

  // 4. 独立图片块（可点击灯箱预览）
  const imgMatch = lines.length === 1 ? STANDALONE_IMG_RE.exec(firstLine.trim()) : null
  if (imgMatch) {
    const alt = imgMatch[1].trim()
    const src = imgMatch[2].trim()
    if (isSafeImageUrl(src)) {
      return wrap(
        'image',
        <figure className="md-figure">
          <button
            type="button"
            className="md-image-button"
            onClick={e => {
              e.stopPropagation()
              onOpenImage?.(src, alt)
            }}
            aria-label={alt || '查看图片'}
          >
            <img className="md-block-img" src={src} alt={alt || '图片'} loading="lazy" />
          </button>
          {alt && alt !== '图片' && <figcaption className="md-figcaption">{alt}</figcaption>}
        </figure>,
      )
    }
    return wrap('paragraph', <p className="md-p">{alt || src}</p>)
  }

  // 5. GFM 表格
  if (lines.length >= 2 && isTableRowLine(lines[0]) && TABLE_SEP_RE.test(lines[1].trim())) {
    const headerCells = splitTableCells(lines[0])
    const colCount = Math.max(1, headerCells.length)
    const aligns = parseTableAlignments(lines[1].trim(), colCount)
    const bodyRows = lines.slice(2).map(splitTableCells)
    return wrap(
      'table',
      <div className="md-table-wrap">
        <table className="md-table">
          <thead>
            <tr>
              {Array.from({ length: colCount }, (_, colIdx) => (
                <th key={colIdx} style={{ textAlign: aligns[colIdx] }}>
                  {renderInlineMarkdown(headerCells[colIdx] ?? '', inlineOpts)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {Array.from({ length: colCount }, (_, colIdx) => (
                  <td key={colIdx} style={{ textAlign: aligns[colIdx] }}>
                    {renderInlineMarkdown(row[colIdx] ?? '', inlineOpts)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    )
  }

  // 6. 引用块 / Obsidian Callout
  if (BLOCKQUOTE_RE.test(firstLine)) {
    const quoteLines = lines.map(l => l.replace(BLOCKQUOTE_RE, '$1'))
    const calloutMatch = /^\[!([a-zA-Z]+)\](?:[+-])?\s*(.*)$/.exec(quoteLines[0] ?? '')
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase()
      const customTitle = calloutMatch[2].trim()
      const tone = (() => {
        if (type === 'tip' || type === 'hint' || type === 'abstract' || type === 'summary' || type === 'tldr') return 'aqua'
        if (type === 'success' || type === 'check' || type === 'done' || type === 'quote' || type === 'cite') return 'green'
        if (type === 'question' || type === 'help' || type === 'faq') return 'yellow'
        if (type === 'warning' || type === 'caution' || type === 'attention' || type === 'important') return 'orange'
        if (type === 'danger' || type === 'error' || type === 'fail' || type === 'failure' || type === 'missing' || type === 'bug') return 'red'
        if (type === 'example') return 'purple'
        return 'blue'
      })()
      const titleText = customTitle || (type.charAt(0).toUpperCase() + type.slice(1))
      const bodyText = quoteLines.slice(1).join('\n').trim()
      const bodyParas = bodyText ? bodyText.split(/\n{2,}/) : []
      return wrap(
        'callout',
        <div className={`md-callout md-callout-${tone}`}>
          <div className="md-callout-title">{renderInlineMarkdown(titleText, inlineOpts)}</div>
          {bodyParas.length > 0 && (
            <div className="md-callout-body">
              {bodyParas.map((qp, idx) => (
                <p key={idx} className="md-blockquote-p">
                  {renderInlineMarkdown(qp.replace(/\n/g, ' '), inlineOpts)}
                </p>
              ))}
            </div>
          )}
        </div>,
      )
    }

    const quoteText = quoteLines.join('\n')
    const quoteParas = quoteText.split(/\n{2,}/)
    return wrap(
      'blockquote',
      <blockquote className="md-blockquote">
        {quoteParas.map((qp, idx) => (
          <p key={idx} className="md-blockquote-p">
            {renderInlineMarkdown(qp.replace(/\n/g, ' '), inlineOpts)}
          </p>
        ))}
      </blockquote>,
    )
  }

  // 7. 列表块
  const isOrdered = ORDERED_LIST_RE.test(firstLine)
  const isUnordered = UNORDERED_LIST_RE.test(firstLine)
  if (isOrdered || isUnordered) {
    type ListItemData = { text: string; checked?: boolean }
    const items: ListItemData[] = []
    for (const l of lines) {
      const mU = UNORDERED_LIST_RE.exec(l)
      const mO = ORDERED_LIST_RE.exec(l)
      if (mU) {
        const content = mU[1]
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content)
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === 'x' })
        } else {
          items.push({ text: content })
        }
      } else if (mO) {
        items.push({ text: mO[2] })
      } else if (items.length > 0) {
        items[items.length - 1].text += ` ${l.trim()}`
      }
    }
    const ListTag = isOrdered ? 'ol' : 'ul'
    return wrap(
      'list',
      <ListTag className={`md-list ${isOrdered ? 'md-ol' : 'md-ul'}`}>
        {items.map((item, idx) => (
          <li
            key={idx}
            className={
              item.checked !== undefined
                ? `md-task-item${item.checked ? ' is-checked' : ''}`
                : 'md-list-item'
            }
          >
            {item.checked !== undefined && (
              <span className={`md-task-box ${item.checked ? 'is-checked' : ''}`} aria-hidden="true">
                {item.checked ? '✓' : ''}
              </span>
            )}
            <span>{renderInlineMarkdown(item.text, inlineOpts)}</span>
          </li>
        ))}
      </ListTag>,
    )
  }

  // 8. 普通段落（保留软换行）
  return wrap(
    'paragraph',
    <p className="md-p">
      {lines.map((line, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && ' '}
          {renderInlineMarkdown(line, inlineOpts)}
        </React.Fragment>
      ))}
    </p>,
  )
}
