package com.phuongninjin.zollify

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.mypos.slavesdk.ConnectionListener
import com.mypos.slavesdk.ConnectionType
import com.mypos.slavesdk.Currency
import com.mypos.slavesdk.Language
import com.mypos.slavesdk.POSHandler
import com.mypos.slavesdk.POSInfoListener
import com.mypos.slavesdk.POSReadyListener
import com.mypos.slavesdk.TransactionData
import java.util.UUID

@CapacitorPlugin(
    name = "MyPos",
    permissions = [
        // Android 12+: scanning/connecting to the terminal.
        Permission(
            alias = "bluetooth",
            strings = [
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
            ],
        ),
        // Location: BLE discovery needs it on API <= 30, and the myPOS SDK's own
        // permission gate requires COARSE on every Android version.
        Permission(
            alias = "location",
            strings = [
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ],
        ),
    ],
)
class MyPosPlugin : Plugin(), POSInfoListener, ConnectionListener, POSReadyListener {

    private lateinit var pos: POSHandler
    private var pendingCall: PluginCall? = null
    private var callResolved  = false
    private var termConnected = false   // physical BT link up
    private var termReady     = false   // SDK handshake complete, safe to transact

    // ── BroadcastReceivers ────────────────────────────────────────────────────

    // Auto-accepts the BLE pairing PIN from the GO2 without showing a system dialog.
    // Without this, the system dialog appears and auto-dismisses in ~5 s → GO2 sees "connection error".
    private val pairingReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothDevice.ACTION_PAIRING_REQUEST) return
            val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
            val pin    = intent.getIntExtra("android.bluetooth.device.extra.PAIRING_KEY", 123456)
            device.setPin(pin.toString().toByteArray())
            device.createBond()
            abortBroadcast()
        }
    }

    private val disconnectReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothDevice.ACTION_ACL_DISCONNECTED) return
            termConnected = false
            termReady     = false
            // A disconnect mid-payment must not leave the pending call latched —
            // that would block every later startPayment with "already in progress".
            failPending("Terminal disconnected")
            notifyListeners("terminalStatus", JSObject().apply { put("connected", false) })
        }
    }

    /** Resolve and clear the pending payment call as a failure, if one is latched. */
    private fun failPending(message: String) {
        if (callResolved) { pendingCall = null; return }
        val call = pendingCall ?: return
        pendingCall = null; callResolved = true
        call.resolve(JSObject().apply {
            put("approved", false)
            put("error",    message)
        })
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun load() {
        POSHandler.setConnectionType(ConnectionType.BLUETOOTH)
        POSHandler.setCurrency(Currency.EUR)
        POSHandler.setApplicationContext(activity.applicationContext)
        POSHandler.setLanguage(Language.ENGLISH)
        POSHandler.setDefaultReceiptConfig(POSHandler.RECEIPT_DO_NOT_PRINT)

        pos = POSHandler.getInstance()
        pos.setPOSInfoListener(this)
        pos.setConnectionListener(this)
        pos.setPOSReadyListener(this)
        // SDK safety-clearing (stuck transaction dropped) — release our latch too.
        pos.setTransactionClearedListener { status -> failPending("Transaction cleared (status $status)") }

        // Register BLE pairing receiver with highest priority so we handle it before the system dialog.
        // ContextCompat picks the RECEIVER_* export flag Android 14+ (API 34) requires.
        val pairingFilter = IntentFilter(BluetoothDevice.ACTION_PAIRING_REQUEST)
        pairingFilter.priority = IntentFilter.SYSTEM_HIGH_PRIORITY
        ContextCompat.registerReceiver(activity, pairingReceiver, pairingFilter, ContextCompat.RECEIVER_EXPORTED)

        ContextCompat.registerReceiver(
            activity, disconnectReceiver,
            IntentFilter(BluetoothDevice.ACTION_ACL_DISCONNECTED), ContextCompat.RECEIVER_EXPORTED,
        )

        // No auto-connect here: load() runs on every app start in every flavor,
        // but whether the GO2 is actually the selected payment provider lives in
        // the web app's settings. The JS side calls connectTerminal() when (and
        // only when) the MyPOS GO2 provider is active.
    }

    override fun handleOnDestroy() {
        try { activity.unregisterReceiver(pairingReceiver)    } catch (_: Exception) {}
        try { activity.unregisterReceiver(disconnectReceiver) } catch (_: Exception) {}
    }

    // ── Plugin methods ────────────────────────────────────────────────────────

    /**
     * Permissions the SDK's internal checkPermissions gate requires before it
     * will show the terminal picker (verified against the decompiled SDK):
     * coarse location on EVERY version, plus SCAN/CONNECT on Android 12+.
     */
    private fun requiredBtPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            )
        } else {
            listOf(Manifest.permission.ACCESS_COARSE_LOCATION)
        }

    private fun hasBtPermissions(): Boolean =
        requiredBtPermissions().all {
            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
        }

    /**
     * connectDevice shows the terminal-picker dialog and starts a BLE scan.
     * Must run on the UI thread: plugin methods (and permission callbacks) run
     * on Capacitor's worker thread, but the SDK's BluetoothDevicesDialog builds
     * its views there while its own handlers post to main → the dialog would
     * crash with CalledFromWrongThreadException. Also contain a missing-
     * permission SecurityException so the terminal just reports "not connected".
     */
    private fun connectSafely() {
        activity.runOnUiThread {
            try {
                pos.connectDevice(activity)
            } catch (e: SecurityException) {
                notifyListeners("terminalStatus", JSObject().apply { put("connected", false) })
            } catch (_: Exception) {
            }
        }
    }

    /** Re-enter connectable state (e.g. after the user taps Connect in the setup screen). */
    @PluginMethod
    fun connectTerminal(call: PluginCall) {
        if (hasBtPermissions()) {
            connectSafely()
            call.resolve(JSObject().apply { put("granted", true) })
        } else {
            val aliases =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) arrayOf("bluetooth", "location")
                else arrayOf("location")
            requestPermissionForAliases(aliases, call, "btPermissionCallback")
        }
    }

    @PermissionCallback
    private fun btPermissionCallback(call: PluginCall) {
        val granted = hasBtPermissions()
        if (granted) connectSafely()
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    /** Current status polled by the setup screen. */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("connected", termReady) // only true once fully handshaked
        call.resolve(ret)
    }

    /**
     * Start a card payment on the GO2.
     * Params:   { amount: number, currency: string }
     * Resolves: { approved: bool, transactionId?, cardBrand?, authCode?, error? }
     */
    @PluginMethod
    fun startPayment(call: PluginCall) {
        if (!termReady) { call.reject("Terminal not ready"); return }
        if (pendingCall != null) { call.reject("Payment already in progress"); return }

        val amount   = call.getDouble("amount")   ?: run { call.reject("amount required"); return }
        val currency = call.getString("currency") ?: "CHF"

        val posCurrency = when (currency.uppercase()) {
            "CHF" -> Currency.CHF; "EUR" -> Currency.EUR; "GBP" -> Currency.GBP
            "USD" -> Currency.USD; "SEK" -> Currency.SEK; "NOK" -> Currency.NOK
            "DKK" -> Currency.DKK; else  -> Currency.EUR
        }

        POSHandler.setCurrency(posCurrency)
        pendingCall  = call
        callResolved = false

        pos.purchase(
            String.format("%.2f", amount),
            UUID.randomUUID().toString(),
            POSHandler.RECEIPT_DO_NOT_PRINT
        )
    }

    /**
     * Cancel the in-flight payment (user aborted in the app) and clear the
     * pending latch so the plugin can never stay stuck in "already in progress".
     * Safe to call with no payment running — it then just resets state.
     */
    @PluginMethod
    fun cancelPayment(call: PluginCall) {
        try { pos.cancelTransaction() } catch (_: Exception) {}
        failPending("Cancelled")
        call.resolve()
    }

    // ── ConnectionListener ────────────────────────────────────────────────────

    override fun onConnected(device: BluetoothDevice?) {
        termConnected = true
        // termReady is set by POSReadyListener — don't notify yet
    }

    // ── POSReadyListener ──────────────────────────────────────────────────────

    override fun onPOSReady() {
        termReady = true
        notifyListeners("terminalStatus", JSObject().apply { put("connected", true) })
    }

    // ── POSInfoListener ───────────────────────────────────────────────────────

    override fun onTransactionComplete(transactionData: TransactionData?) {
        if (callResolved) return
        val call = pendingCall ?: return
        pendingCall = null; callResolved = true
        call.resolve(JSObject().apply {
            put("approved",      true)
            put("transactionId", transactionData?.stan     ?: "")
            put("cardBrand",     transactionData?.aidName  ?: "")
            put("authCode",      transactionData?.authCode ?: "")
        })
    }

    // Progress notifications during a purchase — keep waiting, a final callback follows.
    // Every other status while a purchase is pending is terminal: resolve as failure,
    // otherwise the pending latch sticks and every later payment is rejected with
    // "Payment already in progress". (All SDK POS_STATUS_* constants are >= 0, so the
    // old `status >= 0` early-return swallowed cancels/declines entirely.)
    private val progressStatuses = setOf(
        POSHandler.POS_STATUS_SUCCESS,                              // generic OK signal; success arrives via onTransactionComplete
        POSHandler.POS_STATUS_PENDING_USER_INTERACTION,
        POSHandler.POS_STATUS_PROCESSING,
        POSHandler.POS_STATUS_INVALID_PIN,                          // terminal lets the customer retry
        POSHandler.POS_STATUS_PIN_CHECK_ONLINE,
        POSHandler.POS_STATUS_DOWNLOADING_CERTIFICATES_IN_PROGRESS,
        POSHandler.POS_STATUS_DOWNLOADING_CERTIFICATES_COMPLETED,
        POSHandler.POS_STATUS_PRESENT_CARD_SCREEN,
        POSHandler.POS_STATUS_SELECT_DCC_SCREEN,
        POSHandler.POS_STATUS_ENTER_PIN_SCREEN,
        POSHandler.POS_STATUS_DCC_BEEN_SELECTED,
    )

    override fun onPOSInfoReceived(command: Int, status: Int, description: String?, extra: Bundle?) {
        if (callResolved || pendingCall == null) return
        if (status in progressStatuses) return
        if (status == POSHandler.POS_STATUS_SUCCESS_PURCHASE) return  // final data arrives via onTransactionComplete

        val message = when (status) {
            POSHandler.POS_STATUS_USER_CANCEL -> "Cancelled on terminal"
            else -> description ?: "Payment failed (status $status)"
        }
        failPending(message)
    }
}
