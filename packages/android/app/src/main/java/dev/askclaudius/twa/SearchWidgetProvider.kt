package dev.askclaudius.twa

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * Home-screen search widget for Claudius (Phase 9).
 *
 * An Android App Widget cannot host a live, editable text field: RemoteViews has
 * no EditText, so the "type here" search bar you see on the home screen is really
 * a button styled to look like one. Tapping it launches [SearchInputActivity], a
 * small transparent activity that DOES have a real EditText. That activity builds
 * the deep link and hands off to the TWA.
 *
 * The widget holds no auth and no API keys. It only ever produces a URL; the
 * signed-in session lives entirely in the TWA's shared Chrome profile.
 */
class SearchWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (appWidgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.widget_search)

            // Tapping the fake search bar opens the input activity, which collects
            // the query and deep-links into a NEW chat. Every tap starts fresh.
            val intent = Intent(context, SearchInputActivity::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pendingIntent = PendingIntent.getActivity(
                context,
                appWidgetId,
                intent,
                flags,
            )
            views.setOnClickPendingIntent(R.id.widget_search_bar, pendingIntent)

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
