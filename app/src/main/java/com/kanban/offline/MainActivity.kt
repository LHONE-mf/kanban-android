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
