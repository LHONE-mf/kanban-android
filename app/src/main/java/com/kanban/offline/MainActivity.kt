package com.kanban.offline

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
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
import android.view.HapticFeedbackConstants
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import java.time.LocalDate
import android.speech.tts.TextToSpeech
import java.util.Locale
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import android.view.Gravity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    private lateinit var appRoot: LinearLayout
    private lateinit var bottomToolbar: LinearLayout
    private var bannerDismissedThisSession = false
    private var miniExpanded = false // Compact by default: preserve room for task cards.
    private var lastBackGestureAt = 0L
    private var dailyQuestionIndex = 0
    private var miniQuestionNumber = 0
    private var miniIsReview = false
    private var miniNextNewIndex = 0
    private var miniUnlockedKatakana = false
    private var miniCorrectCount = 0
    private var miniDarkTheme = false
    private val miniReviewQueue = ArrayDeque<Int>()
    private var japaneseSpeech: TextToSpeech? = null
    private var japaneseVoiceReady = false
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private lateinit var backupSaver: KanbanBackupSaver
    private lateinit var attachmentOpener: KanbanAttachmentOpener
    private lateinit var voiceRecorder: KanbanVoiceRecorder
    private var pendingVoicePermission: String? = null
    private var editingAttachmentId: String? = null
    private var editingFile: File? = null
    private var editingDigest: String? = null
    private var externalEditorOpened = false
    private val editLimitBytes = 5 * 1024 * 1024
    private fun digest(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private val attachmentEditor = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        externalEditorOpened = false
        val file = editingFile
        val id = editingAttachmentId
        if (file != null && id != null && file.exists()) {
            val bytes = file.readBytes()
            if (bytes.size <= editLimitBytes && digest(bytes) != editingDigest) {
                val payload = JSONObject().put("id", id)
                    .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
                webView.evaluateJavascript(
                    "window.kanbanExternalEditResult && window.kanbanExternalEditResult(" +
                        JSONObject.quote(payload) + ")", null
                )
            } else if (bytes.size > editLimitBytes) {
                android.widget.Toast.makeText(this, "Изменённый файл превышает 5 МБ", android.widget.Toast.LENGTH_LONG).show()
            }
        }
        editingAttachmentId = null
        editingFile = null
        editingDigest = null
    }

    private val appOrigin = "https://appassets.androidplatform.net"
    private val kanbanUrl = "$appOrigin/assets/kanban.html"

    /** Remove only private copies of the old GGUF; preserve IndexedDB and user files. */
    private fun removeOldModelCopy() {
        val directory=File(filesDir,"kanban_comrade")
        File(directory,"active.gguf").delete()
        File(directory,"active.gguf.part").delete()
        directory.delete()
        getSharedPreferences("kanban_comrade", MODE_PRIVATE).edit()
            .remove("model_name").apply()
    }

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val files = if (result.resultCode == RESULT_OK) {
            // Some Android file pickers put multiple choices in ClipData while
            // WebView's default parser returns only the single data URI.
            val picked = LinkedHashSet<Uri>()
            result.data?.clipData?.let { clip ->
                for (index in 0 until clip.itemCount) {
                    clip.getItemAt(index).uri?.let { picked.add(it) }
                }
            }
            result.data?.data?.let { picked.add(it) }
            WebChromeClient.FileChooserParams.parseResult(
                result.resultCode, result.data
            )?.forEach { picked.add(it) }
            picked.takeIf { it.isNotEmpty() }?.toTypedArray()
        } else null
        pendingFiles?.onReceiveValue(files)
        pendingFiles = null
    }

    private val backupDocumentPicker = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        if (::backupSaver.isInitialized) backupSaver.onDestinationPicked(uri)
    }

    private fun voiceEvent(event: JSONObject) {
        if (::webView.isInitialized && webView.url?.endsWith("/assets/kanban.html") == true) {
            webView.evaluateJavascript(
                "window.kanbanVoiceNativeResult && window.kanbanVoiceNativeResult(" +
                    JSONObject.quote(event.toString()) + ")", null
            )
        }
    }

    private val microphonePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val session = pendingVoicePermission
        pendingVoicePermission = null
        if (session != null) {
            if (granted && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
                voiceRecorder.start(session)
            } else {
                voiceEvent(JSONObject().put("id", session).put("type", "error")
                    .put("message", "Нет доступа к микрофону. Проверьте разрешения Comrade"))
            }
        }
    }

    private fun handleVoiceCommand(raw: String) {
        val data = try { JSONObject(raw) } catch (_: Exception) { return }
        val session = data.optString("id")
        val action = data.optString("type")
        if (!session.matches(Regex("[a-zA-Z0-9_-]{1,100}"))) return
        when (action) {
            "start" -> {
                if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
                    voiceEvent(JSONObject().put("id", session).put("type", "error")
                        .put("message", "Откройте Comrade для записи"))
                } else if (pendingVoicePermission != null) {
                    voiceEvent(JSONObject().put("id", session).put("type", "error")
                        .put("message", "Запрос микрофона уже открыт"))
                } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED) {
                    voiceRecorder.start(session)
                } else {
                    pendingVoicePermission = session
                    try { microphonePermission.launch(Manifest.permission.RECORD_AUDIO) }
                    catch (_: Exception) {
                        pendingVoicePermission = null
                        voiceEvent(JSONObject().put("id", session).put("type", "error")
                            .put("message", "Не удалось запросить разрешение микрофона"))
                    }
                }
            }
            "cancel" -> {
                if (pendingVoicePermission == session) pendingVoicePermission = null
                voiceRecorder.command(session, action)
            }
            "pause", "resume", "stop", "ack" -> voiceRecorder.command(session, action)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        removeOldModelCopy()
        voiceRecorder = KanbanVoiceRecorder(this, ::voiceEvent)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/voice-capture/", WebViewAssetLoader.PathHandler { path -> voiceRecorder.resource(path) })
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
                        val intent = fileChooserParams.createIntent()
                        if (fileChooserParams.mode ==
                            WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                        filePicker.launch(intent)
                        true
                    } catch (_: Exception) {
                        pendingFiles?.onReceiveValue(null)
                        pendingFiles = null
                        false
                    }
                }

                override fun onPermissionRequest(request: PermissionRequest) {
                    // Audio capture belongs to the native recorder, never to web content.
                    request.deny()
                }
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    if (!url.endsWith("/assets/kanban.html")) {
                        pendingVoicePermission = null
                        voiceRecorder.cancelForNavigation()
                    }
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (::japaneseButton.isInitialized) {
                        japaneseButton.text = if (url.endsWith("/japanese.html")) "← Comrade" else "日本語 · Учить"
                        if (::dailyBanner.isInitialized) updateDailyBannerVisibility(url)
                        view.evaluateJavascript("""(function(){function sync(){var t=document.documentElement.dataset.theme||localStorage.getItem('kanban_theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(window.KanbanTheme)KanbanTheme.postMessage(t);if(location.pathname.endsWith('/japanese.html'))document.documentElement.dataset.theme=t;}sync();if(!window.__themeSync){window.__themeSync=new MutationObserver(sync);window.__themeSync.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});}})();""", null)
                    }
                }
            }
        }

        // The bridge accepts commands only from the local Kanban main frame.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanHaptics", setOf(appOrigin)) {
                view, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    view.url != kanbanUrl || !view.hasWindowFocus()) return@addWebMessageListener
                val feedback = when (message.data) {
                    "drag" -> HapticFeedbackConstants.LONG_PRESS
                    "move" -> HapticFeedbackConstants.CLOCK_TICK
                    "done" -> HapticFeedbackConstants.CONFIRM
                    else -> return@addWebMessageListener
                }
                view.performHapticFeedback(feedback)
            }
            WebViewCompat.addWebMessageListener(webView, "KanbanVoice", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/assets/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length <= 1024) runOnUiThread { handleVoiceCommand(raw) }
            }
        }

        // Allow backup chunks only from the trusted local Comrade page.
        backupSaver = KanbanBackupSaver(
            this,
            { filename -> backupDocumentPicker.launch(filename) },
            { event ->
                webView.evaluateJavascript(
                    "window.kanbanBackupNativeResult && window.kanbanBackupNativeResult(" +
                        JSONObject.quote(event.toString()) + ")", null
                )
            }
        )
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanBackup", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length <= 48_000) {
                    runOnUiThread { backupSaver.handle(raw) }
                }
            }
        }

        // Preserve the native Japanese mini-quiz in the same full backup.
        // Only the bundled Kanban main frame can read or restore these six fields.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanJapaneseProgress", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length > 4096) return@addWebMessageListener
                runOnUiThread {
                    val reply = JSONObject()
                    try {
                        val req = JSONObject(raw)
                        reply.put("id", req.getString("id"))
                        when (req.getString("type")) {
                            "read" -> {
                                reply.put("type", "read")
                                reply.put("data", readMiniBackup())
                            }
                            "restore" -> {
                                restoreMiniBackup(req.getJSONObject("data"))
                                reply.put("type", "restored")
                            }
                            else -> throw IllegalArgumentException("Неизвестная команда")
                        }
                    } catch (error: Exception) {
                        reply.put("type", "error")
                        reply.put("message", error.message ?: "Ошибка прогресса японского")
                    }
                    webView.evaluateJavascript(
                        "window.comradeJapaneseNativeResult && window.comradeJapaneseNativeResult(" +
                            JSONObject.quote(reply.toString()) + ")", null
                    )
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

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanTheme", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && sourceOrigin.toString().removeSuffix("/") == appOrigin &&
                    message.data in listOf("dark", "light")) {
                    runOnUiThread { applyMiniTheme(message.data == "dark") }
                }
            }
        }

        // Expose attachments only as read-only, temporary FileProvider URIs.
        attachmentOpener = KanbanAttachmentOpener(
            this,
            { file, mime, name ->
                val uri = FileProvider.getUriForFile(
                    this@MainActivity, "$packageName.editablefiles", file
                )
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, mime)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    clipData = android.content.ClipData.newUri(contentResolver, name, uri)
                }
                startActivity(Intent.createChooser(intent, "Открыть вложение"))
            },
            { event ->
                webView.evaluateJavascript(
                    "window.kanbanFileOpenNativeResult && window.kanbanFileOpenNativeResult(" +
                        JSONObject.quote(event.toString()) + ")", null
                )
            }
        )
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanFileOpen", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length <= 48_000) runOnUiThread { attachmentOpener.handle(raw) }
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanFileEdit", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin) return@addWebMessageListener
                try {
                    val data = JSONObject(message.data ?: return@addWebMessageListener)
                    val id = data.getString("id")
                    val name = data.getString("name")
                    val mime = data.optString("type", "application/octet-stream")
                    val bytes = Base64.decode(data.getString("base64"), Base64.DEFAULT)
                    if (!id.matches(Regex("[a-zA-Z0-9_-]{1,100}")) ||
                        name.length !in 1..200 || bytes.size > editLimitBytes ||
                        editingAttachmentId != null) return@addWebMessageListener
                    runOnUiThread {
                        try {
                            val dir = File(cacheDir, "editable").apply { mkdirs() }
                            dir.listFiles()?.forEach { it.delete() }
                            val safeName = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                            val file = File(dir, safeName).apply { writeBytes(bytes) }
                            editingAttachmentId = id
                            editingFile = file
                            editingDigest = digest(bytes)
                            val uri = FileProvider.getUriForFile(
                                this@MainActivity, "$packageName.editablefiles", file
                            )
                            val intent = Intent(Intent.ACTION_EDIT).apply {
                                setDataAndType(uri, mime)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                                clipData = android.content.ClipData.newUri(
                                    contentResolver, name, uri
                                )
                            }
                            externalEditorOpened = true
                            attachmentEditor.launch(Intent.createChooser(intent, "Редактировать файл"))
                        } catch (e: Exception) {
                            editingAttachmentId = null
                            editingFile = null
                            editingDigest = null
                            externalEditorOpened = false
                            android.widget.Toast.makeText(this, "Не удалось открыть редактор: " +
                                (e.message ?: ""), android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                } catch (_: Exception) { }
            }
        }

        // Keep the WebView clear of system bars and Japanese learning controls
        // below the Kanban content, rather than floating over task dialogs.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(10, 10, 10))
        }
        appRoot = root
        root.addView(webView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
        ))
        dailyBanner = createDailyBanner()
        root.addView(dailyBanner)
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(12, 0, 12, 0)
            setBackgroundColor(Color.rgb(26, 26, 26))
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
        bottomToolbar = toolbar
        toolbar.addView(japaneseButton, LinearLayout.LayoutParams(0,
            LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        toolbar.addView(Button(this).apply {
            text = "あ"
            textSize = 15f
            isAllCaps = false
            contentDescription = "Показать или скрыть японское задание"
            setOnClickListener {
                miniExpanded = !miniExpanded
                if (miniExpanded) bannerDismissedThisSession = false
                updateDailyBannerVisibility(webView.url)
            }
        }, LinearLayout.LayoutParams(dp(42), LinearLayout.LayoutParams.WRAP_CONTENT))
        applyMiniTheme(miniDarkTheme)
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
        applyMiniTheme(true)
        ViewCompat.requestApplyInsets(root)
        webView.loadUrl("$appOrigin/assets/kanban.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.url?.substringBefore('?')?.endsWith("/japanese.html") == true) {
                    lastBackGestureAt = 0L
                    webView.loadUrl("$appOrigin/assets/kanban.html")
                    return
                }
                // Let the trusted local WebView autosave edits or close its topmost overlay.
                webView.evaluateJavascript(
                    "(typeof window.comradeHandleAndroidBack === 'function' && window.comradeHandleAndroidBack())"
                ) { handled ->
                    if (handled == "true") {
                        lastBackGestureAt = 0L
                    } else {
                        val now = android.os.SystemClock.elapsedRealtime()
                        if (now - lastBackGestureAt <= 2000L) {
                            finish()
                        } else {
                            lastBackGestureAt = now
                            android.widget.Toast.makeText(
                                this@MainActivity,
                                "Проведите назад ещё раз, чтобы выйти",
                                android.widget.Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                }
            }
        })
    }


    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()


    private val miniQuestions = listOf(
        "あ" to "a",
        "い" to "i",
        "う" to "u",
        "え" to "e",
        "お" to "o",
        "か" to "ka",
        "き" to "ki",
        "く" to "ku",
        "け" to "ke",
        "こ" to "ko",
        "さ" to "sa",
        "し" to "shi",
        "す" to "su",
        "せ" to "se",
        "そ" to "so",
        "た" to "ta",
        "ち" to "chi",
        "つ" to "tsu",
        "て" to "te",
        "と" to "to",
        "な" to "na",
        "に" to "ni",
        "ぬ" to "nu",
        "ね" to "ne",
        "の" to "no",
        "は" to "ha",
        "ひ" to "hi",
        "ふ" to "fu",
        "へ" to "he",
        "ほ" to "ho",
        "ま" to "ma",
        "み" to "mi",
        "む" to "mu",
        "め" to "me",
        "も" to "mo",
        "や" to "ya",
        "ゆ" to "yu",
        "よ" to "yo",
        "ら" to "ra",
        "り" to "ri",
        "る" to "ru",
        "れ" to "re",
        "ろ" to "ro",
        "わ" to "wa",
        "を" to "wo",
        "ん" to "n"
    )

    private val katakanaQuestions = miniQuestions.mapIndexed { index, item ->
        "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"[index].toString() to item.second
    }
    private val allMiniQuestions get() = miniQuestions + katakanaQuestions

    private fun styleThemeButton(button: Button, dark: Boolean) {
        val foreground = if (dark) Color.rgb(250, 250, 250) else Color.rgb(23, 23, 23)
        val fill = if (dark) Color.rgb(38, 38, 38) else Color.rgb(245, 245, 245)
        button.backgroundTintList = null
        button.background = GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(9).toFloat()
        }
        button.setTextColor(foreground)
    }

    private fun applyMiniTheme(dark: Boolean) {
        miniDarkTheme = dark
        val background = if (dark) Color.rgb(10, 10, 10) else Color.rgb(250, 250, 250)
        val toolbarColor = if (dark) Color.rgb(23, 23, 23) else Color.rgb(255, 255, 255)
        window.statusBarColor = background
        window.navigationBarColor = toolbarColor
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        if (::appRoot.isInitialized) appRoot.setBackgroundColor(background)
        if (::bottomToolbar.isInitialized) {
            bottomToolbar.setBackgroundColor(toolbarColor)
            for (i in 0 until bottomToolbar.childCount) {
                (bottomToolbar.getChildAt(i) as? Button)?.let { styleThemeButton(it, dark) }
            }
        }
        if (!::dailyBanner.isInitialized) return
        dailyBanner.setBackgroundColor(
            if (dark) Color.rgb(23, 23, 23) else Color.rgb(255, 255, 255)
        )
        val fg = if (dark) Color.rgb(250, 250, 250) else Color.rgb(23, 23, 23)
        dailyBanner.findViewWithTag<TextView>("mini_title")?.setTextColor(fg)
        dailyBanner.findViewWithTag<TextView>("mini_question")?.setTextColor(fg)
        dailyBanner.findViewWithTag<TextView>("mini_counter")?.setTextColor(
            if (dark) Color.rgb(205, 205, 205) else Color.rgb(80, 80, 80)
        )
        dailyBanner.findViewWithTag<Button>("mini_close")?.let { styleThemeButton(it, dark) }
        dailyBanner.findViewWithTag<LinearLayout>("mini_answers")?.let { row ->
            for (i in 0 until row.childCount) {
                (row.getChildAt(i) as? Button)?.let { styleThemeButton(it, dark) }
            }
        }
    }

    private fun updateDailyBannerVisibility(url: String?) {
        dailyBanner.visibility =
            if (miniExpanded && !bannerDismissedThisSession &&
                url?.endsWith("/kanban.html") == true
            ) View.VISIBLE else View.GONE
    }


    private fun readMiniBackup(): JSONObject {
        val prefs = getSharedPreferences("japanese_daily", MODE_PRIVATE)
        return JSONObject()
            .put("question_count", prefs.getInt("question_count", 0))
            .put("correct_count", prefs.getInt("correct_count", 0))
            .put("current_question", prefs.getInt("current_question", 0))
            .put("next_question", prefs.getInt("next_question", 0))
            .put("katakana_unlocked", prefs.getBoolean("katakana_unlocked", false))
            .put("review_queue", prefs.getString("review_queue", "") ?: "")
    }

    private fun restoreMiniBackup(value: JSONObject) {
        val count = value.getInt("question_count")
        val correct = value.getInt("correct_count")
        val current = value.getInt("current_question")
        val next = value.getInt("next_question")
        val unlocked = value.getBoolean("katakana_unlocked")
        val queueRaw = value.getString("review_queue")
        require(count in 0..1000000 && correct in 0..count) { "Некорректные счётчики японского" }
        require(current in allMiniQuestions.indices && next in allMiniQuestions.indices) {
            "Некорректная позиция в японском"
        }
        require(queueRaw.length <= 1024) { "Слишком длинная очередь повторения" }
        val queue = if (queueRaw.isEmpty()) emptyList() else
            queueRaw.split(",").map { it.toIntOrNull() ?: -1 }
        require(queue.size <= 150 && queue.all { it in allMiniQuestions.indices }) {
            "Некорректная очередь повторения"
        }
        val saved = getSharedPreferences("japanese_daily", MODE_PRIVATE).edit()
            .putInt("question_count", count)
            .putInt("correct_count", correct)
            .putInt("current_question", current)
            .putInt("next_question", next)
            .putBoolean("katakana_unlocked", unlocked)
            .putString("review_queue", queueRaw)
            .commit()
        check(saved) { "Не удалось сохранить прогресс японского" }
        miniQuestionNumber = count
        miniCorrectCount = correct
        dailyQuestionIndex = current
        miniNextNewIndex = next
        miniUnlockedKatakana = unlocked
        miniReviewQueue.clear()
        queue.forEach { miniReviewQueue.addLast(it) }
        miniIsReview = false
        renderMiniQuestion()
    }

    private fun saveMiniState() {
        getSharedPreferences("japanese_daily", MODE_PRIVATE).edit()
            .putInt("question_count", miniQuestionNumber)
            .putInt("correct_count", miniCorrectCount)
            .putInt("current_question", dailyQuestionIndex)
            .putInt("next_question", miniNextNewIndex)
            .putBoolean("katakana_unlocked", miniUnlockedKatakana)
            .putString("review_queue", miniReviewQueue.joinToString(","))
            .apply()
    }

    private fun nextMiniQuestion(wasCorrect: Boolean) {
        if (!wasCorrect && miniReviewQueue.size < 150) miniReviewQueue.addLast(dailyQuestionIndex)
        if (wasCorrect) miniCorrectCount++
        miniQuestionNumber++
        miniIsReview = miniQuestionNumber % 6 == 0 && miniReviewQueue.isNotEmpty() &&
            miniReviewQueue.first() != dailyQuestionIndex
        if (miniIsReview) {
            dailyQuestionIndex = miniReviewQueue.removeFirst()
        } else {
            dailyQuestionIndex = miniNextNewIndex
            miniNextNewIndex = (miniNextNewIndex + 1) % allMiniQuestions.size
            if (miniNextNewIndex >= miniQuestions.size) miniUnlockedKatakana = true
        }
        saveMiniState()
        renderMiniQuestion()
    }

    private fun renderMiniQuestion() {
        if (!::dailyBanner.isInitialized) return
        val task = allMiniQuestions[dailyQuestionIndex]
        val question = dailyBanner.findViewWithTag<TextView>("mini_question")
        val answerRow = dailyBanner.findViewWithTag<LinearLayout>("mini_answers")
        val counter = dailyBanner.findViewWithTag<TextView>("mini_counter")
        val scriptName = if (dailyQuestionIndex < miniQuestions.size) "ひらがな" else "カタカナ"
        counter.text = "$scriptName · ✓$miniCorrectCount/$miniQuestionNumber · ↻${miniReviewQueue.size}"
        question.text = "Как читается ${task.first}?"
        answerRow.removeAllViews()
        val alternatives = allMiniQuestions.map { it.second }.distinct()
            .filter { it != task.second }
        val wrong = alternatives[(dailyQuestionIndex * 7 + miniQuestionNumber) % alternatives.size]
        val options = if (miniQuestionNumber % 2 == 0)
            listOf(task.second, wrong) else listOf(wrong, task.second)
        for (choice in options) {
            answerRow.addView(Button(this).apply {
                text = choice
                isAllCaps = false
                textSize = 13f
                setOnClickListener {
                    val correct = choice == task.second
                    if (!correct) {
                        android.widget.Toast.makeText(
                            this@MainActivity,
                            "${task.first} читается ${task.second}",
                            android.widget.Toast.LENGTH_SHORT
                        ).show()
                    }
                    nextMiniQuestion(correct)
                }
            }, LinearLayout.LayoutParams(dp(65), dp(44)))
        }
        applyMiniTheme(miniDarkTheme)
    }

    private fun createDailyBanner(): LinearLayout {
        val prefs = getSharedPreferences("japanese_daily", MODE_PRIVATE)
        dailyQuestionIndex = prefs.getInt("current_question", prefs.getInt("next_question", 0))
            .coerceIn(0, allMiniQuestions.lastIndex)
        // Older versions stored the next question as the current question.
        // On first launch, advance the cursor so the first character isn't repeated.
        miniNextNewIndex = if (!prefs.contains("current_question")) {
            (dailyQuestionIndex + 1) % allMiniQuestions.size
        } else {
            prefs.getInt("next_question", (dailyQuestionIndex + 1) % allMiniQuestions.size)
                .coerceIn(0, allMiniQuestions.lastIndex)
        }
        miniUnlockedKatakana = prefs.getBoolean("katakana_unlocked", false) ||
            dailyQuestionIndex >= miniQuestions.size
        miniQuestionNumber = prefs.getInt("question_count", 0).coerceAtLeast(0)
        miniCorrectCount = prefs.getInt("correct_count", 0).coerceIn(0, miniQuestionNumber)
        miniReviewQueue.clear()
        prefs.getString("review_queue", "")?.split(",")?.forEach { raw ->
            val index = raw.toIntOrNull()
            if (index != null && index in allMiniQuestions.indices &&
                miniReviewQueue.size < 150) {
                miniReviewQueue.addLast(index)
            }
        }
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
            text = "🇯🇵 Японский"
            tag = "mini_title"
            textSize = 13f
            setTextColor(Color.rgb(34, 77, 74))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(TextView(this).apply {
            tag = "mini_counter"
            textSize = 11f
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setTextColor(Color.rgb(80, 112, 109))
        }, LinearLayout.LayoutParams(0, -2, 1.4f))
        header.addView(Button(this).apply {
            text = "✕"
            tag = "mini_close"
            contentDescription = "Скрыть тренировку до следующего запуска"
            textSize = 12f
            isAllCaps = false
            minWidth = 0
            minimumWidth = 0
            setPadding(0, 0, 0, 0)
            setOnClickListener {
                bannerDismissedThisSession = true
                miniExpanded = false
                panel.visibility = View.GONE
            }
        }, LinearLayout.LayoutParams(dp(40), dp(38)))
        panel.addView(header)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(TextView(this).apply {
            tag = "mini_question"
            textSize = 17f
            setTextColor(Color.rgb(25, 51, 49))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(LinearLayout(this).apply {
            tag = "mini_answers"
            orientation = LinearLayout.HORIZONTAL
        })
        panel.addView(row)
        // Set field before renderMiniQuestion(), which locates the banner by tag.
        dailyBanner = panel
        renderMiniQuestion()
        return panel
    }

    override fun onStop() {
        // Finish active recording when the application leaves the foreground.
        if (::voiceRecorder.isInitialized) voiceRecorder.stopInBackground()
        super.onStop()
    }

    override fun onDestroy() {
        if (::backupSaver.isInitialized) backupSaver.close()
        if (::attachmentOpener.isInitialized) attachmentOpener.close()
        pendingVoicePermission = null
        if (::voiceRecorder.isInitialized) voiceRecorder.close()
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        webView.destroy()
        japaneseSpeech?.stop()
        japaneseSpeech?.shutdown()
        japaneseSpeech = null
        super.onDestroy()
    }
}
