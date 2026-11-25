package io.legado.server

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.cookies.*
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class LocalBookMarkdownDocxTest {

    @Test
    fun `markdown parses frontmatter headings and ignores hash inside code fences`() {
        val md = """
            ---
            title: "技术笔记指南"
            author: '张三'
            description: "用于验证 Markdown 解析的说明。"
            ---

            这是一段导语。

            # 第一章 起步

            这里有一段**加粗**和*斜体*，还有代码：

            ```bash
            # 这是注释，绝对不能被当作章节标题
            echo "hello"
            ```

            # 第二章 表格与列表

            - 项目一
            - 项目二

            | 列A | 列B |
            | --- | --- |
            | 值1 | 值2 |
        """.trimIndent()

        val parsed = LocalBookParser.parseMarkdown("原始文件名.md", md.toByteArray(Charsets.UTF_8))
        assertEquals("md", parsed.localFormat)
        assertEquals("技术笔记指南", parsed.title)
        assertEquals("张三", parsed.author)
        assertEquals("用于验证 Markdown 解析的说明。", parsed.intro)
        assertEquals(3, parsed.chapters.size)
        assertEquals("前言", parsed.chapters[0].title)
        assertEquals("第一章 起步", parsed.chapters[1].title)
        assertEquals("第二章 表格与列表", parsed.chapters[2].title)

        assertTrue(parsed.chapters[1].content.startsWith(LocalBookParser.MARKDOWN_CONTENT_MARKER))
        assertTrue(parsed.chapters[1].content.contains("# 这是注释，绝对不能被当作章节标题"))
        assertFalse("分章标题不应重复留在章内首行", parsed.chapters[1].content.contains("# 第一章 起步"))
        assertTrue(parsed.chapters[2].content.contains("| 列A | 列B |"))
    }

    @Test
    fun `markdown uses single h1 as book title and splits by h2`() {
        val md = """
            # 我的架构手册

            ## 1. 背景

            背景内容。

            ## 2. 方案

            方案细节。
        """.trimIndent()

        val parsed = LocalBookParser.parseMarkdown("fallback.markdown", md.toByteArray(Charsets.UTF_8))
        assertEquals("我的架构手册", parsed.title)
        assertEquals(2, parsed.chapters.size)
        assertEquals("1. 背景", parsed.chapters[0].title)
        assertEquals("2. 方案", parsed.chapters[1].title)
        assertFalse(parsed.chapters[0].content.contains("# 我的架构手册"))
    }

    @Test
    fun `docx converts styles inline formatting lists tables and embedded images to markdown`() {
        val pngBytes = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        val docxBytes = buildTestDocx(pngBytes)
        val parsed = LocalBookParser.parseDocx("测试文档.docx", docxBytes, bookId = "0123456789abcdef0123456789abcdef")

        assertEquals("docx", parsed.localFormat)
        assertEquals("Word 规范文档", parsed.title)
        assertEquals("李四", parsed.author)
        assertEquals("DOCX 核心摘要", parsed.intro)
        assertEquals(2, parsed.chapters.size)
        assertEquals("第一章 概览", parsed.chapters[0].title)
        assertEquals("第二章 数据表", parsed.chapters[1].title)

        val ch1 = parsed.chapters[0].content
        assertTrue(ch1.startsWith(LocalBookParser.MARKDOWN_CONTENT_MARKER))
        assertTrue("相邻粗体 run 应合并", ch1.contains("**加粗词语**"))
        assertFalse("不应拆成碎片粗体", ch1.contains("**加粗****词语**"))
        assertTrue(ch1.contains("*斜体*"))
        assertTrue(ch1.contains("~~删除~~"))
        assertTrue(ch1.contains("[官网](https://example.com)"))
        assertTrue(ch1.contains("- 无序条目A"))
        assertTrue(ch1.contains("1. 有序条目一"))
        assertTrue(ch1.contains("![示例图](/api/local-books/0123456789abcdef0123456789abcdef/media/img_1.png)"))

        assertEquals(1, parsed.mediaFiles.size)
        assertArrayEquals(pngBytes, parsed.mediaFiles["img_1.png"])

        val ch2 = parsed.chapters[1].content
        assertTrue(ch2.contains("| 名称 | 说明 |"))
        assertTrue(ch2.contains("| 模块A | 含\\|竖线 |"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `docx rejects non-zip invalid bytes cleanly`() {
        LocalBookParser.parseDocx("broken.docx", "not a zip file".toByteArray(Charsets.UTF_8))
    }

    @Test
    fun `import endpoint handles md and docx and serves authenticated docx media`() = testApplication {
        val dataDir = Files.createTempDirectory("local-md-docx-e2e")
        val config = ServerConfig(
            host = "0.0.0.0",
            port = 8080,
            databasePath = dataDir.resolve("legado.sqlite").toString(),
            coverCacheDirectory = dataDir.resolve("covers"),
            webDavDirectory = dataDir.resolve("webdav"),
            localBooksDirectory = dataDir.resolve("local_books"),
            initialAdminPassword = PASSWORD,
            secureCookies = false,
        )
        try {
            application { legadoApplication(config) }
            val client = createClient {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true; encodeDefaults = true }) }
                install(HttpCookies)
            }
            val loginResp = client.post("/api/auth/login") {
                contentType(ContentType.Application.Json)
                setBody(LoginRequest(PASSWORD))
            }
            assertEquals(HttpStatusCode.OK, loginResp.status)
            val csrf = loginResp.body<LoginResponse>().csrfToken

            val pngBytes = Base64.getDecoder().decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            )
            val mdBytes = "# 章节一\n\n这是 **Markdown** 内容。\n\n# 章节二\n\n第二章。\n".toByteArray(Charsets.UTF_8)
            val docxBytes = buildTestDocx(pngBytes)

            val importResp = client.submitFormWithBinaryData(
                url = "/api/bookshelf/import-local",
                formData = formData {
                    append("file", mdBytes, Headers.build {
                        append(HttpHeaders.ContentType, "text/markdown")
                        append(HttpHeaders.ContentDisposition, "filename=\"笔记.md\"")
                    })
                    append("file", docxBytes, Headers.build {
                        append(HttpHeaders.ContentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                        append(HttpHeaders.ContentDisposition, "filename=\"报告.docx\"")
                    })
                },
            ) {
                header("X-CSRF-Token", csrf)
            }
            assertEquals(HttpStatusCode.OK, importResp.status)
            val imported = importResp.body<LocalBookImportResponse>()
            assertEquals(2, imported.imported)
            assertEquals(0, imported.failed)

            val mdItem = imported.results.first { it.filename == "笔记.md" }
            val docxItem = imported.results.first { it.filename == "报告.docx" }
            val docxBookId = docxItem.bookUrl!!.removePrefix("local://")

            // 验证 GET /api/bookshelf 已在 variable 中落库 localFormat 分类标记
            val shelfResp = client.get("/api/bookshelf")
            assertEquals(HttpStatusCode.OK, shelfResp.status)
            val shelfItems = shelfResp.body<List<BookshelfItem>>()
            val mdShelf = shelfItems.first { it.bookUrl == mdItem.bookUrl }
            val docxShelf = shelfItems.first { it.bookUrl == docxItem.bookUrl }
            assertTrue("MD 文档应在 variable 记录 localFormat=md，实际：${mdShelf.variable}", mdShelf.variable?.contains("\"localFormat\":\"md\"") == true)
            assertTrue("DOCX 文档应在 variable 记录 localFormat=docx，实际：${docxShelf.variable}", docxShelf.variable?.contains("\"localFormat\":\"docx\"") == true)

            // 拉取 DOCX 第一章正文并校验图片路径可鉴权读取
            val contentResp = client.post("/api/books/content") {
                contentType(ContentType.Application.Json)
                header("X-CSRF-Token", csrf)
                setBody(ContentRequest(sourceId = LocalBookParser.LOC_BOOK_SOURCE_ID, bookUrl = docxItem.bookUrl, chapterUrl = "${docxItem.bookUrl}/chapter_1"))
            }
            assertEquals(HttpStatusCode.OK, contentResp.status)
            val chContent = contentResp.body<ChapterContent>()
            assertTrue(chContent.content.contains(LocalBookParser.MARKDOWN_CONTENT_MARKER))
            assertTrue(chContent.content.contains("/api/local-books/$docxBookId/media/img_1.png"))

            val mediaResp = client.get("/api/local-books/$docxBookId/media/img_1.png")
            assertEquals(HttpStatusCode.OK, mediaResp.status)
            assertArrayEquals(pngBytes, mediaResp.readRawBytes())

            // 删除书籍后确认图片目录被清理
            val delResp = client.delete("/api/bookshelf") {
                parameter("sourceId", LocalBookParser.LOC_BOOK_SOURCE_ID)
                parameter("bookUrl", docxItem.bookUrl)
                header("X-CSRF-Token", csrf)
            }
            assertEquals(HttpStatusCode.NoContent, delResp.status)
            assertFalse(Files.exists(dataDir.resolve("local_books/${docxBookId}_media")))

            // 顺手清理 md 测试书
            client.delete("/api/bookshelf") {
                parameter("sourceId", LocalBookParser.LOC_BOOK_SOURCE_ID)
                parameter("bookUrl", mdItem.bookUrl)
                header("X-CSRF-Token", csrf)
            }
        } finally {
            runCatching {
                Files.walk(dataDir).sorted(java.util.Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            }
        }
    }

    private fun buildTestDocx(pngBytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            fun putText(name: String, text: String) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(text.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }

            putText(
                "[Content_Types].xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                     <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                     <Default Extension="xml" ContentType="application/xml"/>
                     <Default Extension="png" ContentType="image/png"/>
                     <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
                   </Types>""".trimIndent(),
            )
            putText(
                "docProps/core.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
                     <dc:title>Word 规范文档</dc:title>
                     <dc:creator>李四</dc:creator>
                     <dc:description>DOCX 核心摘要</dc:description>
                   </cp:coreProperties>""".trimIndent(),
            )
            putText(
                "word/styles.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                     <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
                   </w:styles>""".trimIndent(),
            )
            putText(
                "word/numbering.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                     <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
                     <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
                     <w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num>
                     <w:num w:numId="20"><w:abstractNumId w:val="2"/></w:num>
                   </w:numbering>""".trimIndent(),
            )
            putText(
                "word/_rels/document.xml.rels",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                     <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
                     <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
                   </Relationships>""".trimIndent(),
            )
            putText(
                "word/document.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
                   <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                               xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                               xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                     <w:body>
                       <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 概览</w:t></w:r></w:p>
                       <w:p>
                         <w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r>
                         <w:r><w:rPr><w:b/></w:rPr><w:t>词语</w:t></w:r>
                         <w:r><w:t xml:space="preserve"> 与 </w:t></w:r>
                         <w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r>
                         <w:r><w:t xml:space="preserve"> </w:t></w:r>
                         <w:r><w:rPr><w:strike/></w:rPr><w:t>删除</w:t></w:r>
                         <w:r><w:t xml:space="preserve"> 访问 </w:t></w:r>
                         <w:hyperlink r:id="rIdLink"><w:r><w:t>官网</w:t></w:r></w:hyperlink>
                       </w:p>
                       <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr></w:pPr><w:r><w:t>无序条目A</w:t></w:r></w:p>
                       <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="20"/></w:numPr></w:pPr><w:r><w:t>有序条目一</w:t></w:r></w:p>
                       <w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="示例图"/><a:graphic><a:graphicData><a:pic><a:blipFill><a:blip r:embed="rIdImg1"/></a:blipFill></a:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
                       <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二章 数据表</w:t></w:r></w:p>
                       <w:tbl>
                         <w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr>
                         <w:tr><w:tc><w:p><w:r><w:t>模块A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含|竖线</w:t></w:r></w:p></w:tc></w:tr>
                       </w:tbl>
                     </w:body>
                   </w:document>""".trimIndent(),
            )
            zip.putNextEntry(ZipEntry("word/media/image1.png"))
            zip.write(pngBytes)
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    @Test
    fun `markdown and docx extract level 2 and level 3 subheadings cleanly`() {
        val md = """
            # 第一章 总纲

            导语内容。

            ## 1.1 **背景介绍**

            一段背景正文。

            ```bash
            ### 代码块中的伪标题绝对不能被提取
            ```

            ### 1.1.1 关键细节与 `内联代码`

            细节说明。

            #### 四级标题示例

            # 第二章 执行路径

            ## 2.1 [方案对比](https://example.com)

            表格或列表。
        """.trimIndent()

        val parsed = LocalBookParser.parseMarkdown("outline-test.md", md.toByteArray(Charsets.UTF_8))
        assertEquals(2, parsed.chapters.size)
        assertEquals(1, parsed.chapters[0].level)
        val firstHeadings = parsed.chapters[0].headings ?: emptyList()
        assertEquals(3, firstHeadings.size)
        assertEquals(2, firstHeadings[0].level)
        assertEquals("1.1 背景介绍", firstHeadings[0].title)
        assertEquals(0, firstHeadings[0].ordinal)
        assertEquals(3, firstHeadings[1].level)
        assertEquals("1.1.1 关键细节与 内联代码", firstHeadings[1].title)
        assertEquals(1, firstHeadings[1].ordinal)
        assertEquals(4, firstHeadings[2].level)
        assertEquals("四级标题示例", firstHeadings[2].title)
        assertEquals(2, firstHeadings[2].ordinal)

        val secondHeadings = parsed.chapters[1].headings ?: emptyList()
        assertEquals(1, secondHeadings.size)
        assertEquals(2, secondHeadings[0].level)
        assertEquals("2.1 方案对比", secondHeadings[0].title)
        assertEquals(0, secondHeadings[0].ordinal)
    }

    private companion object {
        const val PASSWORD = "md-docx-test-password"
    }
}
