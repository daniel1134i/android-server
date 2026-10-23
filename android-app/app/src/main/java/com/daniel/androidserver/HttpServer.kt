package com.daniel.androidserver

import android.content.Context
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
    private val startTime = System.currentTimeMillis()

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
                if (contentLength in 1..1048576) {
                    val buf = CharArray(contentLength)
                    var read = 0
                    while (read < contentLength) {
                        val n = input.read(buf, read, contentLength - read)
                        if (n == -1) break
                        read += n
                    }
                    bodyBuilder.append(buf, 0, read)
                }
            }

            val uriPath = if (fullPath.contains('?')) fullPath.substring(0, fullPath.indexOf('?')) else fullPath
            val queryParams = parseQueryParams(fullPath)

            logCallback("$method $uriPath")

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
                    val resp = JSONObject().apply {
                        put("status", "online")
                        put("uptime_s", (System.currentTimeMillis() - startTime) / 1000)
                        put("system_uptime_s", SystemStats.getUptimeSeconds())
                        put("battery", batteryMonitor.getInfo().toJson())
                        put("memory", SystemStats.getMemoryInfo(context))
                        put("storage", SystemStats.getStorageInfo())
                        put("device", SystemStats.getDeviceInfo())
                        put("network", JSONObject().apply {
                            put("ip", SystemStats.getIpAddress() ?: "127.0.0.1")
                            put("port", port)
                        })
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
                    ServerService.logRing.clear()
                    ServerService.addLog("Logs cleared by user", "SYSTEM")
                    sendJsonResponse(output, 200, JSONObject().put("status", "ok"))
                }

                uriPath == "/api/exec" && method == "POST" -> {
                    val reqJson = try { JSONObject(bodyBuilder.toString()) } catch (_: Exception) { JSONObject() }
                    val command = reqJson.optString("command", "").trim()
                    if (command.isEmpty()) {
                        sendJsonResponse(output, 400, JSONObject().put("error", "No command provided"))
                    } else {
                        val result = executeShell(command)
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

    private fun executeShell(command: String): JSONObject {
        val result = JSONObject()
        val start = System.currentTimeMillis()
        try {
            val process = Runtime.getRuntime().exec(arrayOf("sh", "-c", command))
            val stdout = process.inputStream.bufferedReader().use { it.readText() }
            val stderr = process.errorStream.bufferedReader().use { it.readText() }
            val exitCode = process.waitFor()

            result.put("command", command)
            result.put("exit_code", exitCode)
            result.put("stdout", stdout)
            result.put("stderr", stderr)
            result.put("duration_ms", System.currentTimeMillis() - start)
        } catch (e: Exception) {
            result.put("command", command)
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
}
