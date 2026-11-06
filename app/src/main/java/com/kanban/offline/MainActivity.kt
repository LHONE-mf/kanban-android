package com.kanban.offline

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val files = if (result.resultCode == RESULT_OK) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        pendingFiles?.onReceiveValue(files)
        pendingFiles = null
    }

    private val bluetoothPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        // BLE discovery will only be started after the user explicitly enables nearby chat.
        // A permission grant alone must not start advertising or scanning.
        val granted = results.values.all { it }
        android.util.Log.i("KanbanBLE", "Bluetooth permissions granted: $granted")
    }

    private fun requestNearbyPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val required = arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_ADVERTISE
            )
            val missing = required.filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }
            if (missing.isNotEmpty()) bluetoothPermissions.launch(missing.toTypedArray())
        } else {
            val permission = Manifest.permission.ACCESS_FINE_LOCATION
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                bluetoothPermissions.launch(arrayOf(permission))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
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
                    } catch (e: Exception) {
                        pendingFiles?.onReceiveValue(null)
                        pendingFiles = null
                        false
                    }
                }
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            }
        }
        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/kanban.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        // Bluetooth capabilities are checked without triggering scans or requesting
        // permissions on startup. Nearby chat will be opt-in in a later release.
        val manager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter: BluetoothAdapter? = manager.adapter
        android.util.Log.i("KanbanBLE", "BLE adapter available: ${adapter != null}")
    }

    override fun onDestroy() {
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        webView.destroy()
        super.onDestroy()
    }
}
