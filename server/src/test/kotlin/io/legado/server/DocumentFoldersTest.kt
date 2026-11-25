package io.legado.server

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class DocumentFoldersTest {

    @Test
    fun `folder hierarchy CRUD, duplicate check, cycle defense and safe doc fallback on delete`() {
        val tempDir = Files.createTempDirectory("legado-doc-folders-test")
        try {
            val db = Database(tempDir.resolve("test.db").toString())
            db.initialize("admin123")

            // 1. 创建顶层文件夹与多级子文件夹
            val rootA = db.createDocFolder("历史档案", null)
            val rootB = db.createDocFolder("技术笔记", null)
            val subA1 = db.createDocFolder("1972-1978", rootA.id)
            val subA1Deep = db.createDocFolder("第五章资料", subA1.id)

            assertEquals(4, db.listDocFolders().size)

            // 同级不允许重复名称（不区分大小写）
            val duplicateThrown = runCatching { db.createDocFolder("技术笔记", null) }.exceptionOrNull()
            assertTrue(duplicateThrown is IllegalStateException)
            // 不同父目录下允许同名
            val sameNameInSub = db.createDocFolder("技术笔记", rootA.id)
            assertEquals(rootA.id, sameNameInSub.parentId)

            // 2. 重命名与移动 + 防成环检测
            val renamed = db.updateDocFolder(sameNameInSub.id, name = "专题汇总")
            assertEquals("专题汇总", renamed.name)

            val cycleSelf = runCatching { db.updateDocFolder(rootA.id, parentId = rootA.id, updateParent = true) }.exceptionOrNull()
            assertTrue(cycleSelf is IllegalArgumentException)

            val cycleChild = runCatching { db.updateDocFolder(rootA.id, parentId = subA1Deep.id, updateParent = true) }.exceptionOrNull()
            assertTrue(cycleChild is IllegalArgumentException)

            // 合法移动：把「专题汇总」移到 rootB 下
            val moved = db.updateDocFolder(renamed.id, parentId = rootB.id, updateParent = true)
            assertEquals(rootB.id, moved.parentId)

            // 3. 导入文档直落目标文件夹 + reparse 保留 docFolderId + 批量移动归属
            val mdParsed = LocalBookParser.parseMarkdown("note.md", "# 导论\n\n正文段落。".toByteArray())
            val mdItem = db.importLocalBook("docmd01", mdParsed, coverKey = null, docFolderId = subA1Deep.id)
            val mdVars = Json.parseToJsonElement(mdItem.variable!!).jsonObject
            assertEquals("md", mdVars["localFormat"]?.jsonPrimitive?.content)
            assertEquals(subA1Deep.id, mdVars["docFolderId"]?.jsonPrimitive?.content)

            // 重解析（不传 docFolderId）不应冲掉已有的 docFolderId
            db.replaceLocalBookCache("docmd01", mdParsed)
            val afterReparse = db.listBookshelf().first { it.bookUrl == mdItem.bookUrl }
            val afterReparseVars = Json.parseToJsonElement(afterReparse.variable!!).jsonObject
            assertEquals(subA1Deep.id, afterReparseVars["docFolderId"]?.jsonPrimitive?.content)

            // 导入普通 TXT 不应写入 docFolderId
            val txtParsed = LocalBookParser.parseTxt("novel.txt", "第1章 开始\n故事开始了".toByteArray())
            val txtItem = db.importLocalBook("txt01", txtParsed, coverKey = null, docFolderId = rootA.id)
            val txtVars = Json.parseToJsonElement(txtItem.variable!!).jsonObject
            assertEquals("txt", txtVars["localFormat"]?.jsonPrimitive?.content)
            assertNull(txtVars["docFolderId"])

            // 4. 删除子文件夹 subA1（其含后代 subA1Deep）-> 两级目录皆被删，文档安全迁回上级 rootA
            val deleteRes = db.deleteDocFolder(subA1.id)
            assertTrue(subA1.id in deleteRes.deletedFolderIds)
            assertTrue(subA1Deep.id in deleteRes.deletedFolderIds)
            assertEquals(1, deleteRes.movedDocs)
            assertFalse(db.listDocFolders().any { it.id == subA1.id || it.id == subA1Deep.id })

            val docAfterParentDeleted = db.listBookshelf().firstOrNull { it.bookUrl == mdItem.bookUrl }
            assertNotNull("删除文件夹绝不能删除文档本体", docAfterParentDeleted)
            val varsAfterParentDeleted = Json.parseToJsonElement(docAfterParentDeleted!!.variable!!).jsonObject
            assertEquals(rootA.id, varsAfterParentDeleted["docFolderId"]?.jsonPrimitive?.content)

            // 删除顶层文件夹 rootA -> 文档归回未归类（移除 docFolderId，仍保留 localFormat=md）
            val deleteRootRes = db.deleteDocFolder(rootA.id)
            assertEquals(1, deleteRootRes.movedDocs)
            val docAfterRootDeleted = db.listBookshelf().first { it.bookUrl == mdItem.bookUrl }
            val varsAfterRootDeleted = Json.parseToJsonElement(docAfterRootDeleted.variable!!).jsonObject
            assertEquals("md", varsAfterRootDeleted["localFormat"]?.jsonPrimitive?.content)
            assertNull(varsAfterRootDeleted["docFolderId"])

            // 5. assignDocumentsFolder 写入并再次迁出
            val assignedCount = db.assignDocumentsFolder(listOf(DocBookRef(mdItem.sourceId, mdItem.bookUrl)), rootB.id)
            assertEquals(1, assignedCount)
            val docMovedToB = db.listBookshelf().first { it.bookUrl == mdItem.bookUrl }
            assertEquals(rootB.id, Json.parseToJsonElement(docMovedToB.variable!!).jsonObject["docFolderId"]?.jsonPrimitive?.content)

            db.assignDocumentsFolder(listOf(DocBookRef(mdItem.sourceId, mdItem.bookUrl)), null)
            val docUnfiled = db.listBookshelf().first { it.bookUrl == mdItem.bookUrl }
            assertNull(Json.parseToJsonElement(docUnfiled.variable!!).jsonObject["docFolderId"])

            // 6. 文件夹子树复制（重名追加副本后缀 + 防循环复制）与文档同名副本后缀生成
            val srcParent = db.createDocFolder("归档", null)
            val srcChild = db.createDocFolder("子卷", srcParent.id)
            val (dupRoot, idMap) = db.duplicateDocFolderSubtree(srcParent.id, null)
            assertEquals("归档 - 副本", dupRoot.name)
            assertEquals(2, idMap.size)
            val dupChild = db.listDocFolders().firstOrNull { it.id == idMap[srcChild.id] }
            assertNotNull(dupChild)
            assertEquals(dupRoot.id, dupChild!!.parentId)

            val cycleCopy = runCatching { db.duplicateDocFolderSubtree(srcParent.id, srcChild.id) }.exceptionOrNull()
            assertTrue(cycleCopy is IllegalArgumentException)

            val docInFolder = db.importLocalBook(
                "docdup01",
                LocalBookParser.parseMarkdown("dup.md", "# 测试".toByteArray()),
                coverKey = null,
                docFolderId = dupRoot.id,
            )
            assertEquals("${docInFolder.name} - 副本", db.pickUniqueDocName(docInFolder.name, dupRoot.id))

            db.close()
        } finally {
            tempDir.toFile().deleteRecursively()
        }
    }
}
