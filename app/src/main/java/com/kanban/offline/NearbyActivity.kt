package com.kanban.offline

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.text.TextWatcher
import android.text.Editable
import androidx.core.view.WindowInsetsControllerCompat
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.nio.charset.StandardCharsets
import java.util.UUID

/**
 * Experimental nearby peer chat. No encryption, authentication, delivery receipts,
 * multi-hop routing or background service yet. Do not send sensitive information.
 * Advertising/scanning only starts after the user taps Start.
 */
class NearbyActivity : ComponentActivity() {
    companion object {
        val SERVICE: UUID = UUID.fromString("b7352bb0-64fa-4b8a-a32e-7cc9bd79e220")
        val MESSAGE: UUID = UUID.fromString("b7352bb1-64fa-4b8a-a32e-7cc9bd79e220")
    }

    private lateinit var log: TextView
    private lateinit var status: TextView
    private lateinit var emptyPeers: TextView
    private var darkTheme = false
    private var startButton: Button? = null
    private var stopButton: Button? = null
    private var sendButton: Button? = null
    private lateinit var peers: LinearLayout
    private lateinit var message: EditText
    private lateinit var manager: BluetoothManager
    private var adapter: BluetoothAdapter? = null
    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var server: BluetoothGattServer? = null
    private var client: BluetoothGatt? = null
    private var selected: BluetoothDevice? = null
    private val seen = mutableSetOf<String>()
    private var running = false
    private var pendingStart = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (pendingStart && result.values.all { it } && hasPermissions()) startNearby()
        else if (pendingStart) append("Bluetooth permissions denied")
        pendingStart = false
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun shape(fill: Int, radius: Int = 12, stroke: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(radius).toFloat()
            if (stroke != null) setStroke(dp(1), stroke)
        }

