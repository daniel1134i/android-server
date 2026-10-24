package com.daniel.androidserver

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

class CloudRelayClient(
    private val context: Context,
    private val logCallback: (String) -> Unit
) {
    companion object {
        private const val PREFS_NAME = "android_server_cloud_prefs"
        private const val KEY_NODE_ID = "cloud_node_id"
        private const val KEY_SECRET_KEY = "cloud_secret_key"
        private const val KEY_RELAY_URL = "cloud_relay_url"
        const val DEFAULT_RELAY_URL = "ws://192.168.0.199:8088"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var nodeId: String
        private set
    var secretKey: String
        private set
    var relayUrl: String

    private var okHttpClient: OkHttpClient? = null
    private var webSocket: WebSocket? = null
    private var isRunning = false
    var isConnected = false
        private set

    private val handler = Handler(Looper.getMainLooper())
    private var reconnectAttempts = 0
    private val rpcExecutor = java.util.concurrent.Executors.newFixedThreadPool(6)

    init {
        // Загрузка или генерация уникальных учетных данных ноды
        var nid = prefs.getString(KEY_NODE_ID, null)
        var sKey = prefs.getString(KEY_SECRET_KEY, null)
        if (nid.isNullOrBlank() || sKey.isNullOrBlank()) {
            nid = "node_" + UUID.randomUUID().toString().substring(0, 8)
            sKey = "sec_" + UUID.randomUUID().toString().replace("-", "")
            prefs.edit()
                .putString(KEY_NODE_ID, nid)
                .putString(KEY_SECRET_KEY, sKey)
                .apply()
        }
        nodeId = nid
        secretKey = sKey
        relayUrl = prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL
    }

    fun start() {
        if (isRunning) return
        isRunning = true
        connect()
    }

    fun stop() {
        isRunning = false
        isConnected = false
        handler.removeCallbacksAndMessages(null)
        try {
            webSocket?.close(1000, "Service stopped")
        } catch (_: Exception) {}
        webSocket = null
    }

    fun updateRelayUrl(newUrl: String) {
        val clean = newUrl.trim()
        if (clean.isNotEmpty() && clean != relayUrl) {
            relayUrl = clean
            prefs.edit().putString(KEY_RELAY_URL, clean).apply()
            if (isRunning) {
                stop()
                start()
            }
        }
    }

    fun resetCredentials(reconnectDelayMs: Long = 600L): Pair<String, String> {
        val newNid = "node_" + UUID.randomUUID().toString().substring(0, 8)
        val newKey = "sec_" + UUID.randomUUID().toString().replace("-", "")
        prefs.edit()
            .putString(KEY_NODE_ID, newNid)
            .putString(KEY_SECRET_KEY, newKey)
            .apply()
        nodeId = newNid
        secretKey = newKey
        if (isRunning) {
            Thread {
                try { Thread.sleep(reconnectDelayMs) } catch (_: Exception) {}
                stop()
                start()
            }.start()
        }
        return Pair(newNid, newKey)
    }

    private fun connect() {
        if (!isRunning) return
        try {
            if (okHttpClient == null) {
                okHttpClient = OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.SECONDS)
                    .pingInterval(20, TimeUnit.SECONDS)
                    .build()
            }

            val request = Request.Builder()
                .url(relayUrl)
                .build()

            logCallback("[ОБЛАКО] Подключение к Relay: $relayUrl (Node ID: $nodeId)...")

            webSocket = okHttpClient?.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    reconnectAttempts = 0
                    // Отправка регистрационного хэндшейка
                    val regMsg = JSONObject().apply {
                        put("type", "register")
                        put("role", "node")
                        put("nodeId", nodeId)
                        put("token", secretKey)
                        put("version", "1.9.0")
                    }
                    ws.send(regMsg.toString())
                }

                override fun onMessage(ws: WebSocket, text: String) {
                    handleIncomingMessage(ws, text)
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    isConnected = false
                    logCallback("[ОБЛАКО] Соединение закрыто: $reason")
                    scheduleReconnect()
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    isConnected = false
                    logCallback("[ОБЛАКО] Ошибка соединения: ${t.message}")
                    scheduleReconnect()
                }
            })
        } catch (e: Exception) {
            logCallback("[ОБЛАКО] Исключение при подключении: ${e.message}")
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (!isRunning) return
        reconnectAttempts++
        val delay = Math.min(30000L, 2000L * Math.min(reconnectAttempts, 10))
        handler.postDelayed({
            if (isRunning) connect()
        }, delay)
    }

    private fun handleIncomingMessage(ws: WebSocket, raw: String) {
        try {
            val json = JSONObject(raw)

            if (json.optString("type") == "registered") {
                isConnected = true
                logCallback("[ОБЛАКО] ✓ Успешно зарегистрирован в Cloud Relay (ID: $nodeId). Ожидание контроллера...")
                return
            }

            if (json.optString("type") == "event" && json.optString("event") == "node_online") {
                logCallback("[ОБЛАКО] Контроллер подключился к виртуальной комнате")
                return
            }

            // Обработка RPC-запросов от Mac контроллера
            if (json.optString("rpc") == "req") {
                val reqId = json.optString("id", "")
                val path = json.optString("path", "")
                val method = json.optString("method", "GET").uppercase()
                val bodyObj = json.opt("body")

                // Выполняем запрос в пуле потоков и возвращаем ответ
                rpcExecutor.execute {
                    val respData = dispatchRpc(path, method, bodyObj)
                    val respMsg = JSONObject().apply {
                        put("rpc", "res")
                        put("id", reqId)
                        put("status", 200)
                        put("data", respData)
                    }
                    try {
                        ws.send(respMsg.toString())
                    } catch (_: Exception) {}
                }
            }
        } catch (e: Exception) {
            logCallback("[ОБЛАКО] Ошибка обработки RPC: ${e.message}")
        }
    }

    private fun dispatchRpc(path: String, method: String, body: Any?): Any {
        val bodyJson = if (body is JSONObject) body else JSONObject()

        return try {
            when {
                path == "/api/status" -> SystemStats.getFullStatus(context)

                path == "/api/ping" -> JSONObject().apply {
                    put("status", "ok")
                    put("time", System.currentTimeMillis())
                }

                path == "/api/apps" -> JSONObject().apply {
                    put("status", "ok")
                    put("apps", AppManager.listApps())
                    put("dir", AppManager.appsDir.absolutePath)
                }

                path.startsWith("/api/apps/logs") -> {
                    var name = bodyJson.optString("name", "")
                    if (name.isEmpty() && path.contains("name=")) {
                        name = try {
                            java.net.URLDecoder.decode(path.substringAfter("name=").substringBefore("&"), "UTF-8")
                        } catch (_: Exception) { "" }
                    }
                    val logs = AppManager.getAppLogs(name)
                    JSONObject().put("name", name).put("logs", logs)
                }

                path == "/api/apps/start" && method == "POST" -> {
                    val name = bodyJson.optString("name")
                    val cmd = bodyJson.optString("command").ifEmpty { null }
                    AppManager.startApp(name, cmd)
                }

                path == "/api/apps/stop" && method == "POST" -> {
                    val name = bodyJson.optString("name")
                    val ok = AppManager.stopApp(name)
                    JSONObject().put("status", if (ok) "ok" else "error")
                }

                path == "/api/apps/delete" && method == "POST" -> {
                    val name = bodyJson.optString("name")
                    val ok = AppManager.deleteApp(name)
                    JSONObject().put("status", if (ok) "ok" else "error")
                }

                path == "/api/apps/deploy-zip" && method == "POST" -> {
                    val name = bodyJson.optString("name")
                    val zipB64 = bodyJson.optString("zip_base64")
                    val cmd = bodyJson.optString("command").ifEmpty { null }
                    val zipBytes = android.util.Base64.decode(zipB64, android.util.Base64.DEFAULT)
                    AppManager.deployZip(name, zipBytes, cmd)
                }

                path == "/api/apps/deploy-git" && method == "POST" -> {
                    val url = bodyJson.optString("url")
                    val name = bodyJson.optString("name").ifEmpty { null }
                    val cmd = bodyJson.optString("command").ifEmpty { null }
                    val token = bodyJson.optString("token").ifEmpty { null }
                    AppManager.deployGit(url, name, cmd, token)
                }

                path == "/api/screen/off" && method == "POST" -> {
                    executeShell("input keyevent 223")
                    ServerService.addLog("Экран выключен через Cloud Relay", "ПИТАНИЕ")
                    JSONObject().put("status", "ok").put("screen", "off")
                }

                path == "/api/screen/on" && method == "POST" -> {
                    executeShell("input keyevent 224")
                    ServerService.addLog("Экран включен через Cloud Relay", "ПИТАНИЕ")
                    JSONObject().put("status", "ok").put("screen", "on")
                }

                path == "/api/logs" -> {
                    val arr = JSONArray()
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.forEach { arr.put(it) }
                    }
                    JSONObject().put("logs", arr)
                }

                path == "/api/logs/clear" -> {
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.clear()
                    }
                    JSONObject().put("status", "ok")
                }

                path == "/api/reset" -> {
                    AppManager.resetAllApps()
                    synchronized(ServerService.logRing) {
                        ServerService.logRing.clear()
                    }
                    SystemStats.serverStartTime = System.currentTimeMillis()
                    val newCreds = resetCredentials()
                    ServerService.notifyFactoryReset(context)
                    ServerService.addLog("[ЗАВОДСКОЙ СБРОС] Нода сброшена к заводским настройкам через Cloud RPC: приложения остановлены, буфер логов очищен", "SYSTEM")
                    JSONObject().apply {
                        put("status", "reset_ok")
                        put("node_id", newCreds.first)
                        put("secret_key", newCreds.second)
                        put("message", "Хост-нода сброшена к заводским настройкам")
                        put("timestamp", System.currentTimeMillis())
                    }
                }

                path.startsWith("/api/files") -> {
                    var reqPath = bodyJson.optString("path", "")
                    if (reqPath.isEmpty() && path.contains("path=")) {
                        reqPath = try {
                            java.net.URLDecoder.decode(path.substringAfter("path=").substringBefore("&"), "UTF-8")
                        } catch (_: Exception) { "" }
                    }
                    if (reqPath.isEmpty()) reqPath = "/sdcard"
                    listFilesRpc(reqPath)
                }

                path == "/api/debian/status" -> DebianManager.getInstallationStatus()

                path == "/api/debian/install" && method == "POST" -> {
                    val customUrl = bodyJson.optString("url", "").ifEmpty { null }
                    val started = DebianManager.installDebianAsync(customUrl)
                    JSONObject().apply {
                        put("status", if (started) "started" else "busy")
                        put("installing", DebianManager.isInstalling.get())
                        put("message", if (started) "Установка Debian 12 запущена в фоновом режиме" else "Установка уже выполняется")
                    }
                }

                path == "/api/debian/uninstall" && method == "POST" -> {
                    val ok = DebianManager.uninstall()
                    JSONObject().apply {
                        put("status", if (ok) "ok" else "error")
                        put("message", if (ok) "Debian 12 rootfs успешно удален" else "Не удалось удалить rootfs")
                    }
                }

                path == "/api/exec" && method == "POST" -> {
                    val cmd = bodyJson.optString("command")
                    val useProot = if (bodyJson.has("proot")) bodyJson.optBoolean("proot") else DebianManager.isInstalled()
                    executeShell(cmd, useProot)
                }

                else -> JSONObject().put("error", "Эндпоинт не поддерживается в Cloud Relay: $path")
            }
        } catch (e: Exception) {
            JSONObject().put("error", "Ошибка выполнения RPC: ${e.message}")
        }
    }

    private fun listFilesRpc(pathStr: String): JSONObject {
        val target = File(pathStr)
        if (!target.exists()) return JSONObject().put("error", "Путь не существует")
        val items = JSONArray()
        target.listFiles()?.forEach { f ->
            items.put(JSONObject().apply {
                put("name", f.name)
                put("path", f.absolutePath)
                put("is_dir", f.isDirectory)
                put("size", if (f.isFile) f.length() else 0L)
                put("modified", f.lastModified())
            })
        }
        return JSONObject().apply {
            put("path", target.absolutePath)
            put("current_path", target.absolutePath)
            put("parent", target.parent ?: "")
            put("items", items)
        }
    }

    private fun executeShell(cmd: String, useProot: Boolean = false): JSONObject {
        val t0 = System.currentTimeMillis()
        val actualUseProot = useProot && DebianManager.isInstalled()
        val pb = if (actualUseProot) {
            val prootCmd = DebianManager.buildProotCommand(cmd, workDir = "/apps")
            ProcessBuilder(prootCmd).apply {
                directory(context.filesDir)
                DebianManager.applyEnvironment(environment())
            }
        } else {
            ProcessBuilder("sh", "-c", cmd).apply {
                val env = environment()
                env["HOME"] = context.filesDir.absolutePath
                env["TMPDIR"] = context.cacheDir.absolutePath
                env["PATH"] = "/system/bin:/system/xbin:" + (env["PATH"] ?: "")
            }
        }
        pb.redirectErrorStream(false)
        val p = pb.start()

        var stdout = ""
        var stderr = ""
        val outThread = Thread {
            stdout = try { p.inputStream.bufferedReader().use { it.readText() } } catch (_: Exception) { "" }
        }
        val errThread = Thread {
            stderr = try { p.errorStream.bufferedReader().use { it.readText() } } catch (_: Exception) { "" }
        }
        outThread.start()
        errThread.start()

        val finished = try {
            p.waitFor(120, TimeUnit.SECONDS)
        } catch (_: Exception) { false }

        if (!finished) {
            try { p.destroyForcibly() } catch (_: Exception) {}
            stderr += "\n[ТАЙМАУТ: процесс принудительно остановлен через 120 сек]"
        }
        try { outThread.join(1000) } catch (_: Exception) {}
        try { errThread.join(1000) } catch (_: Exception) {}

        return JSONObject().apply {
            put("command", cmd)
            put("backend", if (actualUseProot) "debian_proot" else "android_shell")
            put("exit_code", if (finished) p.exitValue() else -1)
            put("stdout", stdout)
            put("stderr", stderr)
            put("duration_ms", System.currentTimeMillis() - t0)
        }
    }
}
