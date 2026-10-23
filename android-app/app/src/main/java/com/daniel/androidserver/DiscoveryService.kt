package com.daniel.androidserver

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean

class DiscoveryService(
    private val context: Context,
    private val httpPort: Int = 8080,
    private val udpPort: Int = 8081,
    private val logCallback: (String) -> Unit
) {
    private var nsdManager: NsdManager? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var udpSocket: DatagramSocket? = null
    private val isRunning = AtomicBoolean(false)

    fun start() {
        if (isRunning.get()) return
        isRunning.set(true)

        startNsd()
        startUdpResponder()
    }

    fun stop() {
        isRunning.set(false)
        stopNsd()
        try {
            udpSocket?.close()
        } catch (_: Exception) {}
    }

    private fun startNsd() {
        try {
            nsdManager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
            val serviceInfo = NsdServiceInfo().apply {
                serviceName = "AndroidServerNode"
                serviceType = "_androidserver._tcp."
                port = httpPort
            }

            registrationListener = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(service: NsdServiceInfo) {
                    logCallback("[mDNS] Registered service: ${service.serviceName}")
                }

                override fun onRegistrationFailed(service: NsdServiceInfo, errorCode: Int) {
                    logCallback("[mDNS] Registration failed (code $errorCode)")
                }

                override fun onServiceUnregistered(service: NsdServiceInfo) {}
                override fun onUnregistrationFailed(service: NsdServiceInfo, errorCode: Int) {}
            }

            nsdManager?.registerService(
                serviceInfo,
                NsdManager.PROTOCOL_DNS_SD,
                registrationListener
            )
        } catch (e: Exception) {
            logCallback("[mDNS] Init error: ${e.message}")
        }
    }

    private fun stopNsd() {
        try {
            if (registrationListener != null) {
                nsdManager?.unregisterService(registrationListener)
                registrationListener = null
            }
        } catch (_: Exception) {}
    }

    private fun startUdpResponder() {
        Thread {
            try {
                udpSocket = DatagramSocket(udpPort, InetAddress.getByName("0.0.0.0")).apply {
                    broadcast = true
                }
                logCallback("[UDP] Discovery responder ready on port $udpPort")

                val buffer = ByteArray(1024)
                while (isRunning.get()) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        udpSocket?.receive(packet)

                        val msg = String(packet.data, 0, packet.length).trim()
                        if (msg.contains("DISCOVER_ANDROID_SERVER")) {
                            val replyJson = JSONObject().apply {
                                put("server", "AndroidAutonomousServer")
                                put("port", httpPort)
                                put("model", Build.MODEL)
                                put("version", "1.0.0")
                            }.toString()

                            val replyBytes = replyJson.toByteArray(Charsets.UTF_8)
                            val replyPacket = DatagramPacket(
                                replyBytes,
                                replyBytes.size,
                                packet.address,
                                packet.port
                            )
                            udpSocket?.send(replyPacket)
                            logCallback("[UDP] Responded to discovery from ${packet.address.hostAddress}")
                        }
                    } catch (e: Exception) {
                        if (!isRunning.get()) break
                    }
                }
            } catch (e: Exception) {
                logCallback("[UDP] Error: ${e.message}")
            }
        }.start()
    }
}
