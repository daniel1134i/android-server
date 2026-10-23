package com.daniel.androidserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import org.json.JSONObject

class BatteryMonitor(private val context: Context) {

    data class BatteryInfo(
        val level: Int = 0,
        val scale: Int = 100,
        val percent: Int = 0,
        val tempCelsius: Double = 0.0,
        val voltageMv: Int = 0,
        val isCharging: Boolean = false,
        val status: String = "Unknown",
        val health: String = "Unknown",
        val pluggedType: String = "Unplugged"
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("level", level)
            put("percent", percent)
            put("temp_c", tempCelsius)
            put("voltage_mv", voltageMv)
            put("is_charging", isCharging)
            put("status", status)
            put("health", health)
            put("plugged", pluggedType)
            put("overheating", tempCelsius >= 42.0)
            put("advice", if (percent > 85 && isCharging) "Recommend unplugging to extend lifespan" else "Battery state optimal")
        }
    }

    private var currentInfo = BatteryInfo()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            intent?.let { updateFromIntent(it) }
        }
    }

    fun start() {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val initial = context.registerReceiver(receiver, filter)
        initial?.let { updateFromIntent(it) }
    }

    fun stop() {
        try {
            context.unregisterReceiver(receiver)
        } catch (_: Exception) {}
    }

    fun getInfo(): BatteryInfo = currentInfo

    private fun updateFromIntent(intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val percent = if (level >= 0 && scale > 0) (level * 100 / scale) else 0

        val tempRaw = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0)
        val tempCelsius = tempRaw / 10.0

        val voltageMv = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0)

        val statusInt = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val isCharging = statusInt == BatteryManager.BATTERY_STATUS_CHARGING ||
                statusInt == BatteryManager.BATTERY_STATUS_FULL

        val status = when (statusInt) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "Charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "Discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "Full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "Not Charging"
            else -> "Unknown"
        }

        val healthInt = intent.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)
        val health = when (healthInt) {
            BatteryManager.BATTERY_HEALTH_GOOD -> "Good"
            BatteryManager.BATTERY_HEALTH_OVERHEAT -> "Overheat"
            BatteryManager.BATTERY_HEALTH_DEAD -> "Dead"
            BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "Over Voltage"
            else -> "Normal"
        }

        val pluggedInt = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
        val plugged = when (pluggedInt) {
            BatteryManager.BATTERY_PLUGGED_AC -> "AC Wall Charger"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB Cable"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Wireless"
            else -> "Battery Only"
        }

        currentInfo = BatteryInfo(
            level = level,
            scale = scale,
            percent = percent,
            tempCelsius = tempCelsius,
            voltageMv = voltageMv,
            isCharging = isCharging,
            status = status,
            health = health,
            pluggedType = plugged
        )
    }
}
