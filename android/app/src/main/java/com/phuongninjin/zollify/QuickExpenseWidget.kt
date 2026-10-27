package com.phuongninjin.zollify

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/**
 * Home-screen widget: one tap opens Add an expense, the same screen as the launcher shortcut -
 * the zollify://expense link, routed by web shortcuts.ts.
 */
class QuickExpenseWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.widget_quick_expense)
            val open = Intent(Intent.ACTION_VIEW, Uri.parse("zollify://expense"), context, MainActivity::class.java)
            val pending = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, pending)
            manager.updateAppWidget(id, views)
        }
    }
}
