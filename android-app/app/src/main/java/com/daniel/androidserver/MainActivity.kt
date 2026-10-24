package com.daniel.androidserver

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var isDimmed = false

    private val resetReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            runOnUiThread {
                if (isDimmed) toggleDimScreen()
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                Toast.makeText(this@MainActivity, "⚡ Сервер сброшен к заводским настройкам!", Toast.LENGTH_LONG).show()
                webView.loadUrl("http://127.0.0.1:8080/node.html?reset=1")
            }
        }
    }

    class WebAppInterface(private val activity: MainActivity) {
        @JavascriptInterface
        fun toggleDim(): Boolean {
            activity.runOnUiThread {
                activity.toggleDimScreen()
            }
            return true
        }

        @JavascriptInterface
        fun toggleServer(): Boolean {
            activity.runOnUiThread {
                activity.toggleServer()
            }
            return ServerService.isRunning
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Ensure ServerService runs in foreground 24/7
        startServerService()

        webView = findViewById(R.id.webView)
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.allowUniversalAccessFromFileURLs = true
        settings.allowFileAccessFromFileURLs = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_NO_CACHE

        WebView.setWebContentsDebuggingEnabled(true)
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                view?.postDelayed({
                    view.loadUrl("http://127.0.0.1:8080/node.html")
                }, 500)
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setCancelable(false)
                    .show()
                return true
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setCancelable(false)
                    .show()
                return true
            }
        }
        webView.addJavascriptInterface(WebAppInterface(this), "androidAPI")

        // Load dedicated host node dashboard
        webView.loadUrl("http://127.0.0.1:8080/node.html")

        val filter = IntentFilter(ServerService.ACTION_RESET)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(resetReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(resetReceiver, filter)
        }
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(resetReceiver)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    fun toggleServer() {
        if (ServerService.isRunning) {
            val serviceIntent = Intent(this, ServerService::class.java).apply {
                action = ServerService.ACTION_STOP
            }
            startService(serviceIntent)
        } else {
            startServerService()
        }
    }

    fun toggleDimScreen(): Boolean {
        val layoutParams = window.attributes
        if (isDimmed) {
            layoutParams.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            isDimmed = false
        } else {
            layoutParams.screenBrightness = 0.01f
            isDimmed = true
        }
        window.attributes = layoutParams
        return isDimmed
    }

    private fun startServerService() {
        val serviceIntent = Intent(this, ServerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
