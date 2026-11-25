package io.legado.server

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.parser.Parser
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

data class ParsedBook(
    val title: String,
    val author: String? = null,
    val intro: String? = null,
    val coverBytes: ByteArray? = null,
    val coverContentType: String? = null,
    val chapters: List<ParsedChapter>,
    /** 内嵌媒体资源（如 DOCX 提取的图片：规范化文件名 -> 字节）。 */
    val mediaFiles: Map<String, ByteArray> = emptyMap(),
    /** 源文件格式标识（`"txt"` / `"epub"` / `"md"` / `"docx"`），用于前端文档库归类。 */
    val localFormat: String? = null,
)

data class ParsedChapter(
    val title: String,
    val content: String,
)

object LocalBookParser {

    const val LOC_BOOK_SOURCE_ID = "loc_book"

    /** Markdown 章节正文标记：前后端约定以此标记区分普通小说文本与富文本 Markdown 内容。 */
    const val MARKDOWN_CONTENT_MARKER = "<!--legado:md-->"

    private const val MAX_ZIP_ENTRIES = 2000
    private const val MAX_ZIP_ENTRY_BYTES = 20L * 1024 * 1024
    private const val MAX_ZIP_TOTAL_BYTES = 80L * 1024 * 1024
    private const val MAX_DOCX_MEDIA_FILES = 30
    private const val MAX_DOCX_MEDIA_BYTES = 5 * 1024 * 1024

    // 中文小说章节识别核心正则
    private val CHAPTER_TITLE_REGEX = Regex(
        """^(?:第[0-9一二三四五六七八九十百千万零两]+[章回节卷集幕计篇部]|Chapter\s+[0-9]+|引子|序言|序章|楔子|尾声|后记|番外|终章)(?:[^\r\n]{0,40})$""",
        RegexOption.IGNORE_CASE
    )

    private val FENCE_START_REGEX = Regex("""^ {0,3}(`{3,}|~{3,})(.*)$""")
    private val ATX_HEADING_REGEX = Regex("""^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$""")

    fun parse(filename: String, bytes: ByteArray): ParsedBook = parse(filename, bytes, null)

    fun parse(filename: String, bytes: ByteArray, bookId: String?): ParsedBook {
        val lowerName = filename.lowercase()
        return when {
            lowerName.endsWith(".epub") -> parseEpub(filename, bytes)
            lowerName.endsWith(".md") || lowerName.endsWith(".markdown") -> parseMarkdown(filename, bytes)
            lowerName.endsWith(".docx") -> parseDocx(filename, bytes, bookId)
            lowerName.endsWith(".txt") || lowerName.endsWith(".text") -> parseTxt(filename, bytes)
            else -> {
                // 自动探测是否为 zip（EPUB / DOCX）结构，否则回退按 TXT 解析
                if (isZipSignature(bytes)) {
                    runCatching { parseEpub(filename, bytes) }
                        .recoverCatching { parseDocx(filename, bytes, bookId) }
                        .getOrElse { parseTxt(filename, bytes) }
                } else {
                    parseTxt(filename, bytes)
                }
            }
        }
    }

    /**
     * 是否为**受支持**的本地书格式（TXT / EPUB / MD / DOCX）。
     *
     * 之所以要单独判一次而不是依赖 [parse]：`parse` 对未知扩展名会**静默回退成按 TXT 解析**
     * （见上面 `else` 分支的内容探测）。在「导入本地书籍」入口拦截 `.pdf`/`.mobi`/`.doc` 等格式，
     * 可防止生成目录错乱、正文是二进制乱码的"书"，给出明确提示。
     */
    fun isSupported(filename: String): Boolean {
        val lower = filename.lowercase()
        return lower.endsWith(".txt") ||
            lower.endsWith(".text") ||
            lower.endsWith(".epub") ||
            lower.endsWith(".md") ||
            lower.endsWith(".markdown") ||
            lower.endsWith(".docx")
    }

    /** 支持格式的提示文案，供前端与服务端共用同一份描述。 */
    const val SUPPORTED_FORMATS = "TXT / EPUB / MD / DOCX"

