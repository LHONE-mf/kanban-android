package com.kanban.offline

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.view.View
import android.graphics.Color
import java.time.LocalDate
import android.speech.tts.TextToSpeech
import java.util.Locale
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import android.view.Gravity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var japaneseButton: Button
    private lateinit var dailyBanner: LinearLayout
    private var japaneseSpeech: TextToSpeech? = null
    private var japaneseVoiceReady = false
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var pendingMicRequest: PermissionRequest? = null
    private val appOrigin = "https://appassets.androidplatform.net"

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val files = if (result.resultCode == RESULT_OK) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        pendingFiles?.onReceiveValue(files)
        pendingFiles = null
    }

    private val microphonePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val request = pendingMicRequest
        pendingMicRequest = null
        if (request != null) {
            if (granted && request.origin.toString().removeSuffix("/") == appOrigin &&
                request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                request.deny()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        japaneseSpeech = TextToSpeech(this) { status ->
            japaneseVoiceReady = status == TextToSpeech.SUCCESS &&
                (japaneseSpeech?.setLanguage(Locale.JAPANESE) ?: TextToSpeech.LANG_NOT_SUPPORTED) >= TextToSpeech.LANG_AVAILABLE
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams
                ): Boolean {
                    pendingFiles?.onReceiveValue(null)
                    pendingFiles = filePathCallback
                    return try {
                        filePicker.launch(fileChooserParams.createIntent())
                        true
                    } catch (_: Exception) {
                        pendingFiles?.onReceiveValue(null)
                        pendingFiles = null
                        false
                    }
                }

                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        // Grant only microphone access to the trusted bundled app origin.
                        // Never automatically grant camera or unrelated WebView permissions.
                        val trusted = request.origin.toString().removeSuffix("/") == appOrigin
                        val audioOnly = request.resources.size == 1 &&
                            request.resources[0] == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                        if (!trusted || !audioOnly || pendingMicRequest != null) {
                            request.deny()
                        } else if (ContextCompat.checkSelfPermission(
                                this@MainActivity, Manifest.permission.RECORD_AUDIO
                            ) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        } else {
                            pendingMicRequest = request
                            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }
                }

                override fun onPermissionRequestCanceled(request: PermissionRequest) {
                    if (pendingMicRequest === request) pendingMicRequest = null
                }
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                override fun onPageFinished(view: WebView, url: String) {
                    if (::japaneseButton.isInitialized) {
                        japaneseButton.text = if (url.endsWith("/japanese.html")) "← Канбан" else "日本語 · Учить"
                        if (::dailyBanner.isInitialized) updateDailyBannerVisibility(url)
                    }
                }
            }
        }

        // WebMessageListener restricts the speech bridge to the bundled app origin.
        // Never expose a general-purpose JavaScript interface to remote websites.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                webView, "JapaneseSpeech", setOf(appOrigin)
            ) { _, message, sourceOrigin, isMainFrame, _ ->
                val utterance = message.data.orEmpty()
                if (isMainFrame && sourceOrigin.toString().removeSuffix("/") == appOrigin &&
                    utterance.length in 1..100 &&
                    utterance.all { ch ->
                        ch.code in 0x3040..0x30ff || ch.code in 0x3400..0x9fff ||
                            ch == 'ー' || ch == ' ' || ch == '。' || ch == '、'
                    }) {
                    runOnUiThread {
                        if (japaneseVoiceReady) {
                            japaneseSpeech?.speak(
                                utterance, TextToSpeech.QUEUE_FLUSH, null, "japanese-kana"
                            )
                        } else {
                            android.widget.Toast.makeText(
                                this, "Установите японский голос в настройках синтеза речи Android",
                                android.widget.Toast.LENGTH_LONG
                            ).show()
                        }
                    }
                }
            }
        }

        // Keep the WebView clear of system bars and place chat controls BELOW
        // the Kanban content, rather than floating over task dialogs.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.WHITE)
        }
        root.addView(webView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ))
        dailyBanner = createDailyBanner()
        root.addView(dailyBanner)
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(12, 0, 12, 0)
            setBackgroundColor(android.graphics.Color.rgb(245, 245, 245))
        }
        val nearbyButton = Button(this).apply {
            text = "Чат по Bluetooth"
            textSize = 12f
            isAllCaps = false
            setOnClickListener { startActivity(Intent(this@MainActivity, NearbyActivity::class.java)) }
        }
        japaneseButton = Button(this).apply {
            text = "日本語 · Учить"
            textSize = 12f
            isAllCaps = false
            setOnClickListener {
                val japaneseUrl = "$appOrigin/assets/japanese.html"
                val kanbanUrl = "$appOrigin/assets/kanban.html"
                val isJapanese = webView.url?.startsWith(japaneseUrl) == true
                webView.loadUrl(if (isJapanese) kanbanUrl else japaneseUrl)
            }
        }
        toolbar.addView(japaneseButton, LinearLayout.LayoutParams(0,
            LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        toolbar.addView(nearbyButton, LinearLayout.LayoutParams(0,
            LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(toolbar, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.statusBars() or
                    WindowInsetsCompat.Type.navigationBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
        webView.loadUrl("$appOrigin/assets/kanban.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }


    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun updateDailyBannerVisibility(url: String?) {
        val completed = getSharedPreferences("japanese_daily", MODE_PRIVATE)
            .getString("completed_date", "") == LocalDate.now().toString()
        dailyBanner.visibility = if (!completed && url?.endsWith("/kanban.html") == true)
            View.VISIBLE else View.GONE
    }

    private fun completeDailyChallenge() {
        getSharedPreferences("japanese_daily", MODE_PRIVATE).edit()
            .putString("completed_date", LocalDate.now().toString()).apply()
        dailyBanner.visibility = View.GONE
    }

    private fun createDailyBanner(): LinearLayout {
        val entries = listOf(
            Triple("あ", "a", "o"), Triple("い", "i", "e"),
            Triple("う", "u", "a"), Triple("え", "e", "i"),
            Triple("お", "o", "u"), Triple("か", "ka", "ki"),
            Triple("き", "ki", "ka"), Triple("く", "ku", "ko"),
            Triple("け", "ke", "ka"), Triple("こ", "ko", "ku"),
            Triple("さ", "sa", "shi"), Triple("し", "shi", "su"),
            Triple("す", "su", "sa"), Triple("せ", "se", "so"),
            Triple("そ", "so", "se")
        )
        val today = LocalDate.now().toEpochDay()
        val task = entries[Math.floorMod(today, entries.size.toLong()).toInt()]
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(236, 246, 244))
            setPadding(dp(12), dp(5), dp(12), dp(6))
            visibility = View.GONE
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = "🇯🇵 Японский за 10 секунд"
            textSize = 13f
            setTextColor(Color.rgb(34, 77, 74))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(Button(this).apply {
            text = "✕"
            contentDescription = "Скрыть задание на сегодня"
            textSize = 12f
            isAllCaps = false
            setOnClickListener { completeDailyChallenge() }
        }, LinearLayout.LayoutParams(dp(52), dp(38)))
        panel.addView(header)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(TextView(this).apply {
            text = "Как читается ${task.first}?"
            textSize = 17f
            setTextColor(Color.rgb(25, 51, 49))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        val options = if (today % 2L == 0L)
            listOf(task.second, task.third) else listOf(task.third, task.second)
        for (choice in options) {
            row.addView(Button(this).apply {
                text = choice
                isAllCaps = false
                textSize = 13f
                setOnClickListener {
                    if (choice != task.second) {
                        android.widget.Toast.makeText(
                            this@MainActivity,
                            "${task.first} читается ${task.second}",
                            android.widget.Toast.LENGTH_SHORT
                        ).show()
                    }
                    completeDailyChallenge()
                }
            }, LinearLayout.LayoutParams(dp(65), dp(44)))
        }
        panel.addView(row)
        return panel
    }

    override fun onDestroy() {
        pendingMicRequest?.deny()
        pendingMicRequest = null
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        webView.destroy()
        japaneseSpeech?.stop()
        japaneseSpeech?.shutdown()
        japaneseSpeech = null
        super.onDestroy()
    }
}