    private fun panel(dark: Boolean): Int = if (dark) Color.rgb(23, 23, 23) else Color.WHITE
    private fun foreground(dark: Boolean): Int = if (dark) Color.rgb(250, 250, 250) else Color.rgb(23, 23, 23)
    private fun muted(dark: Boolean): Int = if (dark) Color.rgb(163, 163, 163) else Color.rgb(107, 107, 107)
    private fun border(dark: Boolean): Int = if (dark) Color.rgb(50, 50, 50) else Color.rgb(231, 231, 231)
    private fun styleButton(button: Button, primary: Boolean = false) {
        button.isAllCaps = false
        button.textSize = 13f
        button.backgroundTintList = null
        button.background = shape(
            if (primary) foreground(darkTheme) else panel(darkTheme),
            12, if (primary) null else border(darkTheme)
        )
        button.setTextColor(if (primary) (if (darkTheme) Color.BLACK else Color.WHITE) else foreground(darkTheme))
        button.minHeight = dp(48)
        button.minimumHeight = dp(48)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        manager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        adapter = manager.adapter
        val prefs = getSharedPreferences("kanban_nearby", MODE_PRIVATE)
        // The WebView theme is stored separately; MainActivity passes the active theme.
        darkTheme = intent.getBooleanExtra("dark_theme", prefs.getBoolean("dark_theme", false))
        prefs.edit().putBoolean("dark_theme", darkTheme).apply()
        val bg = if (darkTheme) Color.rgb(10, 10, 10) else Color.rgb(250, 250, 250)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        if (Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !darkTheme
            isAppearanceLightNavigationBars = !darkTheme
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bg)
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        heading.addView(Button(this).apply {
            text = "‹"
            contentDescription = "Back to Kanban"
            styleButton(this)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        heading.addView(TextView(this).apply {
            text = "Bluetooth chat"
            textSize = 20f
            setTypeface(null, Typeface.BOLD)
            setTextColor(foreground(darkTheme))
            setPadding(dp(12), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(heading)

        root.addView(TextView(this).apply {
            text = "Experimental · Unencrypted · Works only while open"
            textSize = 12f
            setTextColor(muted(darkTheme))
            setPadding(0, dp(8), 0, dp(14))
        })
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        startButton = Button(this).apply {
            text = "Start discovery"
            styleButton(this, true)
            setOnClickListener { requestStart() }
        }
        actions.addView(requireNotNull(startButton), LinearLayout.LayoutParams(0, dp(48), 1f))
        stopButton = Button(this).apply {
            text = "Stop"
            styleButton(this)
            setOnClickListener { stopNearby() }
        }
        actions.addView(requireNotNull(stopButton), LinearLayout.LayoutParams(0, dp(48), 0.55f).apply {
            marginStart = dp(8)
        })
        root.addView(actions)
        status = TextView(this).apply {
            text = "● Nearby is off"
            textSize = 13f
            setTextColor(muted(darkTheme))
            setPadding(0, dp(14), 0, dp(12))
        }
        root.addView(status)
        root.addView(TextView(this).apply {
            text = "Nearby devices"
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setTextColor(foreground(darkTheme))
        })
        val scroll = ScrollView(this).apply { isFillViewport = true }
        peers = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, 0)
        }
        emptyPeers = TextView(this).apply {
            text = "No devices found yet. Start discovery to search."
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(muted(darkTheme))
            setPadding(dp(12), dp(28), dp(12), dp(28))
            background = shape(panel(darkTheme), 14, border(darkTheme))
        }
        peers.addView(emptyPeers)
        scroll.addView(peers)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        root.addView(TextView(this).apply {
            text = "Message"
            textSize = 13f
            setTextColor(muted(darkTheme))
            setPadding(0, dp(12), 0, dp(6))
        })
        message = EditText(this).apply {
            hint = "Write a short message (max 100 bytes)"
            setHintTextColor(muted(darkTheme))
            setTextColor(foreground(darkTheme))
            textSize = 14f
            minLines = 2
            maxLines = 3
            setPadding(dp(12), dp(10), dp(12), dp(10))
            backgroundTintList = null
            background = shape(panel(darkTheme), 12, border(darkTheme))
        }
        root.addView(message, LinearLayout.LayoutParams(-1, -2))
        sendButton = Button(this).apply {
            text = "Send message"
            styleButton(this, true)
            setOnClickListener { sendMessage() }
        }
        root.addView(requireNotNull(sendButton), LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(10) })
        log = TextView(this).apply {
            text = "Activity log"
            textSize = 12f
            setTextColor(muted(darkTheme))
            setPadding(0, dp(10), 0, 0)
            maxLines = 3
        }
        root.addView(log)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.statusBars() or
                    WindowInsetsCompat.Type.navigationBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(bars.left + dp(16), bars.top + dp(12),
                bars.right + dp(16), bars.bottom + dp(12))
            insets
        }
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
    }

    private fun append(s: String) = runOnUiThread {
        log.text = (log.text.toString() + "\n" + s).takeLast(3500)
    }

    private fun permissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_ADVERTISE
        ) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun hasPermissions() = permissions().all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestStart() {
        if (adapter == null) { append("Bluetooth unavailable"); return }
        if (!hasPermissions()) {
            pendingStart = true
            permissionLauncher.launch(permissions())
            return
        }
        if (adapter?.isEnabled != true) { append("Enable Bluetooth in Android settings first"); return }
        startNearby()
    }

