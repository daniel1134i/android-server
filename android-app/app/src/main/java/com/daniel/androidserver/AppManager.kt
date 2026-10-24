package com.daniel.androidserver

import android.content.Context
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipInputStream

object AppManager {

    var appsDir: File = File(Environment.getExternalStorageDirectory(), "ServerApps")
        private set

    private data class RunningApp(
        val name: String,
        val process: Process,
        val pid: Long,
        val command: String,
        val startTime: Long
    )

    private val activeApps = ConcurrentHashMap<String, RunningApp>()

    fun init(context: Context? = null) {
        try {
            // Внутренний каталог приложения (гарантированно доступен для чтения/записи и PRoot на Android 11-15)
            val base = context?.filesDir ?: File(Environment.getExternalStorageDirectory(), "ServerApps")
            appsDir = File(base, "ServerApps")
            if (!appsDir.exists()) appsDir.mkdirs()
            createSampleAppIfEmpty(context)
        } catch (_: Exception) {}
    }

    private fun createSampleAppIfEmpty(context: Context? = null) {
        try {
            // Распаковываем предустановленные проекты из assets/apps если их еще нет
            if (context != null) {
                try {
                    val assetApps = context.assets.list("apps") ?: emptyArray()
                    for (appZip in assetApps) {
                        if (appZip.endsWith(".zip")) {
                            val appName = appZip.removeSuffix(".zip")
                            val target = File(appsDir, appName)
                            if (!target.exists()) {
                                context.assets.open("apps/$appZip").use { stream ->
                                    val bytes = stream.readBytes()
                                    deployZip(appName, bytes)
                                }
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            val existing = appsDir.listFiles()?.filter { it.isDirectory }
            if (existing.isNullOrEmpty()) {
                val sampleDir = File(appsDir, "demo-service")
                sampleDir.mkdirs()
                val script = File(sampleDir, "start.sh")
                script.writeText(
                    """
                    #!/system/bin/sh
                    echo "[ДЕМО-СЕРВИС] Автономный процесс запущен: $(date)"
                    while true; do
                      echo "[ДЕМО-СЕРВИС] Сервер работает в фоне: $(date)"
                      sleep 20
                    done
                    """.trimIndent()
                )
                try { Runtime.getRuntime().exec("chmod 755 ${script.absolutePath}") } catch (_: Exception) {}
                startApp("demo-service")
            }
        } catch (_: Exception) {}
    }

    fun listApps(): JSONArray {
        val arr = JSONArray()
        val dirs = appsDir.listFiles()?.filter { it.isDirectory } ?: emptyList()

        for (dir in dirs) {
            val name = dir.name
            val running = activeApps[name]
            val isAlive = running?.process?.isAlive == true

            if (!isAlive && running != null) {
                activeApps.remove(name)
            }

            val cmd = getStartCommand(dir)
            val logFile = File(dir, "app.log")
            val logPreview = if (logFile.exists()) {
                try {
                    logFile.readLines().takeLast(20).joinToString("\n")
                } catch (_: Exception) { "" }
            } else ""

            val item = JSONObject().apply {
                put("name", name)
                put("path", dir.absolutePath)
                put("running", isAlive)
                put("pid", if (isAlive) running?.pid else -1)
                put("command", cmd)
                put("uptime_s", if (isAlive && running != null) (System.currentTimeMillis() - running.startTime) / 1000 else 0)
                put("last_log", logPreview)
            }
            arr.put(item)
        }
        return arr
    }

    fun startApp(name: String, customCmd: String? = null): JSONObject {
        val clean = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val dir = File(appsDir, clean)
        if (!dir.exists() || !dir.isDirectory) {
            return JSONObject().put("error", "Приложение не найдено: $clean")
        }

        stopApp(clean)

        if (!customCmd.isNullOrBlank()) {
            File(dir, ".start_cmd").writeText(customCmd.trim())
        }

        val cmd = getStartCommand(dir)
        val logFile = File(dir, "app.log")

        return try {
            val useDebian = DebianManager.isInstalled()
            val pb = if (useDebian) {
                val prootArgs = DebianManager.buildProotCommand(cmd, workDir = "/apps/$clean")
                ProcessBuilder(prootArgs).apply {
                    DebianManager.applyEnvironment(environment())
                }
            } else {
                ProcessBuilder("sh", "-c", cmd).apply {
                    val env = environment()
                    env["HOME"] = dir.absolutePath
                    env["TMPDIR"] = dir.absolutePath
                    env["USER"] = "android"
                    env["PATH"] = "${dir.absolutePath}:/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin:" + (env["PATH"] ?: "")
                }
            }
            pb.directory(dir.apply { if (!exists()) mkdirs() }).redirectErrorStream(true)

            // Запись вывода в файл лога с ротацией при превышении 3 МБ
            val process = pb.start()
            val pid = extractPid(process)

            Thread {
                try {
                    if (logFile.exists() && logFile.length() > 3 * 1024 * 1024) {
                        val tail = logFile.readLines().takeLast(500).joinToString("\n")
                        logFile.writeText("[РОТАЦИЯ ЛОГОВ - ПРЕВЫШЕН ЛИМИТ 3МБ]\n$tail\n")
                    }
                    val writer = FileWriter(logFile, true)
                    process.inputStream.bufferedReader().use { reader ->
                        var line: String?
                        while (reader.readLine().also { line = it } != null) {
                            writer.write("[${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}] $line\n")
                            writer.flush()
                        }
                    }
                    writer.close()
                } catch (_: Exception) {}
            }.start()

            activeApps[clean] = RunningApp(clean, process, pid, cmd, System.currentTimeMillis())
            val envLabel = if (useDebian) "Debian 12 PRoot" else "Android Shell"
            ServerService.addLog("Приложение '$clean' успешно запущено [$envLabel] (PID: $pid, Команда: $cmd)", "ПРИЛОЖЕНИЯ")

            JSONObject().apply {
                put("status", "ok")
                put("name", clean)
                put("pid", pid)
                put("command", cmd)
                put("environment", envLabel)
            }
        } catch (e: Exception) {
            ServerService.addLog("Ошибка запуска '$clean': ${e.message}", "ОШИБКА")
            JSONObject().put("error", "Не удалось запустить: ${e.message}")
        }
    }

    fun stopApp(name: String): Boolean {
        val clean = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val running = activeApps.remove(clean) ?: return false
        return try {
            running.process.destroyForcibly()
            if (running.pid > 0) {
                try {
                    Runtime.getRuntime().exec("kill -9 ${running.pid}")
                } catch (_: Exception) {}
            }
            ServerService.addLog("Приложение '$clean' остановлено", "ПРИЛОЖЕНИЯ")
            true
        } catch (_: Exception) {
            false
        }
    }

    fun deleteApp(name: String): Boolean {
        val clean = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        stopApp(clean)
        val dir = File(appsDir, clean)
        if (!dir.exists()) return true

        try { Thread.sleep(100) } catch (_: Exception) {}

        var ok = dir.deleteRecursively()
        if (!ok || dir.exists()) {
            try {
                val proc = Runtime.getRuntime().exec(arrayOf("rm", "-rf", dir.absolutePath))
                proc.waitFor()
                ok = !dir.exists()
            } catch (_: Exception) {}
        }

        if (ok) {
            ServerService.addLog("Приложение '$clean' удалено из /sdcard/ServerApps", "ПРИЛОЖЕНИЯ")
        } else {
            ServerService.addLog("Ошибка при удалении приложения '$clean'", "ОШИБКА")
        }
        return ok
    }

    fun getAppLogs(name: String): String {
        val clean = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val logFile = File(appsDir, "$clean/app.log")
        if (!logFile.exists()) return "Логи отсутствуют"
        return try {
            logFile.readLines().takeLast(200).joinToString("\n")
        } catch (e: Exception) {
            "Ошибка чтения логов: ${e.message}"
        }
    }

    fun deployZip(appName: String, zipData: ByteArray, customCmd: String? = null): JSONObject {
        val cleanName = appName.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifEmpty { "app_" + System.currentTimeMillis() }
        val targetDir = File(appsDir, cleanName)
        if (targetDir.exists()) stopApp(cleanName)
        targetDir.mkdirs()

        try {
            unzip(ByteArrayInputStream(zipData), targetDir)
            if (!customCmd.isNullOrBlank()) {
                File(targetDir, ".start_cmd").writeText(customCmd.trim())
            }
            ensureExecutablePermissions(targetDir)
            ServerService.addLog("ZIP архив развернут в: ${targetDir.absolutePath}", "ДЕПЛОЙ")
            return startApp(cleanName, customCmd)
        } catch (e: Exception) {
            ServerService.addLog("Ошибка распаковки ZIP '$cleanName': ${e.message}", "ОШИБКА")
            return JSONObject().put("error", "Ошибка распаковки архива: ${e.message}")
        }
    }

    fun deployGit(gitUrl: String, customName: String? = null, customCmd: String? = null, token: String? = null): JSONObject {
        val cleanUrl = gitUrl.trim()

        // Извлечение токена из URL (например, https://TOKEN@github.com/... или https://user:TOKEN@github.com/...)
        var extractedToken: String? = token?.trim()?.ifBlank { null }
        var normalizedUrl = cleanUrl

        try {
            val uri = java.net.URI(cleanUrl)
            val userInfo = uri.userInfo
            if (!userInfo.isNullOrBlank()) {
                if (extractedToken == null) {
                    extractedToken = if (userInfo.contains(":")) userInfo.substringAfter(":") else userInfo
                }
                normalizedUrl = "${uri.scheme}://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}${uri.path}"
            }
        } catch (_: Exception) {}

        val pathParts = normalizedUrl.removeSuffix("/").removeSuffix(".git").split("/")
        val repoSlug = pathParts.lastOrNull()?.ifBlank { null } ?: "git_app"
        val derivedName = customName?.ifBlank { null } ?: repoSlug
        val cleanName = derivedName.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifEmpty { "git_app" }

        return try {
            val zipBytes: ByteArray
            if (normalizedUrl.contains("github.com") && !extractedToken.isNullOrBlank()) {
                // Для закрытых репозиториев GitHub используем API /repos/{owner}/{repo}/zipball с Bearer-токеном
                val owner = pathParts.getOrNull(pathParts.size - 2) ?: ""
                val repo = pathParts.lastOrNull() ?: ""
                val apiUrl = "https://api.github.com/repos/$owner/$repo/zipball"
                ServerService.addLog("Загрузка закрытого GitHub репозитория $owner/$repo через API с токеном", "ДЕПЛОЙ")

                val conn = (URL(apiUrl).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 20000
                    readTimeout = 40000
                    setRequestProperty("Authorization", "Bearer $extractedToken")
                    setRequestProperty("Accept", "application/vnd.github+json")
                    setRequestProperty("User-Agent", "AndroidServerNode/1.0")
                }

                val code = conn.responseCode
                if (code == 301 || code == 302 || code == 307 || code == 308) {
                    val location = conn.getHeaderField("Location") ?: throw IOException("Отсутствует заголовок Location для редиректа")
                    val redirectConn = (URL(location).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 25000
                        readTimeout = 60000
                        setRequestProperty("User-Agent", "AndroidServerNode/1.0")
                    }
                    if (redirectConn.responseCode !in 200..299) {
                        throw IOException("Ошибка скачивания архива по редиректу: HTTP ${redirectConn.responseCode}")
                    }
                    zipBytes = redirectConn.inputStream.use { it.readBytes() }
                } else if (code in 200..299) {
                    zipBytes = conn.inputStream.use { it.readBytes() }
                } else if (code == 401 || code == 404 || code == 403) {
                    return JSONObject().put(
                        "error",
                        "Доступ запрещен (HTTP $code). Проверьте токен доступа (Personal Access Token) или права на репозиторий $owner/$repo"
                    )
                } else {
                    return JSONObject().put("error", "GitHub API вернул HTTP $code для $apiUrl")
                }
            } else {
                // Публичный репозиторий или прямая ссылка на архив
                val downloadUrl = resolveArchiveUrl(normalizedUrl)
                ServerService.addLog("Загрузка архива репозитория: $downloadUrl", "ДЕПЛОЙ")

                var conn = (URL(downloadUrl).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = true
                    connectTimeout = 20000
                    readTimeout = 40000
                    setRequestProperty("User-Agent", "AndroidServerNode/1.0")
                    if (!extractedToken.isNullOrBlank()) {
                        setRequestProperty("PRIVATE-TOKEN", extractedToken) // Для GitLab
                    }
                }

                var responseCode = conn.responseCode

                // Пробуем ветку master, если main вернул 404
                if (responseCode == 404 && downloadUrl.contains("/refs/heads/main.zip")) {
                    val fallbackUrl = downloadUrl.replace("/refs/heads/main.zip", "/refs/heads/master.zip")
                    conn = (URL(fallbackUrl).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = true
                        connectTimeout = 20000
                        readTimeout = 40000
                        setRequestProperty("User-Agent", "AndroidServerNode/1.0")
                    }
                    responseCode = conn.responseCode
                }

                if (responseCode == 301 || responseCode == 302 || responseCode == 307 || responseCode == 308) {
                    val location = conn.getHeaderField("Location")
                    conn = (URL(location).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 20000
                        readTimeout = 40000
                        setRequestProperty("User-Agent", "AndroidServerNode/1.0")
                    }
                    responseCode = conn.responseCode
                }

                if (responseCode !in 200..299) {
                    val hint = if (responseCode == 404 || responseCode == 401 || responseCode == 403) {
                        " (Возможно, репозиторий закрытый: укажите Personal Access Token или загрузите ZIP-архив)"
                    } else ""
                    return JSONObject().put("error", "Ошибка HTTP $responseCode при скачивании репозитория$hint")
                }

                zipBytes = conn.inputStream.use { it.readBytes() }
            }

            deployZip(cleanName, zipBytes, customCmd)
        } catch (e: Exception) {
            ServerService.addLog("Ошибка деплоя Git '$cleanUrl': ${e.message}", "ОШИБКА")
            JSONObject().put("error", "Не удалось скачать репозиторий: ${e.message}")
        }
    }

    private fun resolveArchiveUrl(gitUrl: String): String {
        var base = gitUrl.removeSuffix(".git").removeSuffix("/")
        if (base.contains("github.com")) {
            return "$base/archive/refs/heads/main.zip"
        }
        if (base.contains("gitlab.com")) {
            val repoName = base.substringAfterLast("/")
            return "$base/-/archive/main/$repoName-main.zip"
        }
        return base
    }

    private fun getStartCommand(dir: File): String {
        val cmdFile = File(dir, ".start_cmd")
        if (cmdFile.exists()) {
            val c = cmdFile.readText().trim()
            if (c.isNotEmpty()) return c
        }

        // Автоопределение файла точки входа
        return when {
            File(dir, "start.sh").exists() -> "sh start.sh"
            File(dir, "run.sh").exists() -> "sh run.sh"
            File(dir, "main.sh").exists() -> "sh main.sh"
            File(dir, "main.py").exists() -> "python3 main.py"
            File(dir, "app.py").exists() -> "python3 app.py"
            File(dir, "server.js").exists() -> "node server.js"
            File(dir, "index.js").exists() -> "node index.js"
            File(dir, "package.json").exists() -> "npm start"
            else -> {
                // Создать start.sh по умолчанию
                val s = File(dir, "start.sh")
                s.writeText("#!/system/bin/sh\necho 'Сервис ${dir.name} запущен'\nwhile true; do sleep 30; done\n")
                try { Runtime.getRuntime().exec("chmod 755 ${s.absolutePath}") } catch (_: Exception) {}
                "sh start.sh"
            }
        }
    }

    private fun ensureExecutablePermissions(dir: File) {
        dir.walkTopDown().forEach { f ->
            if (f.extension in listOf("sh", "py", "js")) {
                try { Runtime.getRuntime().exec("chmod 755 ${f.absolutePath}") } catch (_: Exception) {}
            }
        }
    }

    private fun unzip(input: InputStream, targetDir: File) {
        ZipInputStream(input).use { zis ->
            var entry = zis.nextEntry
            var stripRootPrefix: String? = null

            // Проверка, есть ли в архиве единственная корневая папка (типично для GitHub архивов)
            while (entry != null) {
                val name = entry.name
                if (stripRootPrefix == null && name.contains("/") && !name.startsWith("/")) {
                    val firstSlash = name.indexOf('/')
                    val possibleRoot = name.substring(0, firstSlash + 1)
                    if (entry.isDirectory && name == possibleRoot) {
                        stripRootPrefix = possibleRoot
                    }
                }

                val cleanName = if (stripRootPrefix != null && name.startsWith(stripRootPrefix)) {
                    name.substring(stripRootPrefix.length)
                } else name

                if (cleanName.isNotEmpty()) {
                    val outFile = File(targetDir, cleanName)
                    val canonicalDest = targetDir.canonicalPath
                    val canonicalOut = outFile.canonicalPath
                    if (!canonicalOut.startsWith(canonicalDest + File.separator) && canonicalOut != canonicalDest) {
                        throw SecurityException("Обнаружена попытка Zip Slip выхода за пределы каталога: $name")
                    }
                    if (entry.isDirectory) {
                        outFile.mkdirs()
                    } else {
                        outFile.parentFile?.mkdirs()
                        FileOutputStream(outFile).use { fos -> zis.copyTo(fos) }
                    }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    fun resetAllApps() {
        for ((name, _) in activeApps) {
            try { stopApp(name) } catch (_: Exception) {}
        }
        activeApps.clear()
        try {
            appsDir.deleteRecursively()
            appsDir.mkdirs()
            createSampleAppIfEmpty()
        } catch (_: Exception) {}
    }

    private fun extractPid(process: Process): Long {
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            field.getLong(process)
        } catch (_: Exception) {
            -1L
        }
    }
}
