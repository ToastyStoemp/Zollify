package com.phuongninjin.zollify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.gson.Gson
import com.mypos.smartsdk.Currency
import com.mypos.smartsdk.MyPOSAPI
import com.mypos.smartsdk.MyPOSPayment
import com.mypos.smartsdk.MyPOSUtil
import com.mypos.smartsdk.OnPOSInfoListener
import com.mypos.smartsdk.TransactionProcessingResult
import com.mypos.smartsdk.data.POSInfo
import com.mypos.smartsdk.print.PrinterCommand
import com.mypos.smartsdk.print.PrinterStatus
import java.util.UUID

/**
 * On-device payment for Zollify running ON a myPOS Carbon/Ultra smart terminal
 * ("carbon" flavor only), via the official myPOS Smart SDK.
 *
 * MyPOSAPI.openPaymentActivity hands the amount to the terminal's PCI-certified
 * payment core; the result comes back through MainActivity.onActivityResult,
 * routed here by PaymentSdks.handleActivityResult (same pattern as SumUp in the
 * full flavor). Card data never touches this app.
 */
@CapacitorPlugin(name = "CarbonPayment")
class CarbonPaymentPlugin : Plugin() {

    companion object {
        private const val PAYMENT_REQUEST_CODE = 4801

        private var pendingCall: PluginCall? = null

        // registerPOSInfo appears to be a persistent listener registration rather
        // than a one-shot request, so it's registered once (lazily) and the most
        // recent value cached - repeat callers just read the cache.
        private var posInfo: POSInfo? = null
        private var posInfoRegistered = false

        /** Routed from MainActivity.onActivityResult via the flavor's PaymentSdks. */
        fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
            if (requestCode != PAYMENT_REQUEST_CODE) return false
            val call = pendingCall ?: return true
            pendingCall = null

            if (resultCode != android.app.Activity.RESULT_OK || data == null) {
                call.resolve(JSObject().apply {
                    put("approved", false)
                    put("error", "Payment cancelled")
                })
                return true
            }

            val status = data.getIntExtra("status", TransactionProcessingResult.TRANSACTION_FAILED)
            if (status == TransactionProcessingResult.TRANSACTION_SUCCESS) {
                call.resolve(JSObject().apply {
                    put("approved",      true)
                    // STAN uniquely identifies the transaction on the terminal;
                    // fall back to the auth code if absent.
                    put("transactionId", data.getStringExtra("STAN")
                        ?: data.getStringExtra("authorization_code") ?: "")
                    put("cardBrand",     data.getStringExtra("card_brand") ?: "")
                    put("authCode",      data.getStringExtra("authorization_code") ?: "")
                })
            } else {
                call.resolve(JSObject().apply {
                    put("approved", false)
                    put("error", data.getStringExtra("status_text") ?: "Declined (status $status)")
                })
            }
            return true
        }
    }

    /**
     * The terminal's own settlement currency (set on myPOS's side, not by this
     * app) - MyPOSAPI.openPaymentActivity silently refuses a mismatched
     * currency (the activity finishes instantly with RESULT_CANCELED, no card
     * screen ever shown), which surfaced as a confusing generic "Payment
     * cancelled". Checking this first lets startPayment() give a real reason.
     */
    @PluginMethod
    fun getPosInfo(call: PluginCall) {
        posInfo?.let { call.resolve(posInfoResult(it)); return }
        if (!posInfoRegistered) {
            posInfoRegistered = true
            MyPOSAPI.registerPOSInfo(activity.applicationContext, object : OnPOSInfoListener {
                override fun onReceive(info: POSInfo) {
                    posInfo = info
                }
            })
        }
        val handler = Handler(Looper.getMainLooper())
        var attempts = 0
        lateinit var check: Runnable
        check = Runnable {
            val info = posInfo
            when {
                info != null -> call.resolve(posInfoResult(info))
                attempts++ < 20 -> handler.postDelayed(check, 250) // ~5s total
                else -> call.reject("Terminal did not report POS info")
            }
        }
        handler.post(check)
    }

    private fun posInfoResult(info: POSInfo) = JSObject().apply {
        put("tid", info.getTID())
        put("currencyName", info.getCurrencyName())
        put("currencyCode", info.getCurrencyCode())
    }

    @PluginMethod
    fun startPayment(call: PluginCall) {
        val amount   = call.getDouble("amount")   ?: run { call.reject("amount required"); return }
        val currency = call.getString("currency") ?: "EUR"
        if (pendingCall != null) { call.reject("Payment already in progress"); return }

        // Refuse unknown currencies rather than silently charging in EUR.
        val posCurrency = try {
            Currency.valueOf(currency.uppercase())
        } catch (_: IllegalArgumentException) {
            call.reject("Currency $currency is not supported by the terminal")
            return
        }

        val payment = MyPOSPayment.builder()
            .productAmount(amount)
            .currency(posCurrency)
            .foreignTransactionId(UUID.randomUUID().toString())
            // Zollify records its own sales; the built-in printer stays quiet
            .printMerchantReceipt(MyPOSUtil.RECEIPT_OFF)
            .printCustomerReceipt(MyPOSUtil.RECEIPT_OFF)
            .build()

        pendingCall = call
        try {
            MyPOSAPI.openPaymentActivity(activity, payment, PAYMENT_REQUEST_CODE)
        } catch (e: Exception) {
            pendingCall = null
            call.reject("Payment app not available: ${e.message}")
        }
    }

    // ── Receipt printing ──────────────────────────────────────────────────────
    // Lines come from the web app pre-formatted for the 32-char thermal printer:
    //   { kind: 'text',  text, align?: 'left'|'center'|'right', doubleHeight?: bool }
    //   { kind: 'image', imageB64 }   (PNG, printer is 384px wide)
    //   { kind: 'space' }
    // They map to Smart-SDK PrinterCommands, serialized with Gson and broadcast
    // to the myPOS print service; PRINTING_DONE reports the printer status.

    private var printCall: PluginCall? = null
    private var printReceiver: BroadcastReceiver? = null
    private val printTimeout = Handler(Looper.getMainLooper())

    @PluginMethod
    fun printReceipt(call: PluginCall) {
        if (printCall != null) { call.reject("A print is already in progress"); return }
        val lines = call.getArray("lines") ?: run { call.reject("lines required"); return }

        val commands = ArrayList<PrinterCommand>()
        for (i in 0 until lines.length()) {
            val line = lines.getJSONObject(i)
            when (line.optString("kind")) {
                "image" -> {
                    val b64 = line.optString("imageB64")
                    if (b64.isNotEmpty()) {
                        val bytes = Base64.decode(b64, Base64.DEFAULT)
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (bmp != null) commands.add(PrinterCommand(PrinterCommand.CommandType.IMAGE, bmp))
                    }
                }
                "space" -> commands.add(PrinterCommand(PrinterCommand.CommandType.TEXT, "\n"))
                else -> {
                    var text = line.optString("text", "")
                    if (!text.endsWith("\n")) text += "\n"
                    var cmd = PrinterCommand(PrinterCommand.CommandType.TEXT, text)
                        .setAlignment(
                            when (line.optString("align")) {
                                "center" -> PrinterCommand.Alignment.ALIGN_CENTER
                                "right"  -> PrinterCommand.Alignment.ALIGN_RIGHT
                                else     -> PrinterCommand.Alignment.ALIGN_LEFT
                            },
                        )
                    if (line.optBoolean("doubleHeight")) cmd = cmd.setDoubleHeight(true)
                    commands.add(cmd)
                }
            }
        }
        if (commands.isEmpty()) { call.reject("Nothing to print"); return }

        printCall = call
        registerPrintReceiver()
        // Give slow thermal prints time, but never leave the call hanging.
        printTimeout.postDelayed({ finishPrint(false, -1, "Printer did not respond") }, 30_000)

        val intent = Intent(MyPOSUtil.PRINT_BROADCAST)
        intent.putExtra("commands", Gson().toJson(commands))
        MyPOSAPI.sendExplicitBroadcast(activity, intent)
    }

    private fun registerPrintReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra("printer_status", PrinterStatus.PRINTER_STATUS_UNKNOWN_ERROR)
                finishPrint(status == PrinterStatus.PRINTER_STATUS_SUCCESS, status, printerStatusText(status))
            }
        }
        printReceiver = receiver
        ContextCompat.registerReceiver(
            activity, receiver,
            IntentFilter(MyPOSUtil.PRINTING_DONE_BROADCAST), ContextCompat.RECEIVER_EXPORTED,
        )
    }

    private fun finishPrint(printed: Boolean, status: Int, detail: String) {
        printTimeout.removeCallbacksAndMessages(null)
        printReceiver?.let { try { activity.unregisterReceiver(it) } catch (_: Exception) {} }
        printReceiver = null
        val call = printCall ?: return
        printCall = null
        call.resolve(JSObject().apply {
            put("printed", printed)
            put("status", status)
            if (!printed) put("error", detail)
        })
    }

    private fun printerStatusText(status: Int): String = when (status) {
        PrinterStatus.PRINTER_STATUS_SUCCESS          -> "OK"
        PrinterStatus.PRINTER_STATUS_PRINTER_BUSY     -> "Printer busy"
        PrinterStatus.PRINTER_STATUS_OUT_OF_PAPER     -> "Out of paper"
        PrinterStatus.PRINTER_STATUS_PRINTER_OVERHEATING -> "Printer overheating"
        else -> "Print failed (status $status)"
    }

    /** Connected = the myPOS payment core is present (i.e. we run on a myPOS device). */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val onMyPosDevice = try {
            activity.packageManager.getPackageInfo("com.mypos", 0)
            true
        } catch (_: Exception) {
            false
        }
        call.resolve(JSObject().apply {
            put("connected", onMyPosDevice)
            if (!onMyPosDevice) put("detail", "myPOS payment app not found")
        })
    }
}
