package com.daniel.androidserver

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

object SystemStats {

    var serverStartTime: Long = System.currentTimeMillis()

    fun getFullStatus(context: Context, port: Int = 8080): JSONObject {
        val bm = BatteryMonitor(context).apply { start() }
        val batJson = bm.getInfo().toJson()
        bm.stop()

        return JSONObject().apply {
            put("status", "online")
            put("uptime_s", (System.currentTimeMillis() - serverStartTime) / 1000)
            put("system_uptime_s", getUptimeSeconds())
            put("battery", batJson)
            put("memory", getMemoryInfo(context))
            put("storage", getStorageInfo())
            put("device", getDeviceInfo())
            put("network", JSONObject().apply {
                put("ip", getIpAddress() ?: "127.0.0.1")
                put("port", port)
            })
            put("cloud", JSONObject().apply {
                put("node_id", ServerService.cloudRelay?.nodeId ?: "")
                put("secret_key", ServerService.cloudRelay?.secretKey ?: "")
                put("connected", ServerService.cloudRelay?.isConnected == true)
                put("relay_url", ServerService.cloudRelay?.relayUrl ?: "")
            })
            put("debian", DebianManager.getInstallationStatus())
        }
    }

    fun getServerMemoryUsageKb(): Long {
        var sumRssKb = 0L
        val myUid = android.os.Process.myUid()
        try {
            val procDir = File("/proc")
            val pids = procDir.listFiles()?.filter { it.name.all { ch -> ch.isDigit() } } ?: emptyList()
            for (p in pids) {
                val statusFile = File(p, "status")
                if (statusFile.exists()) {
                    var isMyUid = false
                    var rssKb = 0L
                    for (line in statusFile.readLines()) {
                        if (line.startsWith("Uid:")) {
                            val parts = line.split(Regex("\\s+"))
                            if (parts.size >= 2 && parts[1].toIntOrNull() == myUid) {
                                isMyUid = true
                            }
                        } else if (line.startsWith("VmRSS:")) {
                            val parts = line.split(Regex("\\s+"))
                            if (parts.size >= 2) {
                                rssKb = parts[1].toLongOrNull() ?: 0L
                            }
                        }
                    }
                    if (isMyUid) {
                        sumRssKb += rssKb
                    }
                }
            }
        } catch (_: Exception) {}

        if (sumRssKb <= 0) {
            sumRssKb = android.os.Debug.getPss()
        }
        return sumRssKb
    }

    fun getMemoryInfo(context: Context): JSONObject {
        val actManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        actManager?.getMemoryInfo(memInfo)

        val totalMb = memInfo.totalMem / (1024 * 1024)
        val availMb = memInfo.availMem / (1024 * 1024)
        val usedMb = totalMb - availMb
        val percent = if (totalMb > 0) (usedMb * 100 / totalMb) else 0

        val totalGb = String.format(java.util.Locale.US, "%.1f", totalMb / 1024.0)
        val usedGb = String.format(java.util.Locale.US, "%.1f", usedMb / 1024.0)
        val availGb = String.format(java.util.Locale.US, "%.1f", availMb / 1024.0)

        val serverKb = getServerMemoryUsageKb()
        val serverMb = serverKb / 1024
        val serverGb = String.format(java.util.Locale.US, "%.2f", serverMb / 1024.0)
        val serverPctVal = if (totalMb > 0) (serverMb * 100.0 / totalMb) else 0.0
        val serverPercent = String.format(java.util.Locale.US, "%.1f", serverPctVal)
        val serverFormatted = if (serverMb >= 1024) "$serverGb ГБ ($serverPercent%)" else "$serverMb МБ ($serverPercent%)"

        return JSONObject().apply {
            put("total_mb", totalMb)
            put("available_mb", availMb)
            put("used_mb", usedMb)
            put("used_percent", percent)
            put("total_gb", totalGb)
            put("used_gb", usedGb)
            put("avail_gb", availGb)
            put("server_used_mb", serverMb)
            put("server_used_gb", serverGb)
            put("server_used_percent", serverPercent)
            put("server_formatted", serverFormatted)
            put("low_memory", memInfo.lowMemory)
        }
    }

