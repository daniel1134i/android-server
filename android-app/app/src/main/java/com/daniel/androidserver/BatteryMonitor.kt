package com.daniel.androidserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
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
        val pluggedType: String = "Unplugged",
        val remainingFormatted: String = "--",
        val remainingSeconds: Long = -1L
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("level", level)
            put("percent", percent)
            put("temp_c", tempCelsius)
            put("temp_formatted", "${String.format(java.util.Locale.US, "%.1f", tempCelsius)}°C")
            put("voltage_mv", voltageMv)
            put("is_charging", isCharging)
            put("status", status)
            put("health", health)
            put("plugged", pluggedType)
            put("remaining_formatted", remainingFormatted)
            put("remaining_seconds", remainingSeconds)
            put("overheating", tempCelsius >= 42.0)
            put("advice", if (percent > 85 && isCharging) "Рекомендуется отключить зарядку для продления срока службы" else "Состояние аккумулятора в норме")
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
            BatteryManager.BATTERY_PLUGGED_AC -> "Сеть (220V адаптер)"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB провод"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Беспроводная зарядка"
            else -> "Работа от аккумулятора"
        }

        // Расчет оставшегося времени работы или времени до полной зарядки
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        var remainingSec = -1L
        var remainingStr = "--"

        if (isCharging) {
            if (percent >= 100) {
                remainingStr = "Полный заряд (100%)"
                remainingSec = 0L
            } else {
                val chargeTimeMs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    try { bm?.computeChargeTimeRemaining() ?: -1L } catch (_: Exception) { -1L }
                } else -1L

                if (chargeTimeMs > 0) {
                    remainingSec = chargeTimeMs / 1000
                    val hours = remainingSec / 3600
                    val mins = (remainingSec % 3600) / 60
                    remainingStr = if (hours > 0) "До 100%: ~${hours} ч ${mins} мин" else "До 100%: ~${mins} мин"
                } else {
                    val neededPct = 100 - percent
                    val mins = Math.max(5, (neededPct * 1.3).toLong())
                    val hours = mins / 60
                    val remMins = mins % 60
                    remainingStr = if (hours > 0) "До 100%: ~${hours} ч ${remMins} мин" else "До 100%: ~${mins} мин"
                    remainingSec = mins * 60
                }
            }
        } else {
            val currentNowUa = try { bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: 0 } catch (_: Exception) { 0 }
            val chargeCounterUah = try { bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) ?: 0 } catch (_: Exception) { 0 }

            if (currentNowUa < -10000 && chargeCounterUah > 0) {
                val currentMa = Math.abs(currentNowUa) / 1000.0
                val chargeMah = chargeCounterUah / 1000.0
                val hours = chargeMah / currentMa
                remainingSec = (hours * 3600).toLong()
                val h = remainingSec / 3600
                val m = (remainingSec % 3600) / 60
                remainingStr = "~${h} ч ${m} мин"
            } else {
                // Сервер в фоне с экраном потребляет в среднем 4-6% в час
                val estHours = percent / 4.5
                val h = estHours.toInt()
                val m = ((estHours - h) * 60).toInt()
                remainingSec = (estHours * 3600).toLong()
                remainingStr = if (h > 0) "~${h} ч ${m} мин" else "~${m} мин"
            }
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
            pluggedType = plugged,
            remainingFormatted = remainingStr,
            remainingSeconds = remainingSec
        )
    }
}
