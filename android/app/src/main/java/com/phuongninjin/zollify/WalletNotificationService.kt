package com.phuongninjin.zollify

import android.app.Notification
import android.content.Context
import android.content.SharedPreferences
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reads Google Wallet's notifications, and nothing else: other apps' notifications are ignored
 * without being read. A Wallet notification's title and text are held in this app's own
 * private storage until the web app takes them (WalletPaymentsPlugin.takePending), reads the
 * payment out, and sends only that on. Held for at most a day and at most 100 at a time. This
 * service sends nothing anywhere itself.
 */
class WalletNotificationService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != WALLET_PACKAGE) return
        val extras = sbn.notification.extras
        val text = listOf(
            extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_TEXT),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT),
        ).joinToString(" ") { it?.toString().orEmpty() }.trim()
        if (text.isEmpty()) return
        WalletStore.add(this, sbn.key, sbn.postTime, text)
    }

    companion object {
        /** Google Wallet's Android package. */
        const val WALLET_PACKAGE = "com.google.android.apps.walletnfcrel"
    }
}

/** The notices held until taken: one small JSON list in this app's private preferences. */
object WalletStore {
    private const val PREFS = "wallet_notices"
    private const val KEY = "items"
    private const val MAX = 100
    private const val MAX_AGE_MS = 24L * 60 * 60 * 1000

    @Synchronized
    fun add(context: Context, key: String, at: Long, text: String) {
        val prefs = prefs(context)
        val now = System.currentTimeMillis()
        val list = load(prefs).filter { now - it.getLong("at") < MAX_AGE_MS }.toMutableList()
        if (list.any { it.getString("key") == key && it.getLong("at") == at }) return
        list.add(JSONObject().put("key", key).put("at", at).put("text", text))
        prefs.edit().putString(KEY, JSONArray(list.takeLast(MAX)).toString()).apply()
    }

    /** Everything held that is still within a day; what is taken is gone from the phone. */
    @Synchronized
    fun take(context: Context): List<JSONObject> {
        val prefs = prefs(context)
        val now = System.currentTimeMillis()
        val items = load(prefs).filter { now - it.getLong("at") < MAX_AGE_MS }
        prefs.edit().remove(KEY).apply()
        return items
    }

    private fun prefs(context: Context): SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun load(prefs: SharedPreferences): List<JSONObject> {
        val raw = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getJSONObject(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
