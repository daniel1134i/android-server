package com.daniel.androidserver

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var isDimmed = false

    class WebAppInterface(private val activity: MainActivity) {
        @JavascriptInterface
        fun toggleDim(): Boolean {
            activity.runOnUiThread {
                activity.toggleDimScreen()
            }
            return true
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
                    view.loadUrl("http://127.0.0.1:8080/")
                }, 500)
            }
        }
        webView.addJavascriptInterface(WebAppInterface(this), "androidAPI")

        // Load dashboard directly from local autonomous server
        webView.loadUrl("http://127.0.0.1:8080/")
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
