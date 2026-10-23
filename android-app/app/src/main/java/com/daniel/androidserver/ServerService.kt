package com.daniel.androidserver

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.net.wifi.WifiManager
import androidx.core.app.NotificationCompat

class ServerService : Service() {

    companion object {
        const val CHANNEL_ID = "android_server_service_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.daniel.androidserver.ACTION_STOP"
        const val ACTION_LOG = "com.daniel.androidserver.ACTION_LOG"
        const val EXTRA_LOG_MSG = "extra_log_msg"

        var isRunning: Boolean = false
            private set

        val logRing: MutableList<org.json.JSONObject> = java.util.Collections.synchronizedList(java.util.LinkedList())

        fun addLog(msg: String, level: String = "INFO") {
            val entry = org.json.JSONObject().apply {
                put("timestamp", System.currentTimeMillis())
                put("level", level)
                put("message", msg)
            }
            logRing.add(entry)
            while (logRing.size > 300) {
                try { logRing.removeAt(0) } catch (_: Exception) {}
            }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var httpServer: HttpServer? = null
    private var batteryMonitor: BatteryMonitor? = null
    private var discoveryService: DiscoveryService? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        // CPU WakeLock
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AndroidServer:ServiceWakeLock").apply {
            setReferenceCounted(false)
            acquire()
        }

        // Wi-Fi High Performance Lock (prevents Wi-Fi chip sleep when unplugged from USB/charger)
        try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val wifiMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifiManager.createWifiLock(wifiMode, "AndroidServer:WifiLock").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            addLog("Не удалось захватить WifiLock: ${e.message}", "ПРЕДУПРЕЖДЕНИЕ")
        }

        batteryMonitor = BatteryMonitor(this).apply { start() }

        AppManager.init(this)

        httpServer = HttpServer(
            context = this,
            port = 8080,
            batteryMonitor = batteryMonitor!!
        ) { logMsg ->
            broadcastLog(logMsg)
        }
        httpServer?.start()

        discoveryService = DiscoveryService(this, 8080, 8081) { logMsg ->
            broadcastLog(logMsg)
        }.apply { start() }

        isRunning = true
        broadcastLog("Server service started on port 8080")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification("Listening on 0.0.0.0:8080")
        startForeground(NOTIFICATION_ID, notification)

        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        discoveryService?.stop()
        httpServer?.stop()
        batteryMonitor?.stop()

        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}

        try {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
            }
        } catch (_: Exception) {}

        broadcastLog("Server service stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun broadcastLog(msg: String) {
        addLog(msg)
        val intent = Intent(ACTION_LOG).apply {
            putExtra(EXTRA_LOG_MSG, msg)
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    private fun buildNotification(statusText: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Android Server [Online]")
            .setContentText(statusText)
            .setSmallIcon(R.drawable.ic_stat_server)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = getString(R.string.channel_name)
            val desc = getString(R.string.channel_desc)
            val importance = NotificationManager.IMPORTANCE_LOW
            val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
                description = desc
                setShowBadge(false)
            }
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }
}