    @SuppressLint("MissingPermission")
    private fun startNearby() {
        if (!hasPermissions() || running) return
        val a = adapter ?: return
        if (!a.isEnabled) { append("Enable Bluetooth first"); return }
        scanner = a.bluetoothLeScanner
        advertiser = a.bluetoothLeAdvertiser
        if (scanner == null || advertiser == null) {
            append("This phone needs BLE scanning and advertising support")
            return
        }
        running = true
        seen.clear()
        peers.removeAllViews()
        peers.addView(emptyPeers)
        status.text = "● Searching for nearby devices"
        val characteristic = BluetoothGattCharacteristic(
            MESSAGE,
            BluetoothGattCharacteristic.PROPERTY_WRITE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(characteristic)
        server = manager.openGattServer(this, serverCallback)
        if (server == null) {
            append("Could not open GATT server")
            running = false
            return
        }
        server?.addService(service)
        append("Starting nearby discovery")
        // GATT service registration and advertiser startup are sequenced in onServiceAdded.
        // Scanning can begin immediately.
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
        scanner?.startScan(
            listOf(filter),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            scanCallback
        )
    }

    @SuppressLint("MissingPermission")
    private fun startAdvertising() {
        if (!running) return
        advertiser?.startAdvertising(
            AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .build(),
            AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).setIncludeDeviceName(false).build(),
            advertiseCallback
        )
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) = append("Visible to nearby phones")
        override fun onStartFailure(errorCode: Int) = append("Advertising failed: $errorCode")
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService?) {
            if (status == BluetoothGatt.GATT_SUCCESS) runOnUiThread { startAdvertising() }
            else append("GATT service setup failed: $status")
        }
        @SuppressLint("MissingPermission")
        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean,
            responseNeeded: Boolean, offset: Int, value: ByteArray
        ) {
            val valid = characteristic.uuid == MESSAGE && !preparedWrite &&
                offset == 0 && value.size in 1..100
            if (valid) {
                val text = String(value, StandardCharsets.UTF_8)
                append("From ${device.address}: $text")
            }
            if (responseNeeded) server?.sendResponse(
                device, requestId,
                if (valid) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE,
                0, null
            )
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            if (!seen.add(device.address)) return
            runOnUiThread {
                if (emptyPeers.parent === peers) peers.removeView(emptyPeers)
                peers.addView(Button(this@NearbyActivity).apply {
                    styleButton(this)
                    text = "Peer ${device.address}"
                    setOnClickListener {
                        selected = device
                        status.text = "● Selected ${device.address}"
                        append("Selected ${device.address}")
                    }
                })
            }
        }
        override fun onScanFailed(errorCode: Int) = append("Scan failed: $errorCode")
    }

    @SuppressLint("MissingPermission")
    private fun sendMessage() {
        if (!running || !hasPermissions()) { append("Start nearby first"); return }
        val peer = selected ?: run { append("Select a peer"); return }
        val bytes = message.text.toString().toByteArray(StandardCharsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > 100) { append("Message must be 1–100 UTF-8 bytes"); return }
        client?.close()
        client = null
        pendingBytes = bytes
        client = peer.connectGatt(this, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
        append("Connecting to ${peer.address}...")
    }

    private var pendingBytes: ByteArray? = null
    private val clientCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.discoverServices()
            } else {
                if (status != BluetoothGatt.GATT_SUCCESS) append("Connection failed: $status")
                gatt.close()
            }
        }
        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val ch = gatt.getService(SERVICE)?.getCharacteristic(MESSAGE)
            val bytes = pendingBytes
            if (status != BluetoothGatt.GATT_SUCCESS || ch == null || bytes == null) {
                append("Peer does not expose chat service")
                gatt.disconnect()
                return
            }
            val result = if (Build.VERSION.SDK_INT >= 33)
                gatt.writeCharacteristic(ch, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
            else {
                @Suppress("DEPRECATION")
                ch.value = bytes
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(ch).let { if (it) BluetoothStatusCodes.SUCCESS else -1 }
            }
            if (result != BluetoothStatusCodes.SUCCESS) {
                append("Write could not start: $result")
                gatt.disconnect()
            }
        }
        @SuppressLint("MissingPermission")
        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            append(if (status == BluetoothGatt.GATT_SUCCESS) "Message delivered to peer radio" else "Send failed: $status")
            pendingBytes = null
            gatt.disconnect()
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopNearby() {
        running = false
        if (hasPermissions()) {
            try { scanner?.stopScan(scanCallback) } catch (_: Exception) {}
            try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Exception) {}
            try { client?.disconnect() } catch (_: Exception) {}
        }
        client?.close()
        client = null
        server?.close()
        server = null
        selected = null
        pendingBytes = null
        status.text = "● Nearby is off"
        append("Nearby stopped")
    }

    override fun onDestroy() {
        stopNearby()
        super.onDestroy()
    }
}