    fun getDetailedMemoryBreakdown(context: Context): JSONObject {
        val memInfoObj = getMemoryInfo(context)
        val meminfoMap = mutableMapOf<String, Long>()
        try {
            val f = File("/proc/meminfo")
            if (f.exists()) {
                for (line in f.readLines()) {
                    val parts = line.split(":")
                    if (parts.size >= 2) {
                        val key = parts[0].trim()
                        val v = parts[1].trim().split(Regex("\\s+"))[0].toLongOrNull() ?: 0L
                        meminfoMap[key] = v
                    }
                }
            }
        } catch (_: Exception) {}

        val totalKb = meminfoMap["MemTotal"] ?: (memInfoObj.optLong("total_mb") * 1024)
        val freeKb = meminfoMap["MemFree"] ?: 0L
        val availKb = meminfoMap["MemAvailable"] ?: (memInfoObj.optLong("available_mb") * 1024)
        val cachedKb = meminfoMap["Cached"] ?: 0L
        val buffersKb = meminfoMap["Buffers"] ?: 0L
        val swapTotalKb = meminfoMap["SwapTotal"] ?: 0L
        val swapFreeKb = meminfoMap["SwapFree"] ?: 0L
        val swapUsedKb = Math.max(0L, swapTotalKb - swapFreeKb)

        val myUid = android.os.Process.myUid()
        val procList = JSONArray()
        try {
            val procDir = File("/proc")
            val pids = procDir.listFiles()?.filter { it.name.all { ch -> ch.isDigit() } } ?: emptyList()
            for (p in pids) {
                val statusFile = File(p, "status")
                val cmdFile = File(p, "cmdline")
                if (statusFile.exists()) {
                    var isMyUid = false
                    var rssKb = 0L
                    var pName = p.name
                    for (line in statusFile.readLines()) {
                        if (line.startsWith("Name:")) {
                            pName = line.substringAfter("Name:").trim()
                        } else if (line.startsWith("Uid:")) {
                            val parts = line.split(Regex("\\s+"))
                            if (parts.size >= 2 && parts[1].toIntOrNull() == myUid) {
                                isMyUid = true
                            }
                        } else if (line.startsWith("VmRSS:")) {
                            val parts = line.split(Regex("\\s+"))
                            if (parts.size >= 2) {
                                rssKb = parts[1].toLongOrNull() ?: 0L
                            }
                        }
                    }
                    if (isMyUid && rssKb > 0) {
                        var cmd = ""
                        try {
                            if (cmdFile.exists()) {
                                cmd = cmdFile.readText().replace('\u0000', ' ').trim()
                            }
                        } catch (_: Exception) {}

                        val rssMb = rssKb / 1024
                        val pct = if (totalKb > 0) String.format(java.util.Locale.US, "%.1f", rssKb * 100.0 / totalKb) else "0.0"

                        val label = when {
                            cmd.contains("com.daniel.androidserver") -> "Основное приложение-сервер (UI, HTTP, Релей)"
                            cmd.contains("proot") || pName.contains("proot") -> "Слой виртуализации Linux (PRoot)"
                            cmd.contains("postgres") -> "СУБД PostgreSQL 16"
                            cmd.contains("redis") -> "Сервер Redis 7"
                            cmd.contains("python") -> "Python приложение"
                            cmd.contains("cloudflared") -> "Cloudflare Tunnel агент"
                            else -> if (cmd.isNotEmpty()) cmd else pName
                        }

                        procList.put(JSONObject().apply {
                            put("pid", p.name.toIntOrNull() ?: 0)
                            put("name", pName)
                            put("cmd", if (cmd.length > 50) cmd.substring(0, 47) + "..." else cmd)
                            put("label", label)
                            put("rss_mb", rssMb)
                            put("rss_kb", rssKb)
                            put("percent", pct)
                        })
                    }
                }
            }
        } catch (_: Exception) {}

        return JSONObject().apply {
            put("memory", memInfoObj)
            put("categories", JSONObject().apply {
                put("cached_mb", cachedKb / 1024)
                put("buffers_mb", buffersKb / 1024)
                put("free_mb", freeKb / 1024)
                put("available_mb", availKb / 1024)
                put("swap_total_mb", swapTotalKb / 1024)
                put("swap_used_mb", swapUsedKb / 1024)
            })
            put("server_processes", procList)
        }
    }

    fun getStorageInfo(): JSONObject {
        val root = Environment.getExternalStorageDirectory()
        val totalMb = root.totalSpace / (1024 * 1024)
        val freeMb = root.freeSpace / (1024 * 1024)
        val usedMb = totalMb - freeMb
        val percent = if (totalMb > 0) (usedMb * 100 / totalMb) else 0

        return JSONObject().apply {
            put("path", root.absolutePath)
            put("total_mb", totalMb)
            put("free_mb", freeMb)
            put("used_mb", usedMb)
            put("used_percent", percent)
        }
    }

    fun getDeviceInfo(): JSONObject {
        return JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("device", Build.DEVICE)
            put("product", Build.PRODUCT)
            put("android_version", Build.VERSION.RELEASE)
            put("sdk_int", Build.VERSION.SDK_INT)
            put("cores", Runtime.getRuntime().availableProcessors())
            put("arch", Build.SUPPORTED_ABIS.joinToString(", "))
        }
    }

    fun getIpAddress(): String? {
        try {
            val interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())
            for (intf in interfaces) {
                if (intf.name.contains("wlan") || intf.name.contains("eth") || intf.name.contains("rndis")) {
                    val addrs = java.util.Collections.list(intf.inetAddresses)
                    for (addr in addrs) {
                        if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                            return addr.hostAddress
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return null
    }

    fun getUptimeSeconds(): Long {
        return SystemClock.elapsedRealtime() / 1000
    }
}
