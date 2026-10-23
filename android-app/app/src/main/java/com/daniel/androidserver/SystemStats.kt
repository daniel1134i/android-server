package com.daniel.androidserver

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

object SystemStats {

    fun getMemoryInfo(context: Context): JSONObject {
        val actManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        actManager?.getMemoryInfo(memInfo)

        val totalMb = memInfo.totalMem / (1024 * 1024)
        val availMb = memInfo.availMem / (1024 * 1024)
        val usedMb = totalMb - availMb
        val percent = if (totalMb > 0) (usedMb * 100 / totalMb) else 0

        return JSONObject().apply {
            put("total_mb", totalMb)
            put("available_mb", availMb)
            put("used_mb", usedMb)
            put("used_percent", percent)
            put("low_memory", memInfo.lowMemory)
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

    fun getUptimeSeconds(): Long {
        return SystemClock.elapsedRealtime() / 1000
    }
}
