package com.daniel.androidserver

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class HttpServer(
    private val context: Context,
    private val port: Int = 8080,
    private val batteryMonitor: BatteryMonitor,
    private val logCallback: (String) -> Unit
) {
    private var serverSocket: ServerSocket? = null
    private val isRunning = AtomicBoolean(false)
    private val threadPool = Executors.newFixedThreadPool(4)
    private var startTime = System.currentTimeMillis()

    fun start() {
        if (isRunning.get()) return
        isRunning.set(true)

        Thread {
            try {
                serverSocket = ServerSocket(port, 50, InetAddress.getByName("0.0.0.0"))
                logCallback("HTTP server running on 0.0.0.0:$port")
                while (isRunning.get()) {
                    try {
                        val client = serverSocket?.accept() ?: break
                        threadPool.execute { handleClient(client) }
                    } catch (e: Exception) {
                        if (isRunning.get()) {
                            logCallback("Accept error: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                logCallback("Server listen error: ${e.message}")
            }
        }.start()
    }

    fun stop() {
        isRunning.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {}
        threadPool.shutdownNow()
        logCallback("HTTP server stopped")
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 10000
            val input = BufferedReader(InputStreamReader(socket.getInputStream()))
            val output = BufferedOutputStream(socket.getOutputStream())

            val reqLine = input.readLine() ?: return
            val parts = reqLine.split(" ")
            if (parts.size < 2) return

            val method = parts[0].uppercase()
            val fullPath = parts[1]

            val headers = mutableMapOf<String, String>()
            var line: String?
            while (input.readLine().also { line = it } != null) {
                if (line.isNullOrEmpty()) break
                val colon = line!!.indexOf(':')
                if (colon > 0) {
                    headers[line!!.substring(0, colon).trim().lowercase()] = line!!.substring(colon + 1).trim()
                }
            }

            // Handle OPTIONS for CORS preflight
            if (method == "OPTIONS") {
                sendResponse(output, 204, "No Content", "application/json", ByteArray(0))
                return
            }

            // Read body for POST
            val bodyBuilder = StringBuilder()
            if (method == "POST") {
                val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                if (contentLength in 1..52428800) {
                    val buf = CharArray(8192)
                    var remaining = contentLength
                    while (remaining > 0) {
                        val toRead = minOf(remaining, buf.size)
                        val n = input.read(buf, 0, toRead)
                        if (n == -1) break
                        bodyBuilder.append(buf, 0, n)
                        remaining -= n
                    }
                }
            }

            val uriPath = if (fullPath.contains('?')) fullPath.substring(0, fullPath.indexOf('?')) else fullPath
            val queryParams = parseQueryParams(fullPath)

            // Фильтруем технический шум фонового поллинга (телеметрия, логи, список приложений, статика)
            val isRoutinePolling = uriPath == "/api/status" ||
                                  uriPath == "/api/debian/status" ||
                                  uriPath == "/api/logs" ||
                                  uriPath == "/api/apps" ||
                                  uriPath == "/api/ping" ||
                                  uriPath == "/favicon.ico" ||
                                  uriPath.endsWith(".css") ||
                                  uriPath.endsWith(".js") ||
                                  uriPath.endsWith(".html")

            if (!isRoutinePolling) {
                logCallback("$method $uriPath")
            }

            when {
                uriPath == "/api/ping" -> {
                    val resp = JSONObject().apply {
                        put("status", "ok")
                        put("timestamp", System.currentTimeMillis())
                        put("uptime_s", (System.currentTimeMillis() - startTime) / 1000)
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/status" -> {
                    val resp = SystemStats.getFullStatus(context, port)
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/pair" && (method == "GET" || method == "POST") -> {
                    if (!isLocalOrPrivateIp(socket.inetAddress)) {
                        sendJsonResponse(output, 403, JSONObject().put("error", "Сопряжение разрешено только в локальной сети Wi-Fi или по USB"))
                        return
                    }

                    val nodeId = ServerService.cloudRelay?.nodeId ?: ""
                    val secretKey = ServerService.cloudRelay?.secretKey ?: ""
                    val relayUrl = ServerService.cloudRelay?.relayUrl ?: ""
                    val wifiIp = SystemStats.getIpAddress() ?: "127.0.0.1"

                    ServerService.addLog("[СОПРЯЖЕНИЕ] Нода успешно связана с Mac контроллером")

                    val resp = JSONObject().apply {
                        put("status", "paired")
                        put("node_id", nodeId)
                        put("secret_key", secretKey)
                        put("relay_url", relayUrl)
                        put("relay_connected", ServerService.cloudRelay?.isConnected == true)
                        put("wifi_ip", wifiIp)
                        put("port", port)
                        put("device", JSONObject().apply {
                            put("model", Build.MODEL)
                            put("manufacturer", Build.MANUFACTURER)
                            put("android_version", Build.VERSION.RELEASE)
                            put("sdk_int", Build.VERSION.SDK_INT)
                        })
                        put("paired_at", System.currentTimeMillis())
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/reset" && (method == "POST" || method == "GET") -> {
                    if (!isLocalOrPrivateIp(socket.inetAddress)) {
                        sendJsonResponse(output, 403, JSONObject().put("error", "Сброс разрешен только из локальной сети или по USB"))
                        return
                    }

                    AppManager.resetAllApps()
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.clear()
                    }
                    startTime = System.currentTimeMillis()
                    SystemStats.serverStartTime = System.currentTimeMillis()
                    val newCreds = ServerService.cloudRelay?.resetCredentials()
                    ServerService.notifyFactoryReset(context)
                    ServerService.addLog("[ЗАВОДСКОЙ СБРОС] Нода сброшена к заводским настройкам: приложения остановлены, буфер логов очищен", "SYSTEM")

                    val resp = JSONObject().apply {
                        put("status", "reset_ok")
                        put("node_id", newCreds?.first ?: "")
                        put("secret_key", newCreds?.second ?: "")
                        put("message", "Хост-нода сброшена к заводским настройкам")
                        put("timestamp", System.currentTimeMillis())
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/cloud/config" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val newUrl = reqJson.optString("relay_url", "").trim()
                    if (newUrl.isNotEmpty()) {
                        ServerService.cloudRelay?.updateRelayUrl(newUrl)
                    }
                    val resp = JSONObject().apply {
                        put("status", "ok")
                        put("node_id", ServerService.cloudRelay?.nodeId ?: "")
                        put("secret_key", ServerService.cloudRelay?.secretKey ?: "")
                        put("relay_url", ServerService.cloudRelay?.relayUrl ?: "")
                        put("connected", ServerService.cloudRelay?.isConnected == true)
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/logs" -> {
                    val arr = JSONArray()
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.forEach { arr.put(it) }
                    }
                    val resp = JSONObject().apply {
                        put("status", "ok")
                        put("count", arr.length())
                        put("logs", arr)
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/logs/clear" -> {
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.clear()
                    }
                    ServerService.addLog("Logs cleared by user", "SYSTEM")
                    sendJsonResponse(output, 200, JSONObject().put("status", "ok"))
                }

                uriPath == "/api/memory/details" -> {
                    val details = SystemStats.getDetailedMemoryBreakdown(context)
                    sendJsonResponse(output, 200, details)
                }

                uriPath == "/api/apps" -> {
                    val resp = JSONObject().apply {
                        put("status", "ok")
                        put("apps", AppManager.listApps())
                        put("dir", AppManager.appsDir.absolutePath)
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/apps/deploy-git" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val url = reqJson.optString("url", "").trim()
                    val name = reqJson.optString("name", "").trim()
                    val cmd = reqJson.optString("command", "").trim()
                    val token = reqJson.optString("token", "").trim()
                    if (url.isEmpty()) {
                        sendJsonResponse(output, 400, JSONObject().put("error", "URL репозитория не указан"))
                    } else {
                        val res = AppManager.deployGit(url, name.ifEmpty { null }, cmd.ifEmpty { null }, token.ifEmpty { null })
                        sendJsonResponse(output, if (res.has("error")) 400 else 200, res)
                    }
                }

                uriPath == "/api/apps/deploy-zip" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val name = reqJson.optString("name", queryParams["name"] ?: "").trim()
                    val cmd = reqJson.optString("command", "").trim()
                    val base64Data = reqJson.optString("zip_base64", "")
                    if (base64Data.isNotEmpty()) {
                        try {
                            val bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT)
                            val res = AppManager.deployZip(name.ifEmpty { "app" }, bytes, cmd.ifEmpty { null })
                            sendJsonResponse(output, if (res.has("error")) 400 else 200, res)
                        } catch (e: Exception) {
                            sendJsonResponse(output, 400, JSONObject().put("error", "Ошибка декодирования base64: ${e.message}"))
                        }
                    } else {
                        sendJsonResponse(output, 400, JSONObject().put("error", "Отсутствуют данные zip_base64"))
                    }
                }

                uriPath == "/api/apps/start" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val name = reqJson.optString("name", "").trim()
                    val cmd = reqJson.optString("command", "").trim()
                    val res = AppManager.startApp(name, cmd.ifEmpty { null })
                    sendJsonResponse(output, if (res.has("error")) 400 else 200, res)
                }

                uriPath == "/api/apps/stop" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val name = reqJson.optString("name", "").trim()
                    val ok = AppManager.stopApp(name)
                    sendJsonResponse(output, 200, JSONObject().put("status", if (ok) "ok" else "not_running"))
                }

                uriPath == "/api/apps/delete" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val name = reqJson.optString("name", "").trim()
                    val ok = AppManager.deleteApp(name)
                    sendJsonResponse(output, 200, JSONObject().put("status", if (ok) "ok" else "error"))
                }

                uriPath == "/api/apps/logs" -> {
                    val name = queryParams["name"] ?: ""
                    val logs = AppManager.getAppLogs(name)
                    sendJsonResponse(output, 200, JSONObject().put("name", name).put("logs", logs))
                }

                uriPath == "/api/screen/off" && method == "POST" -> {
                    executeShell("input keyevent 223") // KEYCODE_SLEEP
                    ServerService.addLog("Экран переведен в спящий режим (выключен)", "ПИТАНИЕ")
                    sendJsonResponse(output, 200, JSONObject().put("status", "ok").put("screen", "off"))
                }

                uriPath == "/api/screen/on" && method == "POST" -> {
                    executeShell("input keyevent 224") // KEYCODE_WAKEUP
                    ServerService.addLog("Экран включен (пробуждение)", "ПИТАНИЕ")
                    sendJsonResponse(output, 200, JSONObject().put("status", "ok").put("screen", "on"))
                }

                uriPath == "/api/debian/status" -> {
                    val resp = DebianManager.getInstallationStatus()
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/debian/install" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val customUrl = reqJson.optString("url", "").trim().ifEmpty { null }
                    val force = reqJson.optBoolean("force", false)
                    val started = DebianManager.installDebianAsync(customUrl, force)
                    val resp = JSONObject().apply {
                        put("status", if (started) "started" else if (DebianManager.isInstalled() && !force) "already_installed" else "busy")
                        put("installing", DebianManager.isInstalling.get())
                        put("message", if (started) "Установка Debian 12 запущена в фоновом режиме" else if (DebianManager.isInstalled() && !force) "Debian 12 уже готов к работе" else "Установка уже выполняется")
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/debian/uninstall" && method == "POST" -> {
                    val ok = DebianManager.uninstall()
                    val resp = JSONObject().apply {
                        put("status", if (ok) "ok" else "error")
                        put("message", if (ok) "Debian 12 rootfs успешно удален" else "Не удалось удалить (возможно, идет процесс установки)")
                    }
                    sendJsonResponse(output, 200, resp)
                }

                uriPath == "/api/exec" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val command = reqJson.optString("command", "").trim()
                    val forceProot = if (reqJson.has("proot")) reqJson.optBoolean("proot") else DebianManager.isInstalled()
                    if (command.isEmpty()) {
                        sendJsonResponse(output, 400, JSONObject().put("error", "No command provided"))
                    } else {
                        val result = executeShell(command, useProot = forceProot)
                        sendJsonResponse(output, 200, result)
                    }
                }

                uriPath == "/api/files" -> {
                    val targetPath = queryParams["path"] ?: "/sdcard"
                    val file = File(targetPath)
                    if (!file.exists()) {
                        sendJsonResponse(output, 404, JSONObject().put("error", "Path not found: $targetPath"))
                    } else {
                        val filesArr = JSONArray()
                        file.listFiles()?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))?.forEach { f ->
                            val item = JSONObject().apply {
                                put("name", f.name)
                                put("path", f.absolutePath)
                                put("is_dir", f.isDirectory)
                                put("size", if (f.isDirectory) 0 else f.length())
                                put("last_modified", f.lastModified())
                            }
                            filesArr.put(item)
                        }
                        val resp = JSONObject().apply {
                            put("current_path", file.absolutePath)
                            put("parent", file.parent ?: "")
                            put("items", filesArr)
                        }
                        sendJsonResponse(output, 200, resp)
                    }
                }

                uriPath == "/api/download" -> {
                    val filePath = queryParams["path"]
                    if (filePath == null) {
                        sendJsonResponse(output, 400, JSONObject().put("error", "Missing 'path' parameter"))
                    } else {
                        val target = File(filePath)
                        if (!target.exists() || target.isDirectory) {
                            sendJsonResponse(output, 404, JSONObject().put("error", "File not found or is directory"))
                        } else {
                            sendFileResponse(output, target)
                        }
                    }
                }

                serveAsset(output, uriPath) -> {
                    // Static web asset served
                }

                else -> {
                    sendJsonResponse(output, 404, JSONObject().put("error", "Not Found"))
                }
            }
        } catch (e: Exception) {
            logCallback("Client handle exception: ${e.message}")
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun serveAsset(output: OutputStream, path: String): Boolean {
        val clean = path.removePrefix("/").split("?")[0]
        val relPath = if (clean.isEmpty() || clean == "index.html") "web/index.html" else "web/$clean"
        return try {
            context.assets.open(relPath).use { input ->
                val bytes = input.readBytes()
                val mime = when {
                    relPath.endsWith(".html") -> "text/html; charset=utf-8"
                    relPath.endsWith(".css") -> "text/css; charset=utf-8"
                    relPath.endsWith(".js") -> "application/javascript; charset=utf-8"
                    relPath.endsWith(".json") -> "application/json; charset=utf-8"
                    relPath.endsWith(".png") -> "image/png"
                    relPath.endsWith(".svg") -> "image/svg+xml"
                    relPath.endsWith(".ico") -> "image/x-icon"
                    else -> "application/octet-stream"
                }
                sendResponse(output, 200, "OK", mime, bytes)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun parseQueryParams(url: String): Map<String, String> {
        val map = mutableMapOf<String, String>()
        val idx = url.indexOf('?')
        if (idx >= 0 && idx < url.length - 1) {
            val query = url.substring(idx + 1)
            for (param in query.split("&")) {
                val pair = param.split("=")
                if (pair.size == 2) {
                    try {
                        map[URLDecoder.decode(pair[0], "UTF-8")] = URLDecoder.decode(pair[1], "UTF-8")
                    } catch (_: Exception) {}
                }
            }
        }
        return map
    }

    private fun executeShell(command: String, useProot: Boolean = false): JSONObject {
        val result = JSONObject()
        val start = System.currentTimeMillis()
        val actualUseProot = useProot && DebianManager.isInstalled()
        try {
            val pb = if (actualUseProot) {
                val prootCmd = DebianManager.buildProotCommand(command, workDir = "/apps")
                ServerService.addLog("[EXEC-PROOT] Запуск: ${prootCmd.joinToString(" ")}", "EXEC")
                ProcessBuilder(prootCmd).apply {
                    directory(context.filesDir)
                    DebianManager.applyEnvironment(environment())
                    redirectErrorStream(true)
                }
            } else {
                ProcessBuilder("sh", "-c", command).apply {
                    val env = environment()
                    env["HOME"] = context.filesDir.absolutePath
                    env["TMPDIR"] = context.cacheDir.absolutePath
                    env["PATH"] = "/system/bin:/system/xbin:" + (env["PATH"] ?: "")
                    redirectErrorStream(true)
                }
            }
            val process = pb.start()
            val outputBuilder = StringBuilder()
            val readerThread = Thread {
                try {
                    process.inputStream.bufferedReader().use { reader ->
                        val buf = CharArray(4096)
                        var n: Int
                        while (reader.read(buf).also { n = it } != -1) {
                            if (outputBuilder.length < 512 * 1024) {
                                outputBuilder.append(buf, 0, n)
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
            readerThread.start()

            val finished = try {
                process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)
            } catch (_: Exception) { false }

            if (!finished) {
                try { process.destroyForcibly() } catch (_: Exception) {}
            }
            try { readerThread.join(2000) } catch (_: Exception) {}

            val fullOutput = outputBuilder.toString().trimEnd()
            val exitCode = if (finished) process.exitValue() else -1
            ServerService.addLog("[EXEC-PROOT] Завершено: exit=$exitCode", "EXEC")

            result.put("command", command)
            result.put("backend", if (actualUseProot) "debian_proot" else "android_shell")
            result.put("exit_code", exitCode)
            result.put("stdout", fullOutput)
            result.put("stderr", "")
            result.put("duration_ms", System.currentTimeMillis() - start)
        } catch (e: Exception) {
            result.put("command", command)
            result.put("backend", if (actualUseProot) "debian_proot" else "android_shell")
            result.put("exit_code", -1)
            result.put("error", e.message ?: "Execution failed")
        }
        return result
    }

    private fun sendJsonResponse(out: OutputStream, code: Int, json: JSONObject) {
        val bytes = json.toString(2).toByteArray(Charsets.UTF_8)
        sendResponse(out, code, if (code == 200) "OK" else "Error", "application/json; charset=utf-8", bytes)
    }

    private fun sendFileResponse(out: OutputStream, file: File) {
        val len = file.length()
        val header = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/octet-stream\r\n" +
                "Content-Length: $len\r\n" +
                "Content-Disposition: attachment; filename=\"${file.name}\"\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n"
        out.write(header.toByteArray(Charsets.UTF_8))
        file.inputStream().use { it.copyTo(out) }
        out.flush()
    }

    private fun sendResponse(out: OutputStream, code: Int, statusText: String, contentType: String, data: ByteArray) {
        val header = "HTTP/1.1 $code $statusText\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${data.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n" +
                "Connection: close\r\n\r\n"
        out.write(header.toByteArray(Charsets.UTF_8))
        if (data.isNotEmpty()) {
            out.write(data)
        }
        out.flush()
    }

    private fun isLocalOrPrivateIp(address: InetAddress?): Boolean {
        if (address == null) return false
        if (address.isLoopbackAddress || address.isSiteLocalAddress) return true
        val rawIp = address.hostAddress ?: return false
        val ip = if (rawIp.startsWith("::ffff:")) rawIp.substring(7) else rawIp
        if (ip == "127.0.0.1" || ip == "::1" || ip == "localhost") return true
        if (ip.startsWith("192.168.")) return true
        if (ip.startsWith("10.")) return true
        if (ip.startsWith("169.254.")) return true
        if (ip.matches(Regex("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*"))) return true
        return false
    }
}
