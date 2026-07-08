package dev.askclaudius.twa

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText

/**
 * A tiny, transparent activity launched by the home-screen widget. It is the real
 * text field the widget itself can't provide (see [SearchWidgetProvider]). The
 * user types a query, submits, and we deep-link into a new Claudius chat:
 *
 *   https://www.askclaudius.dev/chat?q=<url-encoded query>
 *
 * Because that host is verified via Digital Asset Links, Android routes the
 * ACTION_VIEW intent into the installed TWA rather than the browser. An empty
 * submit just opens /chat (a new conversation with no seeded message).
 *
 * No query is sent, cached, or logged here; the string only becomes a chat
 * message once the web app sends it through /api/chat, where tier enforcement and
 * userId scoping apply exactly as for a typed message.
 */
class SearchInputActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_search_input)

        val input = findViewById<EditText>(R.id.search_input)

        input.setOnEditorActionListener { _, actionId, event ->
            val isDone = actionId == EditorInfo.IME_ACTION_SEARCH ||
                actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_DONE ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER)
            if (isDone) {
                submit(input.text.toString())
                true
            } else {
                false
            }
        }

        // Tapping outside the small input dialog cancels (finishes) the activity.
        findViewById<View>(R.id.search_scrim).setOnClickListener { finish() }

        // Show the keyboard immediately so the user can just start typing.
        input.requestFocus()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    private fun submit(raw: String) {
        val query = raw.trim()
        val uri = if (query.isEmpty()) {
            Uri.parse("$BASE_URL/chat")
        } else {
            Uri.parse("$BASE_URL/chat").buildUpon()
                .appendQueryParameter("q", query)
                .build()
        }

        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            // Keep it inside our verified app rather than a browser disambiguation.
            setPackage(packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        // Dismiss the keyboard, then launch and finish so we never linger.
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(window.decorView.windowToken, 0)

        startActivity(intent)
        finish()
    }

    companion object {
        private const val BASE_URL = "https://www.askclaudius.dev"
    }
}
