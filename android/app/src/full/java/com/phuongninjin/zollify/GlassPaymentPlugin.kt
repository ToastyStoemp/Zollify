package com.phuongninjin.zollify

import android.app.Activity
import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.mypos.glasssdk.Currency
import com.mypos.glasssdk.MyPOSAPI
import com.mypos.glasssdk.MyPOSPayment
import com.mypos.glasssdk.TransactionProcessingResult
import java.util.UUID

/**
 * Tap-to-pay on the phone itself via the myPOS Glass softPOS app ("full"
 * flavor only). MyPOSAPI.openPaymentActivity hands the amount to the Glass
 * app (package com.mypos.top), the customer taps their card on the phone,
 * and the result returns through MainActivity.onActivityResult, routed here
 * by PaymentSdks.handleActivityResult — the same pattern as the Carbon.
 *
 * Requires the Glass app installed and activated on this device; going live
 * additionally needs the app approved by myPOS (integrations@mypos.com).
 */
@CapacitorPlugin(name = "GlassPayment")
class GlassPaymentPlugin : Plugin() {

    companion object {
        private const val PAYMENT_REQUEST_CODE = 4901
        private const val GLASS_PACKAGE = "com.mypos.top"

        private var pendingCall: PluginCall? = null

        /** Routed from MainActivity.onActivityResult via the full flavor's PaymentSdks. */
        fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
            if (requestCode != PAYMENT_REQUEST_CODE) return false
            val call = pendingCall ?: return true
            pendingCall = null

            if (resultCode != Activity.RESULT_OK || data == null) {
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

    @PluginMethod
    fun startPayment(call: PluginCall) {
        val amount   = call.getDouble("amount")   ?: run { call.reject("amount required"); return }
        val currency = call.getString("currency") ?: "EUR"
        if (pendingCall != null) { call.reject("Payment already in progress"); return }

        // Refuse unknown currencies rather than silently charging in EUR.
        val posCurrency = try {
            Currency.valueOf(currency.uppercase())
        } catch (_: IllegalArgumentException) {
            call.reject("Currency $currency is not supported by myPOS Glass")
            return
        }

        val payment = MyPOSPayment.builder()
            .productAmount(amount)
            .currency(posCurrency)
            .foreignTransactionId(UUID.randomUUID().toString())
            .build()

        pendingCall = call
        try {
            MyPOSAPI.openPaymentActivity(activity, payment, PAYMENT_REQUEST_CODE)
        } catch (e: Exception) {
            pendingCall = null
            call.reject("myPOS Glass app not available: ${e.message}")
        }
    }

    /** Connected = the Glass app is installed on this phone. */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val installed = try {
            activity.packageManager.getPackageInfo(GLASS_PACKAGE, 0)
            true
        } catch (_: Exception) {
            false
        }
        call.resolve(JSObject().apply {
            put("connected", installed)
            put("detail", if (installed) "Glass app installed" else "myPOS Glass app not installed")
        })
    }
}
