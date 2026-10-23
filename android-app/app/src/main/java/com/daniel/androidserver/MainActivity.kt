package com.daniel.androidserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var tvServerStatusBadge: TextView
    private lateinit var tvNetworkUrl: TextView
    private lateinit var tvUsbUrl: TextView
    private lateinit var tvBatteryStats: TextView
    private lateinit var tvMemoryStats: TextView
    private lateinit var tvCpuStats: TextView
    private lateinit var tvLogs: TextView
    private lateinit var btnToggleServer: Button
    private lateinit var btnDimScreen: Button

    private var isDimmed = false
    private val handler = Handler(Looper.getMainLooper())
    private var batteryMonitor: BatteryMonitor? = null
    private val logList = LinkedList<String>()

    private val logReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val msg = intent?.getStringExtra(ServerService.EXTRA_LOG_MSG) ?: return
            appendLog(msg)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvServerStatusBadge = findViewById(R.id.tvServerStatusBadge)
        tvNetworkUrl = findViewById(R.id.tvNetworkUrl)
        tvUsbUrl = findViewById(R.id.tvUsbUrl)
        tvBatteryStats = findViewById(R.id.tvBatteryStats)
        tvMemoryStats = findViewById(R.id.tvMemoryStats)
        tvCpuStats = findViewById(R.id.tvCpuStats)
        tvLogs = findViewById(R.id.tvLogs)
        btnToggleServer = findViewById(R.id.btnToggleServer)
        btnDimScreen = findViewById(R.id.btnDimScreen)

        batteryMonitor = BatteryMonitor(this).apply { start() }

        // Start server service automatically
        startServerService()

        btnToggleServer.setOnClickListener {
            if (ServerService.isRunning) {
                stopServerService()
            } else {
                startServerService()
            }
            updateUi()
        }

        btnDimScreen.setOnClickListener {
            toggleDimScreen()
        }

        updateUi()
        startStatsTicker()
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(ServerService.ACTION_LOG)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(logReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(logReceiver, filter)
        }
        updateUi()
    }

    override fun onPause() {
        super.onPause()
        try {
            unregisterReceiver(logReceiver)
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        batteryMonitor?.stop()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun startServerService() {
        val serviceIntent = Intent(this, ServerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        appendLog("[SERVICE] Foreground Service requested")
        updateUi()
    }

    private fun stopServerService() {
        val serviceIntent = Intent(this, ServerService::class.java).apply {
            action = ServerService.ACTION_STOP
        }
        startService(serviceIntent)
        appendLog("[SERVICE] Stop signal sent")
        updateUi()
    }

    private fun toggleDimScreen() {
        val layoutParams = window.attributes
        if (isDimmed) {
            layoutParams.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            btnDimScreen.text = "OLED DIM (SAVE POWER)"
            isDimmed = false
            appendLog("[POWER] Screen brightness restored")
        } else {
            layoutParams.screenBrightness = 0.01f
            btnDimScreen.text = "RESTORE BRIGHTNESS"
            isDimmed = true
            appendLog("[POWER] OLED Dim mode activated (saving 90% screen power)")
        }
        window.attributes = layoutParams
    }

    private fun updateUi() {
        val running = ServerService.isRunning
        if (running) {
            tvServerStatusBadge.text = "● RUNNING [ONLINE : 8080]"
            tvServerStatusBadge.setTextColor(resources.getColor(R.color.status_green, theme))
            btnToggleServer.text = "STOP SERVER"
        } else {
            tvServerStatusBadge.text = "○ STOPPED [OFFLINE]"
            tvServerStatusBadge.setTextColor(resources.getColor(R.color.status_red, theme))
            btnToggleServer.text = "START SERVER"
        }

        val ip = getLocalIpAddress() ?: "127.0.0.1"
        tvNetworkUrl.text = "Wi-Fi : http://$ip:8080"
        tvUsbUrl.text = "USB   : http://127.0.0.1:8080 (via adb forward)"

        updateTelemetry()
    }

    private fun updateTelemetry() {
        val bat = batteryMonitor?.getInfo()
        if (bat != null) {
            val chargingIcon = if (bat.isCharging) "⚡" else "🔋"
            tvBatteryStats.text = "BATTERY : $chargingIcon ${bat.percent}% | ${bat.tempCelsius}°C | ${bat.status} (${bat.pluggedType})"
        }

        val mem = SystemStats.getMemoryInfo(this)
        val totalGb = String.format(Locale.US, "%.1f", mem.optLong("total_mb") / 1024.0)
        val usedGb = String.format(Locale.US, "%.1f", mem.optLong("used_mb") / 1024.0)
        val memPct = mem.optInt("used_percent")
        tvMemoryStats.text = "RAM     : $usedGb GB / $totalGb GB ($memPct% used)"

        val dev = SystemStats.getDeviceInfo()
        tvCpuStats.text = "CPU     : ${dev.optInt("cores")} Cores | Model: ${dev.optString("model")} (${dev.optString("arch")})"
    }

    private fun startStatsTicker() {
        handler.postDelayed(object : Runnable {
            override fun run() {
                updateTelemetry()
                handler.postDelayed(this, 2500)
            }
        }, 2500)
    }

    private fun appendLog(msg: String) {
        val time = String.format(Locale.US, "%tT", Date())
        logList.addFirst("[$time] $msg")
        if (logList.size > 20) {
            logList.removeLast()
        }
        tvLogs.text = logList.joinToString("\n")
    }

    private fun getLocalIpAddress(): String? {
        try {
            val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            for (intf in interfaces) {
                if (intf.name.contains("wlan") || intf.name.contains("eth")) {
                    val addrs = Collections.list(intf.inetAddresses)
                    for (addr in addrs) {
                        if (!addr.isLoopbackAddress && addr is Inet4Address) {
                            return addr.hostAddress
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return null
    }
}
