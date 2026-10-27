package com.phuongninjin.zollify

import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The web app's side of WalletNotificationService: whether Zollify may read Google Wallet's
 * notifications, a way to grant that, and the notices held so far, taken once (modules/tax
 * wallet.ts reads the payments out of them).
 */
@CapacitorPlugin(name = "WalletPayments")
class WalletPaymentsPlugin : Plugin() {

    @PluginMethod
    fun status(call: PluginCall) {
        val listening = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
        call.resolve(JSObject().apply { put("listening", listening) })
    }

    @PluginMethod
    fun openAccess(call: PluginCall) {
        activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        call.resolve()
    }

    @PluginMethod
    fun takePending(call: PluginCall) {
        val items = JSArray()
        for (o in WalletStore.take(context)) {
            items.put(JSObject().apply {
                put("key", o.getString("key"))
                put("at", o.getLong("at"))
                put("text", o.getString("text"))
            })
        }
        call.resolve(JSObject().apply { put("items", items) })
    }
}
