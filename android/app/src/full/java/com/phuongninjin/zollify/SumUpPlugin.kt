package com.phuongninjin.zollify

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.sumup.merchant.reader.api.SumUpAPI
import com.sumup.merchant.reader.api.SumUpLogin
import com.sumup.merchant.reader.api.SumUpPayment
import java.math.BigDecimal
import java.util.Locale
import java.util.UUID

/**
 * SumUp card reader via the official merchant SDK. The SDK opens its own
 * activities (login screen, checkout flow) with the request codes below and
 * reports back through MainActivity.onActivityResult, which forwards here.
 */
@CapacitorPlugin(name = "SumUp")
class SumUpPlugin : Plugin() {

    companion object {
        const val REQUEST_LOGIN = 51001
        const val REQUEST_CHECKOUT = 51002
        const val REQUEST_CARD_READER = 51003

        private var instance: SumUpPlugin? = null

        /** Called from MainActivity.onActivityResult; true when the result was ours. */
        fun handleActivityResult(requestCode: Int, data: Intent?): Boolean {
            val plugin = instance ?: return false
            return when (requestCode) {
                REQUEST_LOGIN -> { plugin.finishLogin(data); true }
                REQUEST_CHECKOUT -> { plugin.finishCheckout(data); true }
                REQUEST_CARD_READER -> { plugin.finishCardReader(); true }
                else -> false
            }
        }
    }

    private var loginCall: PluginCall? = null
    private var checkoutCall: PluginCall? = null
    private var cardReaderCall: PluginCall? = null

    override fun load() {
        instance = this
    }

    /**
     * SumUpAPI.isLoggedIn() throws an NPE (ReaderModuleCoreState null) on some
     * devices/SDK builds when the reader module hasn't been initialized yet -
     * it initializes when the login activity first runs. An unchecked throw
     * from a plugin method crashes Capacitor's worker thread, so the Settings
     * status poll must never let it escape: treat "can't tell" as not logged in.
     */
    private fun safeIsLoggedIn(): Boolean =
        try {
            SumUpAPI.isLoggedIn()
        } catch (_: Throwable) {
            false
        }

    @PluginMethod
    fun isLoggedIn(call: PluginCall) {
        call.resolve(JSObject().apply { put("loggedIn", safeIsLoggedIn()) })
    }

    @PluginMethod
    fun login(call: PluginCall) {
        val affiliateKey = call.getString("affiliateKey")
            ?: run { call.reject("affiliateKey required"); return }
        if (safeIsLoggedIn()) {
            call.resolve(JSObject().apply { put("loggedIn", true) })
            return
        }
        loginCall = call
        call.setKeepAlive(true)
        activity.runOnUiThread {
            SumUpAPI.openLoginActivity(activity, SumUpLogin.builder(affiliateKey).build(), REQUEST_LOGIN)
        }
    }

    @PluginMethod
    fun logout(call: PluginCall) {
        try { SumUpAPI.logout() } catch (_: Throwable) {}
        call.resolve()
    }

    /**
     * Opens SumUp's own card-reader settings page, where the user can pair/connect
     * a reader (Solo, Air, …) over Bluetooth without having to start a checkout.
     * Requires a logged-in session.
     */
    @PluginMethod
    fun openCardReaderPage(call: PluginCall) {
        if (!safeIsLoggedIn()) {
            call.reject("Log in to SumUp first")
            return
        }
        cardReaderCall = call
        call.setKeepAlive(true)
        activity.runOnUiThread {
            SumUpAPI.openCardReaderPage(activity, REQUEST_CARD_READER)
        }
    }

    @PluginMethod
    fun checkout(call: PluginCall) {
        val amount = call.getDouble("amount") ?: run { call.reject("amount required"); return }
        val currency = call.getString("currency") ?: run { call.reject("currency required"); return }
        if (!safeIsLoggedIn()) {
            call.reject("Not logged in to SumUp")
            return
        }
        val payment = try {
            SumUpPayment.builder()
                .total(BigDecimal(String.format(Locale.US, "%.2f", amount)))
                .currency(SumUpPayment.Currency.valueOf(currency.uppercase(Locale.US)))
                .title(call.getString("title") ?: "Sale")
                .foreignTransactionId(call.getString("foreignTxId") ?: UUID.randomUUID().toString())
                .skipSuccessScreen()
                .build()
        } catch (e: IllegalArgumentException) {
            call.reject("Currency $currency is not supported by SumUp")
            return
        }
        checkoutCall = call
        call.setKeepAlive(true)
        activity.runOnUiThread {
            SumUpAPI.checkout(activity, payment, REQUEST_CHECKOUT)
        }
    }

    private fun finishLogin(data: Intent?) {
        val call = loginCall ?: return
        loginCall = null
        val code = data?.extras?.getInt(SumUpAPI.Response.RESULT_CODE) ?: -1
        val message = data?.extras?.getString(SumUpAPI.Response.MESSAGE)
        call.setKeepAlive(false)
        call.resolve(JSObject().apply {
            put("loggedIn", code == 1 || SumUpAPI.isLoggedIn())
            put("message", message ?: "")
        })
    }

    private fun finishCardReader() {
        val call = cardReaderCall ?: return
        cardReaderCall = null
        call.setKeepAlive(false)
        call.resolve()
    }

    private fun finishCheckout(data: Intent?) {
        val call = checkoutCall ?: return
        checkoutCall = null
        val extras = data?.extras
        val code = extras?.getInt(SumUpAPI.Response.RESULT_CODE) ?: -1
        call.setKeepAlive(false)
        call.resolve(JSObject().apply {
            put("approved", code == 1)
            put("resultCode", code)
            put("txCode", extras?.getString(SumUpAPI.Response.TX_CODE) ?: "")
            put("message", extras?.getString(SumUpAPI.Response.MESSAGE) ?: "")
        })
    }
}
