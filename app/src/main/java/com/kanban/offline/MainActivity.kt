package com.kanban.offline

import android.Manifest
import android.os.Build
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
    private var pendingMicRequest: PermissionRequest? = null
    private lateinit var backupSaver: KanbanBackupSaver
    private lateinit var attachmentOpener: KanbanAttachmentOpener
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

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val files = if (result.resultCode == RESULT_OK) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        pendingFiles?.onReceiveValue(files)
        pendingFiles = null
    }

    private val backupDocumentPicker = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        if (::backupSaver.isInitialized) backupSaver.onDestinationPicked(uri)
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
                        view.evaluateJavascript("""(function(){function sync(){var t=document.documentElement.dataset.theme||localStorage.getItem('kanban_theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(window.KanbanTheme)KanbanTheme.postMessage(t);if(location.pathname.endsWith('/japanese.html'))document.documentElement.dataset.theme=t;}sync();if(!window.__themeSync){window.__themeSync=new MutationObserver(sync);window.__themeSync.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});}})();""", null)
                    }
                }
            }
        }

        // The backup bridge is restricted to our bundled Kanban page, never arbitrary
        // web content. Transfer chunks are validated by KanbanBackupSaver.
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

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanReminders", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length <= 1024) runOnUiThread {
                    try {
                        KanbanReminders.update(this, raw)
                        if (Build.VERSION.SDK_INT >= 33 &&
                            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                            org.json.JSONObject(raw).optLong("at") > System.currentTimeMillis()) {
                            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9101)
                        }
                    } catch (_: Exception) { }
                }
            }
        }

        // Stream stored attachments into a read-only FileProvider URI and let
        // Android choose a native viewer. The source IndexedDB record is never changed.
        attachmentOpener = KanbanAttachmentOpener(this) { event ->
            webView.evaluateJavascript(
                "window.kanbanFileOpenNativeResult && window.kanbanFileOpenNativeResult(" +
                    JSONObject.quote(event.toString()) + ")", null
            )
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "KanbanFileOpen", setOf(appOrigin)) {
                _, message, sourceOrigin, isMainFrame, _ ->
                if (!isMainFrame || sourceOrigin.toString().removeSuffix("/") != appOrigin ||
                    webView.url?.endsWith("/kanban.html") != true) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                if (raw.length <= 48_000) {
                    runOnUiThread { attachmentOpener.handle(raw) }
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

        // Keep the WebView and learning controls clear of system bars.
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
        toolbar.addView(japaneseButton, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ))
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
            if (!bannerDismissedThisSession && url?.endsWith("/kanban.html") == true)
                View.VISIBLE else View.GONE
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
        // Keep the board usable: expand the mini lesson only when requested.
        row.visibility = View.GONE
        header.isClickable = true
        header.isFocusable = true
        header.contentDescription = "Развернуть тренировку японского"
        header.setOnClickListener {
            row.visibility = if (row.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            header.contentDescription = if (row.visibility == View.VISIBLE)
                "Свернуть тренировку японского" else "Развернуть тренировку японского"
        }
        // Set field before renderMiniQuestion(), which locates the banner by tag.
        dailyBanner = panel
        renderMiniQuestion()
        return panel
    }

    override fun onDestroy() {
        if (::backupSaver.isInitialized) backupSaver.close()
        if (::attachmentOpener.isInitialized) attachmentOpener.close()
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