    /**
     * TXT 文本自动探测编码与分章
     */
    fun parseTxt(filename: String, bytes: ByteArray): ParsedBook {
        val (detectedTitle, detectedAuthor) = extractTitleAndAuthorFromFilename(filename)
        val text = decodeText(bytes)

        val lines = text.lines()
        val chapters = mutableListOf<ParsedChapter>()

        var currentTitle: String? = null
        val currentContent = StringBuilder()

        for (line in lines) {
            val trimmed = line.trim()
            if (trimmed.isNotEmpty() && CHAPTER_TITLE_REGEX.matches(trimmed)) {
                if (currentTitle != null) {
                    chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
                    currentContent.clear()
                } else if (currentContent.isNotBlank()) {
                    // 第一章之前的内容作为前言/引子
                    chapters.add(ParsedChapter("前言", currentContent.toString().trim()))
                    currentContent.clear()
                }
                currentTitle = trimmed
            } else {
                if (currentContent.isNotEmpty()) {
                    currentContent.append("\n")
                }
                currentContent.append(line)
            }
        }

        if (currentTitle != null) {
            chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
        } else if (currentContent.isNotBlank()) {
            val remaining = currentContent.toString().trim()
            if (chapters.isEmpty()) {
                // 全书无章节匹配，按字数智能分页切分
                chapters.addAll(paginateText(remaining))
            } else {
                chapters.add(ParsedChapter("尾声", remaining))
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            listOf(ParsedChapter("正文", text.trim()))
        } else chapters

        val coverSvg = generateSvgCover(detectedTitle, detectedAuthor)

        return ParsedBook(
            title = detectedTitle,
            author = detectedAuthor,
            intro = if (finalChapters.firstOrNull()?.title == "前言") finalChapters.first().content.take(300) else null,
            coverBytes = coverSvg.toByteArray(StandardCharsets.UTF_8),
            coverContentType = "image/svg+xml",
            chapters = finalChapters,
            localFormat = "txt",
        )
    }

    /**
     * EPUB 规范解压与元数据、目录、正文提取
     */
    fun parseEpub(filename: String, bytes: ByteArray): ParsedBook {
        val entries = mutableMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zis ->
            var entry: ZipEntry? = zis.nextEntry
            while (entry != null) {
                if (!entry.isDirectory) {
                    val name = normalizeZipPath(entry.name)
                    entries[name] = zis.readAllBytes()
                }
                entry = zis.nextEntry
            }
        }

        // 1. 定位 container.xml
        val containerXmlBytes = entries["META-INF/container.xml"]
            ?: entries.entries.firstOrNull { it.key.equals("META-INF/container.xml", ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("无效的 EPUB 文件：缺少 META-INF/container.xml")

        val containerDoc = Jsoup.parse(String(containerXmlBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val rootfile = containerDoc.select("rootfiles > rootfile").firstOrNull()
            ?: containerDoc.select("rootfile").firstOrNull()
            ?: throw IllegalArgumentException("无效的 EPUB 文件：未找到 rootfile")

        val opfPath = normalizeZipPath(rootfile.attr("full-path"))
        val opfBytes = entries[opfPath]
            ?: entries.entries.firstOrNull { it.key.equals(opfPath, ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("未找到 OPF 描述文件：$opfPath")

        val opfBaseDir = if (opfPath.contains('/')) opfPath.substringBeforeLast('/') + "/" else ""
        val opfDoc = Jsoup.parse(String(opfBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())

        // 2. 提取元数据
        val (fileTitle, fileAuthor) = extractTitleAndAuthorFromFilename(filename)
        val title = opfDoc.select("metadata > dc|title, metadata > title").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileTitle
        val author = opfDoc.select("metadata > dc|creator, metadata > creator").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileAuthor
        val intro = opfDoc.select("metadata > dc|description, metadata > description").firstOrNull()?.text()?.trim()
            ?.ifBlank { null }

        // 3. Manifest 映射 (id -> href, media-type, properties)
        data class ManifestItem(val id: String, val href: String, val mediaType: String, val properties: String)
        val manifest = mutableMapOf<String, ManifestItem>()
        for (item in opfDoc.select("manifest > item")) {
            val id = item.attr("id")
            val rawHref = item.attr("href")
            val href = try { URLDecoder.decode(rawHref, "UTF-8") } catch (_: Throwable) { rawHref }
            val fullHref = normalizeZipPath(opfBaseDir + href)
            val mediaType = item.attr("media-type")
            val properties = item.attr("properties")
            manifest[id] = ManifestItem(id, fullHref, mediaType, properties)
        }

        // 4. 提取封面
        var coverBytes: ByteArray? = null
        var coverContentType: String? = null

        // 查找 meta cover 属性
        val coverMetaId = opfDoc.select("metadata > meta[name=cover]").attr("content").ifBlank { null }
        val coverItem = (coverMetaId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.properties.contains("cover-image") }
            ?: manifest.values.firstOrNull { it.id.equals("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }
            ?: manifest.values.firstOrNull { it.href.contains("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }

        if (coverItem != null) {
            val imgData = findZipEntry(entries, coverItem.href)
            if (imgData != null && imgData.isNotEmpty()) {
                coverBytes = imgData
                coverContentType = coverItem.mediaType.ifBlank { "image/jpeg" }
            }
        }

        if (coverBytes == null) {
            val coverSvg = generateSvgCover(title, author)
            coverBytes = coverSvg.toByteArray(StandardCharsets.UTF_8)
            coverContentType = "image/svg+xml"
        }

        // 5. 提取目录 (NCX 或 Nav 或 Spine)
        val chapters = mutableListOf<ParsedChapter>()

        // 尝试 NCX 目录
        val spineTocId = opfDoc.select("spine").attr("toc").ifBlank { null }
        val ncxItem = (spineTocId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.mediaType == "application/x-dtbncx+xml" || it.href.endsWith(".ncx", ignoreCase = true) }

        if (ncxItem != null) {
            val ncxBytes = findZipEntry(entries, ncxItem.href)
            if (ncxBytes != null) {
                val ncxBaseDir = if (ncxItem.href.contains('/')) ncxItem.href.substringBeforeLast('/') + "/" else ""
                val ncxDoc = Jsoup.parse(String(ncxBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
                val navPoints = ncxDoc.select("navMap > navPoint, navPoint")
                for (np in navPoints) {
                    val label = np.select("navLabel > text").firstOrNull()?.text()?.trim() ?: "章节"
                    val src = np.select("content").attr("src").substringBefore('#')
                    if (src.isNotBlank()) {
                        val fullPath = normalizeZipPath(ncxBaseDir + src)
                        val htmlBytes = findZipEntry(entries, fullPath)
                        if (htmlBytes != null) {
                            val content = extractHtmlContent(htmlBytes)
                            if (content.isNotBlank()) {
                                chapters.add(ParsedChapter(label, content))
                            }
                        }
                    }
                }
            }
        }

        // 若 NCX 解析为空，尝试 EPUB 3 Nav
        if (chapters.isEmpty()) {
            val navItem = manifest.values.firstOrNull { it.properties.contains("nav") }
            if (navItem != null) {
                val navBytes = findZipEntry(entries, navItem.href)
                if (navBytes != null) {
                    val navBaseDir = if (navItem.href.contains('/')) navItem.href.substringBeforeLast('/') + "/" else ""
                    val navDoc = Jsoup.parse(String(navBytes, StandardCharsets.UTF_8))
                    val links = navDoc.select("nav[epub|type=toc] a, nav a")
                    for (a in links) {
                        val label = a.text().trim().ifBlank { "章节" }
                        val src = a.attr("href").substringBefore('#')
                        if (src.isNotBlank()) {
                            val fullPath = normalizeZipPath(navBaseDir + src)
                            val htmlBytes = findZipEntry(entries, fullPath)
                            if (htmlBytes != null) {
                                val content = extractHtmlContent(htmlBytes)
                                if (content.isNotBlank()) {
                                    chapters.add(ParsedChapter(label, content))
                                }
                            }
                        }
                    }
                }
            }
        }

        // 若仍为空，按 Spine 线性顺序读取
        if (chapters.isEmpty()) {
            val itemrefs = opfDoc.select("spine > itemref")
            var idx = 1
            for (itemref in itemrefs) {
                val idref = itemref.attr("idref")
                val item = manifest[idref] ?: continue
                val htmlBytes = findZipEntry(entries, item.href) ?: continue
                val (extractedTitle, content) = extractHtmlTitleAndContent(htmlBytes, idx)
                if (content.isNotBlank()) {
                    chapters.add(ParsedChapter(extractedTitle, content))
                    idx++
                }
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            listOf(ParsedChapter("正文", "本书正文内容解析为空或为纯图片。"))
        } else chapters

        return ParsedBook(
            title = title,
            author = author,
            intro = intro,
            coverBytes = coverBytes,
            coverContentType = coverContentType,
            chapters = finalChapters,
            localFormat = "epub",
        )
    }

    /**
     * Markdown 本地文档解析：
     * - 自动识别编码（UTF-8 / BOM / UTF-16 / GB18030）
     * - 解析 YAML frontmatter（title / author / description / summary）
     * - 按 `#` / `##` 标题智能分章（忽略围栏代码块内部 `#` 注释）
     * - 每章保留原始 Markdown 语法并附带 [MARKDOWN_CONTENT_MARKER] 协议头
     */
    fun parseMarkdown(filename: String, bytes: ByteArray): ParsedBook {
        val rawText = decodeText(bytes).replace("\r\n", "\n").replace('\r', '\n')
        val (fileTitle, fileAuthor) = extractTitleAndAuthorFromFilename(filename)
        val (meta, bodyWithoutFrontmatter) = extractMarkdownFrontmatter(rawText)
        val body = bodyWithoutFrontmatter.trim()

        val firstH1 = findFirstTopLevelHeading(body, 1)
        val title = meta["title"]?.takeIf { it.isNotBlank() }
            ?: firstH1?.takeIf { it.isNotBlank() }
            ?: fileTitle
        val author = meta["author"]?.takeIf { it.isNotBlank() } ?: fileAuthor

        val rawChapters = if (body.isBlank()) {
            listOf(ParsedChapter("正文", ""))
        } else {
            splitMarkdownChapters(body, title)
        }

        val chapters = rawChapters.map { ch ->
            val contentBody = ch.content.trim()
            val wrapped = if (contentBody.isEmpty()) {
                MARKDOWN_CONTENT_MARKER
            } else {
                "$MARKDOWN_CONTENT_MARKER\n$contentBody"
            }
            ParsedChapter(ch.title, wrapped)
        }

        val intro = meta["description"]?.takeIf { it.isNotBlank() }
            ?: meta["summary"]?.takeIf { it.isNotBlank() }
            ?: rawChapters.firstOrNull()?.content?.let(::stripMarkdownForIntro)?.take(300)?.ifBlank { null }

        val coverSvg = generateSvgCover(title, author)
        return ParsedBook(
            title = title,
            author = author,
            intro = intro,
            coverBytes = coverSvg.toByteArray(StandardCharsets.UTF_8),
            coverContentType = "image/svg+xml",
            chapters = chapters,
            localFormat = "md",
        )
    }

    /**
     * Word（.docx / OOXML）原生解析：
     * - 安全解压 ZIP 校验 `word/document.xml`
     * - 读取 `docProps/core.xml`、`word/styles.xml`、`word/numbering.xml`、`word/_rels/document.xml.rels`
     * - 提取标题层级、粗体/斜体/删除线/行内代码/超链接、无序与有序列表、引用、GFM 表格及内嵌位图
     * - 转换为标准 Markdown 并智能分章
     */
    fun parseDocx(filename: String, bytes: ByteArray, bookId: String? = null): ParsedBook {
        if (!isZipSignature(bytes)) {
            throw IllegalArgumentException("无效的 DOCX 文件：文件头不是有效的 ZIP 压缩包")
        }
        val entries = readZipSafely(bytes)
        val docBytes = findZipEntry(entries, "word/document.xml")
            ?: throw IllegalArgumentException("无效的 DOCX 文件：缺少 word/document.xml")

        val (fileTitle, fileAuthor) = extractTitleAndAuthorFromFilename(filename)

        // 1. 提取文档属性元数据（docProps/core.xml）
        var title = fileTitle
        var author = fileAuthor
        var intro: String? = null
        findZipEntry(entries, "docProps/core.xml")?.let { coreBytes ->
            val coreDoc = Jsoup.parse(String(coreBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
            val coreRoot = coreDoc.children().firstOrNull()
            if (coreRoot != null) {
                coreRoot.children().firstOrNull { it.localTag() == "title" }?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { title = it }
                coreRoot.children().firstOrNull { it.localTag() == "creator" }?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { author = it }
                coreRoot.children().firstOrNull { it.localTag() == "description" }?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { intro = it }
            }
        }

        // 2. 解析样式定义（Heading1-6 / Quote / Code 及 basedOn 继承）
        val styleInfoMap = parseDocxStyles(findZipEntry(entries, "word/styles.xml"))

        // 3. 解析编号定义（有序列表 vs 无序列表）
        val numberingMap = parseDocxNumbering(findZipEntry(entries, "word/numbering.xml"))

        // 4. 解析关系（超链接 & 内嵌图片）
        val rels = parseDocxRelationships(findZipEntry(entries, "word/_rels/document.xml.rels"))

        // 5. 提取正文中引用到的位图资源（有序命名为 img_1.<ext>）
        val mediaFiles = linkedMapOf<String, ByteArray>()
        val mediaNameByTarget = mutableMapOf<String, String>()
        var firstCoverCandidate: Pair<ByteArray, String>? = null

        fun registerImage(relId: String): Pair<String, String>? {
            val rel = rels[relId] ?: return null
            if (rel.targetMode.equals("External", ignoreCase = true)) return null
            val resolvedPath = normalizeZipPath(
                if (rel.target.startsWith("/")) rel.target.removePrefix("/") else "word/${rel.target}"
            )
            mediaNameByTarget[resolvedPath]?.let { existingName ->
                val url = if (bookId != null) "/api/local-books/$bookId/media/$existingName" else "local-media://$existingName"
                return existingName to url
            }
            if (mediaFiles.size >= MAX_DOCX_MEDIA_FILES) return null
            val ext = resolvedPath.substringAfterLast('.', "").lowercase()
            val contentType = when (ext) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                else -> return null
            }
            val imgBytes = findZipEntry(entries, resolvedPath) ?: return null
            if (imgBytes.isEmpty() || imgBytes.size > MAX_DOCX_MEDIA_BYTES) return null

            val normExt = if (ext == "jpeg") "jpg" else ext
            val safeName = "img_${mediaFiles.size + 1}.$normExt"
            mediaFiles[safeName] = imgBytes
            mediaNameByTarget[resolvedPath] = safeName
            if (firstCoverCandidate == null && imgBytes.size in 2048..(2 * 1024 * 1024)) {
                firstCoverCandidate = imgBytes to contentType
            }
            val url = if (bookId != null) "/api/local-books/$bookId/media/$safeName" else "local-media://$safeName"
            return safeName to url
        }

        // 6. 解析 word/document.xml 主体转为结构化 Markdown 块
        val documentXml = Jsoup.parse(String(docBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val bodyEl = documentXml.allElements.firstOrNull { it.localTag() == "body" }
            ?: throw IllegalArgumentException("无效的 DOCX 文件：缺少 body 节点")

        val blocks = mutableListOf<String>()
        var listLinesBuffer = mutableListOf<String>()
        var listOrderedState: Boolean? = null
        var quoteLinesBuffer = mutableListOf<String>()
        var codeLinesBuffer = mutableListOf<String>()

        fun flushList() {
            if (listLinesBuffer.isNotEmpty()) {
                blocks.add(listLinesBuffer.joinToString("\n"))
                listLinesBuffer = mutableListOf()
                listOrderedState = null
            }
        }

        fun flushQuote() {
            if (quoteLinesBuffer.isNotEmpty()) {
                blocks.add(quoteLinesBuffer.joinToString("\n"))
                quoteLinesBuffer = mutableListOf()
            }
        }

        fun flushCode() {
            if (codeLinesBuffer.isNotEmpty()) {
                val maxTicks = Regex("`+").findAll(codeLinesBuffer.joinToString("\n")).maxOfOrNull { it.value.length } ?: 0
                val fence = "`".repeat(maxOf(3, maxTicks + 1))
                blocks.add("$fence\n${codeLinesBuffer.joinToString("\n")}\n$fence")
                codeLinesBuffer = mutableListOf()
            }
        }

        fun flushAllPending() {
            flushList()
            flushQuote()
            flushCode()
        }

        for (child in bodyEl.children()) {
            when (child.localTag()) {
                "p" -> {
                    val pPr = child.children().firstOrNull { it.localTag() == "pPr" }
                    val styleId = pPr?.children()?.firstOrNull { it.localTag() == "pStyle" }?.attr("w:val")
                        ?.ifBlank { pPr.children().firstOrNull { it.localTag() == "pStyle" }?.attr("val") }
                    val resolvedStyle = styleId?.let { styleInfoMap[it] }
                    val ownOutline = pPr?.children()?.firstOrNull { it.localTag() == "outlineLvl" }
                        ?.let { attrCompat(it, "val")?.toIntOrNull() }
                        ?.takeIf { it in 0..5 }
                        ?.plus(1)
                    val headingLevel = ownOutline ?: resolvedStyle?.headingLevel

                    val numPr = pPr?.children()?.firstOrNull { it.localTag() == "numPr" }
                    val numId = numPr?.children()?.firstOrNull { it.localTag() == "numId" }?.let { attrCompat(it, "val") }
                    val ilvl = numPr?.children()?.firstOrNull { it.localTag() == "ilvl" }?.let { attrCompat(it, "val")?.toIntOrNull() } ?: 0

                    val inlineContent = extractDocxParagraphMarkdown(
                        paragraph = child,
                        rels = rels,
                        imageResolver = ::registerImage,
                        stripFormatting = (headingLevel != null),
                        codeParagraph = (resolvedStyle?.isCode == true),
                    )
                    val plainText = inlineContent.trim()
                    if (plainText.isEmpty()) {
                        flushAllPending()
                        continue
                    }

                    when {
                        headingLevel != null -> {
                            flushAllPending()
                            val cleanHeading = plainText.replace('\n', ' ').trim()
                            blocks.add("${"#".repeat(headingLevel.coerceIn(1, 6))} $cleanHeading")
                        }
                        resolvedStyle?.isCode == true -> {
                            flushList()
                            flushQuote()
                            codeLinesBuffer.addAll(plainText.lines())
                        }
                        numId != null && numId != "0" -> {
                            flushQuote()
                            flushCode()
                            val ordered = numberingMap[numId]?.get(ilvl) ?: false
                            if (listOrderedState != null && listOrderedState != ordered) {
                                flushList()
                            }
                            listOrderedState = ordered
                            val indent = "  ".repeat(ilvl.coerceIn(0, 4))
                            val prefix = if (ordered) "1. " else "- "
                            val normalizedLine = plainText.replace('\n', ' ').trim()
                            listLinesBuffer.add("$indent$prefix$normalizedLine")
                        }
                        resolvedStyle?.isQuote == true -> {
                            flushList()
                            flushCode()
                            for (qLine in plainText.lines()) {
                                val trimmedQ = qLine.trim()
                                quoteLinesBuffer.add(if (trimmedQ.isEmpty()) ">" else "> $trimmedQ")
                            }
                        }
                        else -> {
                            flushAllPending()
                            blocks.add(plainText)
                        }
                    }
                }
                "tbl" -> {
                    flushAllPending()
                    val mdTable = convertDocxTableToMarkdown(child, rels, ::registerImage)
                    if (mdTable != null) {
                        blocks.add(mdTable)
                    }
                }
                "sdt" -> {
                    // 结构化文档控件里的正文补充读取
                    flushAllPending()
                    val sdtContent = child.children().firstOrNull { it.localTag() == "sdtContent" }
                    if (sdtContent != null) {
                        for (inner in sdtContent.children()) {
                            if (inner.localTag() == "p") {
                                val t = extractDocxParagraphMarkdown(inner, rels, ::registerImage).trim()
                                if (t.isNotEmpty()) blocks.add(t)
                            }
                        }
                    }
                }
            }
        }
        flushAllPending()

        val markdownText = blocks.joinToString("\n\n").trim()
        // 若 core.xml 未设标题，尝试用首个 H1 兜底
        if (title == fileTitle) {
            findFirstTopLevelHeading(markdownText, 1)?.takeIf { it.isNotBlank() }?.let { title = it }
        }

        val rawChapters = if (markdownText.isBlank()) {
            listOf(ParsedChapter("正文", "本书正文内容解析为空。"))
        } else {
            splitMarkdownChapters(markdownText, title)
        }

        val chapters = rawChapters.map { ch ->
            val contentBody = ch.content.trim()
            val wrapped = if (contentBody.isEmpty()) MARKDOWN_CONTENT_MARKER else "$MARKDOWN_CONTENT_MARKER\n$contentBody"
            ParsedChapter(ch.title, wrapped)
        }

        if (intro.isNullOrBlank()) {
            intro = rawChapters.firstOrNull()?.content?.let(::stripMarkdownForIntro)?.take(300)?.ifBlank { null }
        }

        val coverBytes: ByteArray
        val coverContentType: String
        val coverPair = firstCoverCandidate
        if (coverPair != null) {
            coverBytes = coverPair.first
            coverContentType = coverPair.second
        } else {
            coverBytes = generateSvgCover(title, author).toByteArray(StandardCharsets.UTF_8)
            coverContentType = "image/svg+xml"
        }

        return ParsedBook(
            title = title,
            author = author,
            intro = intro,
            coverBytes = coverBytes,
            coverContentType = coverContentType,
            chapters = chapters,
            mediaFiles = mediaFiles,
            localFormat = "docx",
        )
    }

    private fun isZipSignature(bytes: ByteArray): Boolean {
        return bytes.size >= 4 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4B.toByte()
    }

    private fun readZipSafely(bytes: ByteArray): Map<String, ByteArray> {
        val entries = mutableMapOf<String, ByteArray>()
        var totalBytes = 0L
        var count = 0
        val buffer = ByteArray(8192)
        ZipInputStream(ByteArrayInputStream(bytes)).use { zis ->
            var entry: ZipEntry? = zis.nextEntry
            while (entry != null) {
                if (!entry.isDirectory) {
                    count++
                    if (count > MAX_ZIP_ENTRIES) {
                        throw IllegalArgumentException("压缩包条目过多（超过 $MAX_ZIP_ENTRIES 个）")
                    }
                    val name = normalizeZipPath(entry.name)
                    if (name.isNotEmpty()) {
                        val out = java.io.ByteArrayOutputStream()
                        var entryBytes = 0L
                        while (true) {
                            val read = zis.read(buffer)
                            if (read <= 0) break
                            entryBytes += read
                            totalBytes += read
                            if (entryBytes > MAX_ZIP_ENTRY_BYTES || totalBytes > MAX_ZIP_TOTAL_BYTES) {
                                throw IllegalArgumentException("DOCX 解压内容超出安全大小上限")
                            }
                            out.write(buffer, 0, read)
                        }
                        entries[name] = out.toByteArray()
                    }
                }
                entry = zis.nextEntry
            }
        }
        return entries
    }

    private fun Element.localTag(): String = tagName().substringAfter(':')

    private fun attrCompat(el: Element, localAttrName: String): String? {
        for (attr in el.attributes()) {
            if (attr.key.substringAfter(':') == localAttrName) {
                return attr.value
            }
        }
        return null
    }

    private data class DocxStyleRaw(
        val styleId: String,
        val basedOn: String?,
        val name: String?,
        val outlineLvl: Int?,
        val isQuote: Boolean,
        val isCode: Boolean,
    )

    private data class DocxStyleResolved(
        val headingLevel: Int?,
        val isQuote: Boolean,
        val isCode: Boolean,
    )

    private data class DocxRel(
        val type: String,
        val target: String,
        val targetMode: String,
    )

    private data class InlineSpan(
        val text: String,
        val bold: Boolean,
        val italic: Boolean,
        val strike: Boolean,
        val code: Boolean,
        val rawMarkdown: Boolean = false,
    )

    private fun parseDocxStyles(stylesBytes: ByteArray?): Map<String, DocxStyleResolved> {
        if (stylesBytes == null) return emptyMap()
        val doc = Jsoup.parse(String(stylesBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val rawMap = mutableMapOf<String, DocxStyleRaw>()

        for (styleEl in doc.allElements.filter { it.localTag() == "style" }) {
            val type = attrCompat(styleEl, "type")
            if (type != null && !type.equals("paragraph", ignoreCase = true)) continue
            val styleId = attrCompat(styleEl, "styleId")?.takeIf { it.isNotBlank() } ?: continue
            val name = styleEl.children().firstOrNull { it.localTag() == "name" }?.let { attrCompat(it, "val") }
            val basedOn = styleEl.children().firstOrNull { it.localTag() == "basedOn" }?.let { attrCompat(it, "val") }
            val pPr = styleEl.children().firstOrNull { it.localTag() == "pPr" }
            val outlineLvl = pPr?.children()?.firstOrNull { it.localTag() == "outlineLvl" }
                ?.let { attrCompat(it, "val")?.toIntOrNull() }
                ?.takeIf { it in 0..5 }
                ?.plus(1)
            val nameLower = name?.lowercase().orEmpty()
            val idLower = styleId.lowercase()
            val isQuote = nameLower.contains("quote") || nameLower.contains("引用") || idLower.contains("quote")
            val isCode = nameLower.contains("code") || nameLower.contains("代码") || idLower.contains("code")
            rawMap[styleId] = DocxStyleRaw(styleId, basedOn, name, outlineLvl, isQuote, isCode)
        }

        fun headingFromLabel(raw: DocxStyleRaw): Int? {
            if (raw.outlineLvl != null) return raw.outlineLvl
            val candidates = listOfNotNull(raw.name, raw.styleId)
            for (c in candidates) {
                val trimmed = c.trim()
                Regex("""^(?:heading|标题|見出し)\s*([1-6])$""", RegexOption.IGNORE_CASE).matchEntire(trimmed)
                    ?.let { return it.groupValues[1].toInt() }
                Regex("""^h([1-6])$""", RegexOption.IGNORE_CASE).matchEntire(trimmed)
                    ?.let { return it.groupValues[1].toInt() }
                if (trimmed.equals("Title", ignoreCase = true) || trimmed == "标题") return 1
                if (trimmed.equals("Subtitle", ignoreCase = true) || trimmed == "副标题") return 2
            }
            return null
        }

        val resolved = mutableMapOf<String, DocxStyleResolved>()
        for (id in rawMap.keys) {
            var curId: String? = id
            var depth = 0
            var hLevel: Int? = null
            var isQuote = false
            var isCode = false
            while (curId != null && depth < 6) {
                val r = rawMap[curId] ?: break
                if (hLevel == null) hLevel = headingFromLabel(r)
                isQuote = isQuote || r.isQuote
                isCode = isCode || r.isCode
                curId = r.basedOn
                depth++
            }
            resolved[id] = DocxStyleResolved(hLevel, isQuote, isCode)
        }
        return resolved
    }

    private fun parseDocxNumbering(numberingBytes: ByteArray?): Map<String, Map<Int, Boolean>> {
        if (numberingBytes == null) return emptyMap()
        val doc = Jsoup.parse(String(numberingBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val abstractFormats = mutableMapOf<String, Map<Int, Boolean>>()
        for (absEl in doc.allElements.filter { it.localTag() == "abstractNum" }) {
            val absId = attrCompat(absEl, "abstractNumId") ?: continue
            val lvlMap = mutableMapOf<Int, Boolean>()
            for (lvlEl in absEl.children().filter { it.localTag() == "lvl" }) {
                val ilvl = attrCompat(lvlEl, "ilvl")?.toIntOrNull() ?: continue
                val numFmt = lvlEl.children().firstOrNull { it.localTag() == "numFmt" }?.let { attrCompat(it, "val") } ?: "bullet"
                lvlMap[ilvl] = !numFmt.equals("bullet", ignoreCase = true) && !numFmt.equals("none", ignoreCase = true)
            }
            abstractFormats[absId] = lvlMap
        }
        val numMap = mutableMapOf<String, Map<Int, Boolean>>()
        for (numEl in doc.allElements.filter { it.localTag() == "num" }) {
            val numId = attrCompat(numEl, "numId") ?: continue
            val absId = numEl.children().firstOrNull { it.localTag() == "abstractNumId" }?.let { attrCompat(it, "val") } ?: continue
            abstractFormats[absId]?.let { numMap[numId] = it }
        }
        return numMap
    }

    private fun parseDocxRelationships(relsBytes: ByteArray?): Map<String, DocxRel> {
        if (relsBytes == null) return emptyMap()
        val doc = Jsoup.parse(String(relsBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val map = mutableMapOf<String, DocxRel>()
        for (relEl in doc.allElements.filter { it.localTag() == "Relationship" }) {
            val id = attrCompat(relEl, "Id") ?: continue
            val type = attrCompat(relEl, "Type") ?: ""
            val target = attrCompat(relEl, "Target") ?: continue
            val targetMode = attrCompat(relEl, "TargetMode") ?: ""
            map[id] = DocxRel(type, target, targetMode)
        }
        return map
    }

    private fun extractDocxParagraphMarkdown(
        paragraph: Element,
        rels: Map<String, DocxRel>,
        imageResolver: (String) -> Pair<String, String>?,
        stripFormatting: Boolean = false,
        codeParagraph: Boolean = false,
        inTableCell: Boolean = false,
    ): String {
        val spans = mutableListOf<InlineSpan>()

        fun isToggleOn(rPr: Element?, tagName: String): Boolean {
            val el = rPr?.children()?.firstOrNull { it.localTag() == tagName } ?: return false
            val v = attrCompat(el, "val") ?: return true
            return v != "0" && !v.equals("false", ignoreCase = true) && !v.equals("none", ignoreCase = true)
        }

        fun isMonospaceRun(rPr: Element?): Boolean {
            if (rPr == null || codeParagraph || stripFormatting) return false
            val rFonts = rPr.children().firstOrNull { it.localTag() == "rFonts" } ?: return false
            val fontNames = listOfNotNull(
                attrCompat(rFonts, "ascii"),
                attrCompat(rFonts, "hAnsi"),
                attrCompat(rFonts, "cs"),
            ).joinToString(" ").lowercase()
            return fontNames.contains("consolas") ||
                fontNames.contains("courier") ||
                fontNames.contains("mono") ||
                fontNames.contains("menlo") ||
                fontNames.contains("monaco") ||
                fontNames.contains("fira code") ||
                fontNames.contains("source code")
        }

        fun collectRun(runEl: Element, insideLink: Boolean = false) {
            val rPr = runEl.children().firstOrNull { it.localTag() == "rPr" }
            val bold = !stripFormatting && !insideLink && isToggleOn(rPr, "b")
            val italic = !stripFormatting && !insideLink && isToggleOn(rPr, "i")
            val strike = !stripFormatting && !insideLink && (isToggleOn(rPr, "strike") || isToggleOn(rPr, "dstrike"))
            val code = !stripFormatting && !insideLink && !codeParagraph && isMonospaceRun(rPr)

            for (child in runEl.children()) {
                when (child.localTag()) {
                    "t" -> {
                        val txt = child.wholeText()
                        if (txt.isNotEmpty()) {
                            spans.add(InlineSpan(txt, bold, italic, strike, code))
                        }
                    }
                    "tab" -> spans.add(InlineSpan(" ", false, false, false, false))
                    "br", "cr" -> spans.add(InlineSpan(if (inTableCell) " " else "\n", false, false, false, false))
                    "drawing", "pict" -> {
                        if (!stripFormatting && !inTableCell) {
                            val blip = child.allElements.firstOrNull { it.localTag() == "blip" }
                            val relId = blip?.let { attrCompat(it, "embed") ?: attrCompat(it, "link") }
                                ?: child.allElements.firstOrNull { it.localTag() == "imagedata" }?.let { attrCompat(it, "id") }
                            if (relId != null) {
                                val resolved = imageResolver(relId)
                                if (resolved != null) {
                                    val altText = child.allElements.firstOrNull { it.localTag() == "docPr" }
                                        ?.let { attrCompat(it, "descr") ?: attrCompat(it, "name") }
                                        ?.replace("[", "")?.replace("]", "")?.replace("\n", " ")?.trim()
                                        ?.ifEmpty { "图片" } ?: "图片"
                                    val prefix = if (spans.isNotEmpty() && !spans.last().text.endsWith("\n")) "\n\n" else ""
                                    spans.add(InlineSpan("${prefix}![$altText](${resolved.second})\n\n", false, false, false, false, rawMarkdown = true))
                                }
                            }
                        }
                    }
                    "instrText", "delText" -> { /* 忽略 Word 域指令及修订删除内容 */ }
                }
            }
        }

        fun walkNodes(container: Element) {
            for (child in container.children()) {
                when (child.localTag()) {
                    "r" -> collectRun(child)
                    "hyperlink" -> {
                        val relId = attrCompat(child, "id")
                        val target = relId?.let { rels[it] }?.target?.trim()
                        val safeUrl = target?.takeIf {
                            it.startsWith("https://", ignoreCase = true) ||
                                it.startsWith("http://", ignoreCase = true) ||
                                it.startsWith("mailto:", ignoreCase = true)
                        }
                        val linkBuffer = mutableListOf<InlineSpan>()
                        for (linkChild in child.children()) {
                            if (linkChild.localTag() == "r") {
                                val before = spans.size
                                collectRun(linkChild, insideLink = true)
                                while (spans.size > before) {
                                    linkBuffer.add(spans.removeAt(before))
                                }
                            }
                        }
                        val label = linkBuffer.joinToString("") { it.text }.trim()
                        if (label.isNotEmpty()) {
                            if (!stripFormatting && safeUrl != null) {
                                val escapedLabel = label.replace("[", "\\[").replace("]", "\\]")
                                spans.add(InlineSpan("[$escapedLabel]($safeUrl)", false, false, false, false, rawMarkdown = true))
                            } else {
                                spans.add(InlineSpan(label, false, false, false, false))
                            }
                        }
                    }
                    "ins" -> walkNodes(child)
                    "smartTag" -> walkNodes(child)
                    // 忽略 pPr、del（删除修订）、bookmarkStart/End、proofErr 等非正文节点
                }
            }
        }

        walkNodes(paragraph)
        if (spans.isEmpty()) return ""

        // 合并相邻同样式文本 run，避免产出 `**字****词**`
        val merged = mutableListOf<InlineSpan>()
        for (span in spans) {
            val prev = merged.lastOrNull()
            if (prev != null &&
                !prev.rawMarkdown &&
                !span.rawMarkdown &&
                prev.bold == span.bold &&
                prev.italic == span.italic &&
                prev.strike == span.strike &&
                prev.code == span.code
            ) {
                merged[merged.lastIndex] = prev.copy(text = prev.text + span.text)
            } else {
                merged.add(span)
            }
        }

        val sb = StringBuilder()
        for (span in merged) {
            if (span.rawMarkdown || (!span.bold && !span.italic && !span.strike && !span.code)) {
                sb.append(span.text)
                continue
            }
            val leadingWs = span.text.takeWhile { it == ' ' || it == '\t' }
            val trailingWs = span.text.takeLastWhile { it == ' ' || it == '\t' }
            val coreStart = leadingWs.length
            val coreEnd = (span.text.length - trailingWs.length).coerceAtLeast(coreStart)
            val core = span.text.substring(coreStart, coreEnd)
            if (core.isEmpty()) {
                sb.append(span.text)
                continue
            }
            sb.append(leadingWs)
            if (span.code) {
                val safeCore = core.replace("`", "\\`")
                sb.append('`').append(safeCore).append('`')
            } else {
                var formatted = core
                if (span.strike) formatted = "~~$formatted~~"
                if (span.bold && span.italic) {
                    formatted = "***$formatted***"
                } else if (span.bold) {
                    formatted = "**$formatted**"
                } else if (span.italic) {
                    formatted = "*$formatted*"
                }
                sb.append(formatted)
            }
            sb.append(trailingWs)
        }
        return sb.toString()
    }

    private fun convertDocxTableToMarkdown(
        tableEl: Element,
        rels: Map<String, DocxRel>,
        imageResolver: (String) -> Pair<String, String>?,
    ): String? {
        val rows = mutableListOf<List<String>>()
        for (tr in tableEl.children().filter { it.localTag() == "tr" }) {
            val cells = mutableListOf<String>()
            for (tc in tr.children().filter { it.localTag() == "tc" }) {
                val cellText = tc.children()
                    .filter { it.localTag() == "p" }
                    .map { extractDocxParagraphMarkdown(it, rels, imageResolver, inTableCell = true).trim() }
                    .filter { it.isNotEmpty() }
                    .joinToString(" ")
                    .replace("|", "\\|")
                    .replace(Regex("""\s+"""), " ")
                    .trim()
                cells.add(cellText)
            }
            if (cells.isNotEmpty()) rows.add(cells)
        }
        if (rows.isEmpty()) return null
        val colCount = rows.maxOf { it.size }.coerceAtLeast(1)

        fun formatRow(cells: List<String>): String {
            val padded = (0 until colCount).map { idx -> cells.getOrElse(idx) { "" } }
            return "| ${padded.joinToString(" | ")} |"
        }

        val header = formatRow(rows.first())
        val separator = "| ${List(colCount) { "---" }.joinToString(" | ")} |"
        val bodyRows = rows.drop(1).map(::formatRow)
        return (listOf(header, separator) + bodyRows).joinToString("\n")
    }

    private fun extractMarkdownFrontmatter(text: String): Pair<Map<String, String>, String> {
        val lines = text.lines()
        if (lines.firstOrNull()?.trim() != "---") {
            return emptyMap<String, String>() to text
        }
        val maxSearch = minOf(lines.size - 1, 60)
        var endIdx = -1
        for (i in 1..maxSearch) {
            val trimmed = lines[i].trim()
            if (trimmed == "---" || trimmed == "...") {
                endIdx = i
                break
            }
        }
        if (endIdx < 0) return emptyMap<String, String>() to text

        val meta = mutableMapOf<String, String>()
        for (i in 1 until endIdx) {
            val line = lines[i]
            val colonIdx = line.indexOf(':')
            if (colonIdx <= 0) continue
            val key = line.substring(0, colonIdx).trim().lowercase()
            var value = line.substring(colonIdx + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
                (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2)
            ) {
                value = value.substring(1, value.length - 1).trim()
            }
            if (key.isNotEmpty() && value.isNotEmpty()) {
                meta[key] = value
            }
        }
        val rest = lines.drop(endIdx + 1).joinToString("\n")
        return meta to rest
    }

    private data class MarkdownHeadingHit(
        val lineIndex: Int,
        val level: Int,
        val title: String,
    )

    private fun scanTopLevelMarkdownHeadings(lines: List<String>): List<MarkdownHeadingHit> {
        val hits = mutableListOf<MarkdownHeadingHit>()
        var fenceChar: Char? = null
        var fenceLen = 0
        for (i in lines.indices) {
            val line = lines[i]
            val fence = FENCE_START_REGEX.matchEntire(line)
            if (fenceChar == null) {
                if (fence != null) {
                    fenceChar = fence.groupValues[1][0]
                    fenceLen = fence.groupValues[1].length
                    continue
                }
            } else {
                val trimmed = line.trim()
                if (trimmed.length >= fenceLen && trimmed.all { it == fenceChar }) {
                    fenceChar = null
                    fenceLen = 0
                }
                continue
            }
            val match = ATX_HEADING_REGEX.matchEntire(line)
            if (match != null) {
                hits.add(MarkdownHeadingHit(i, match.groupValues[1].length, match.groupValues[2].trim()))
            }
        }
        return hits
    }

    private fun findFirstTopLevelHeading(text: String, level: Int): String? {
        return scanTopLevelMarkdownHeadings(text.lines()).firstOrNull { it.level == level }?.title
    }

    /**
     * 按 Markdown 标题层级智能分章，确保：
     * 1. 围栏代码块内部的 `#` 绝不误判为章节标题；
     * 2. 拆出的章节标题不重复保留在正文首行；
     * 3. 温和按块切分时不在代码块或连续表格中间切断。
     */
    internal fun splitMarkdownChapters(rawBody: String, fallbackBookTitle: String): List<ParsedChapter> {
        val body = rawBody.trim()
        if (body.isEmpty()) return listOf(ParsedChapter("正文", ""))

        val lines = body.lines()
        val headings = scanTopLevelMarkdownHeadings(lines)
        val h1Hits = headings.filter { it.level == 1 }
        val h2Hits = headings.filter { it.level == 2 }

        fun sliceByHits(splitHits: List<MarkdownHeadingHit>, dropLeadingH1IfSameLine: Int? = null): List<ParsedChapter> {
            val result = mutableListOf<ParsedChapter>()
            val firstIdx = splitHits.first().lineIndex
            val preLines = lines.subList(0, firstIdx).filterIndexed { idx, _ -> idx != dropLeadingH1IfSameLine }
            val preText = preLines.joinToString("\n").trim()
            if (preText.isNotEmpty()) {
                result.add(ParsedChapter("前言", preText))
            }
            for (i in splitHits.indices) {
                val startLine = splitHits[i].lineIndex + 1
                val endLine = if (i + 1 < splitHits.size) splitHits[i + 1].lineIndex else lines.size
                val content = if (startLine < endLine) lines.subList(startLine, endLine).joinToString("\n").trim() else ""
                val chapterTitle = splitHits[i].title.ifBlank { "第 ${i + 1} 章" }
                if (content.isNotEmpty() || splitHits.size == 1) {
                    result.add(ParsedChapter(chapterTitle, content.ifEmpty { chapterTitle }))
                } else {
                    result.add(ParsedChapter(chapterTitle, chapterTitle))
                }
            }
            return result
        }

        if (h1Hits.size >= 2) {
            return sliceByHits(h1Hits)
        }
        if (h2Hits.size >= 2) {
            val singleH1Idx = h1Hits.singleOrNull()?.lineIndex
            return sliceByHits(h2Hits, dropLeadingH1IfSameLine = singleH1Idx)
        }
        if (h1Hits.size == 1 && body.length <= 8000) {
            return sliceByHits(h1Hits)
        }

        // 若是把普通小说章节存成了 Markdown 文件，沿用小说章节正则
        val chapterMatches = mutableListOf<MarkdownHeadingHit>()
        var fenceChar: Char? = null
        var fenceLen = 0
        for (i in lines.indices) {
            val line = lines[i]
            val fence = FENCE_START_REGEX.matchEntire(line)
            if (fenceChar == null) {
                if (fence != null) {
                    fenceChar = fence.groupValues[1][0]
                    fenceLen = fence.groupValues[1].length
                    continue
                }
            } else {
                val trimmed = line.trim()
                if (trimmed.length >= fenceLen && trimmed.all { it == fenceChar }) {
                    fenceChar = null
                    fenceLen = 0
                }
                continue
            }
            val trimmed = line.trim()
            if (trimmed.isNotEmpty() && CHAPTER_TITLE_REGEX.matches(trimmed)) {
                chapterMatches.add(MarkdownHeadingHit(i, 1, trimmed))
            }
        }
        if (chapterMatches.size >= 2) {
            return sliceByHits(chapterMatches)
        }

        // 长篇无标文档温和按安全块边界切分（绝不切碎围栏代码块或表格）
        return paginateMarkdownSafely(lines, if (h1Hits.size == 1) h1Hits.first().title else fallbackBookTitle)
    }

    private fun paginateMarkdownSafely(lines: List<String>, singleTitle: String, chunkSize: Int = 6000): List<ParsedChapter> {
        val totalLen = lines.sumOf { it.length + 1 }
        if (totalLen <= chunkSize) {
            return listOf(ParsedChapter(singleTitle.ifBlank { "正文" }, lines.joinToString("\n").trim()))
        }

        val chapters = mutableListOf<ParsedChapter>()
        val current = StringBuilder()
        var fenceChar: Char? = null
        var fenceLen = 0
        var page = 1

        for (i in lines.indices) {
            val line = lines[i]
            val fence = FENCE_START_REGEX.matchEntire(line)
            if (fenceChar == null) {
                if (fence != null) {
                    fenceChar = fence.groupValues[1][0]
                    fenceLen = fence.groupValues[1].length
                }
            } else {
                val trimmed = line.trim()
                if (trimmed.length >= fenceLen && trimmed.all { it == fenceChar }) {
                    fenceChar = null
                    fenceLen = 0
                }
            }

            if (current.isNotEmpty()) current.append('\n')
            current.append(line)

            val inTableRow = line.trimStart().startsWith('|')
            val isBlankBoundary = line.isBlank()
            if (fenceChar == null && !inTableRow && isBlankBoundary && current.length >= chunkSize) {
                val chunk = current.toString().trim()
                if (chunk.isNotEmpty()) {
                    chapters.add(ParsedChapter("第 $page 节", chunk))
                    page++
                }
                current.clear()
            }
        }
        val tail = current.toString().trim()
        if (tail.isNotEmpty()) {
            chapters.add(ParsedChapter(if (chapters.isEmpty()) singleTitle.ifBlank { "正文" } else "第 $page 节", tail))
        }
        return chapters.ifEmpty { listOf(ParsedChapter(singleTitle.ifBlank { "正文" }, "")) }
    }

    private fun stripMarkdownForIntro(markdown: String): String {
        return markdown.lines()
            .filterNot { it.trim().startsWith("```") || it.trim().startsWith("~~~") || it.trim().startsWith("<!--") }
            .joinToString(" ") { line ->
                line.replace(Regex("""^#{1,6}\s+"""), "")
                    .replace(Regex("""^>\s*"""), "")
                    .replace(Regex("""!\[([^\]]*)\]\([^)]+\)"""), "$1")
                    .replace(Regex("""\[([^\]]+)\]\([^)]+\)"""), "$1")
                    .replace(Regex("""[*_`~|]+"""), "")
                    .trim()
            }
            .replace(Regex("""\s+"""), " ")
            .trim()
    }

    private fun findZipEntry(entries: Map<String, ByteArray>, path: String): ByteArray? {
        val norm = normalizeZipPath(path)
        return entries[norm] ?: entries.entries.firstOrNull { it.key.equals(norm, ignoreCase = true) }?.value
    }

    private fun extractHtmlContent(bytes: ByteArray): String {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        return htmlToText(doc)
    }

    private fun extractHtmlTitleAndContent(bytes: ByteArray, defaultIndex: Int): Pair<String, String> {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        val titleCandidate = doc.select("h1, h2, title").firstOrNull()?.text()?.trim()
        val title = if (!titleCandidate.isNullOrBlank() && titleCandidate.length <= 40) {
            titleCandidate
        } else {
            "第 $defaultIndex 章"
        }
        return title to htmlToText(doc)
    }

    /**
     * HTML 转纯文本，**保留段落边界**。
     *
     * 历史实现是 `select(...).prepend("\n\n")` 再取 `Element.text()`，这是错的：
     * Jsoup 的 `text()` 会把所有空白字符（含 `\n`）归一化成空格，插进去的换行会被全部吃掉，
     * 结果是整章正文被压成**一行**、阅读页完全没有分段。
     *
     * 正确做法：块级元素边界改用**非空白占位符**（字面量 `\n` 两个字符）标记，
     * 它能活过 `text()` 的空白归一化，取完文本后再统一换回真正的换行。
     */
    private fun htmlToText(doc: Document): String {
        doc.select("script, style, link, meta, head, title").remove()
        doc.select("br").append("\\n")
        doc.select("p, div, h1, h2, h3, h4, h5, h6, tr, li, blockquote, section, article").prepend("\\n")
        val raw = doc.body()?.text() ?: doc.text()
        return cleanText(raw.replace("\\n", "\n"))
    }

    private fun cleanText(text: String): String {
        return text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
    }

    private fun paginateText(text: String, chunkSize: Int = 4000): List<ParsedChapter> {
        if (text.length <= chunkSize) {
            return listOf(ParsedChapter("正文", text))
        }
        val chapters = mutableListOf<ParsedChapter>()
        var start = 0
        var page = 1
        while (start < text.length) {
            var end = (start + chunkSize).coerceAtMost(text.length)
            if (end < text.length) {
                // 尝试在自然换行处切分
                val newlineIdx = text.lastIndexOf('\n', end)
                if (newlineIdx > start + chunkSize / 2) {
                    end = newlineIdx + 1
                }
            }
            val chunk = text.substring(start, end).trim()
            if (chunk.isNotEmpty()) {
                chapters.add(ParsedChapter("第 $page 节", chunk))
                page++
            }
            start = end
        }
        return chapters
    }

    /**
     * 智能编码探测：UTF-8, UTF-8 BOM, UTF-16, GB18030/GBK
     */
    fun decodeText(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""

        // 1. 检查 BOM
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, StandardCharsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16BE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16LE)
        }

        // 2. 尝试严格 UTF-8 解码
        try {
            val decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // UTF-8 严格解码失败
        }

        // 3. 尝试 GB18030 (向下兼容 GBK, GB2312)
        try {
            val gbkCharset = Charset.forName("GB18030")
            val decoder = gbkCharset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // GB18030 严格解码失败
        }

        // 4. 容错回退
        return String(bytes, StandardCharsets.UTF_8)
    }

    /**
     * 从文件名中提取书名与作者
     */
    fun extractTitleAndAuthorFromFilename(filename: String): Pair<String, String?> {
        val cleanName = filename.substringBeforeLast('.').trim()
        val authorRegexes = listOf(
            Regex("""(?:作者|著)[:：\s]+([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""[《【\[](.+?)[》】\]]\s*(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""^(.+?)[_—\-\s]+(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)$"""),
            Regex("""^(.+?)\s*\(([^\(\)]+)\)$"""),
        )

        for (regex in authorRegexes) {
            val match = regex.find(cleanName)
            if (match != null) {
                val groups = match.groupValues
                if (groups.size == 3) {
                    val title = sanitizeTitle(groups[1])
                    val author = groups[2].trim()
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                } else if (groups.size == 2) {
                    val author = groups[1].trim()
                    val title = sanitizeTitle(cleanName.replace(match.value, ""))
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                }
            }
        }

        return sanitizeTitle(cleanName) to null
    }

    private fun sanitizeTitle(raw: String): String {
        return raw.replace(Regex("""^[《【\[(]+"""), "")
            .replace(Regex("""[》】\])]+$"""), "")
            .trim()
            .ifBlank { "未知书籍" }
    }

    private fun normalizeZipPath(path: String): String {
        val parts = path.replace('\\', '/').split('/')
        val stack = mutableListOf<String>()
        for (part in parts) {
            if (part == "." || part.isEmpty()) continue
            if (part == "..") {
                if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
            } else {
                stack.add(part)
            }
        }
        return stack.joinToString("/")
    }

    /**
     * 生成优雅纯 SVG 艺术字封面
     */
    fun generateSvgCover(title: String, author: String?): String {
        val rawTitle = if (title.length > 8) title.take(7) + "…" else title
        val rawAuthor = author?.take(10) ?: "本地导入"
        val displayTitle = escapeXmlText(rawTitle)
        val displayAuthor = escapeXmlText(rawAuthor)
        val bgGradients = listOf(
            "#1e293b" to "#0f172a",
            "#1e3a8a" to "#172554",
            "#14532d" to "#052e16",
            "#701a75" to "#4a044e",
            "#7c2d12" to "#431407"
        )
        val hash = (title.hashCode().toLong() and 0xffffffffL).toInt()
        val (c1, c2) = bgGradients[Math.abs(hash) % bgGradients.size]

        return """
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420" width="300" height="420">
              <defs>
                <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style="stop-color:$c1;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:$c2;stop-opacity:1" />
                </linearGradient>
              </defs>
              <rect width="300" height="420" rx="12" fill="url(#grad)" />
              <rect x="16" y="16" width="268" height="388" rx="8" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2" />
              <g fill="#38bdf8" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="600">
                <rect x="24" y="24" width="48" height="20" rx="4" fill="rgba(56,189,248,0.15)" />
                <text x="48" y="38" text-anchor="middle">本地</text>
              </g>
              <text x="150" y="190" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif" font-size="24" font-weight="bold" text-anchor="middle">$displayTitle</text>
              <line x1="80" y1="220" x2="220" y2="220" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" />
              <text x="150" y="255" fill="rgba(255,255,255,0.7)" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif" font-size="14" text-anchor="middle">$displayAuthor</text>
            </svg>
        """.trimIndent()
    }

    private fun escapeXmlText(text: String): String {
        return text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&apos;")
    }
}
