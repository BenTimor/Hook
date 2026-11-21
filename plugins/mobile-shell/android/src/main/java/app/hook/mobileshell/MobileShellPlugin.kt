package app.hook.mobileshell

import android.app.Activity
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * The Android window around the WebView.
 *
 * A phone is edge to edge from targetSdk 35: the system no longer shrinks the
 * window for the keyboard, and left alone it pans the whole page up so the
 * focused input stays visible — the conversation title goes off screen with
 * it. Trimming the window by the IME inset instead keeps the header where it
 * is and gives the keyboard the bottom of the thread, which is the only part
 * that should move.
 *
 * Only the keyboard is handled. `viewport-fit=cover` and
 * `env(safe-area-inset-*)` in `mobile.css` already own the notch and the home
 * indicator, so the listener leaves the top and the system bars alone.
 */
@TauriPlugin
class MobileShellPlugin(private val activity: Activity) : Plugin(activity) {
  private var installed = false

  init {
    // Ask the system not to pan when an input is focused; the inset listener
    // makes the room instead. Changing it after the window exists is fine:
    // this runs before the composer is touched.
    activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    install()
  }

  override fun load(webView: WebView) {
    install()
  }

  private fun install() {
    if (installed) return
    installed = true
    val decor = activity.window.decorView
    ViewCompat.setOnApplyWindowInsetsListener(decor) { view, insets ->
      // When the keyboard is down this is zero: the shell keeps the full height
      // and the CSS safe-area padding is the only inset it needs.
      view.setPadding(
        0,
        0,
        0,
        insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
      )
      insets
    }
    // The listener is installed after the first layout can have run; ask for
    // the current insets once so an already-open keyboard is not missed.
    ViewCompat.requestApplyInsets(decor)
  }
}
