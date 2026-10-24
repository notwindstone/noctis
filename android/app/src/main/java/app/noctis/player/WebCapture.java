package app.noctis.player;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONObject;

/**
 * Loads a page in a hidden WebView and reports the body of the first network response
 * whose URL contains `match`, then throws the WebView away.
 *
 * Plugins use it to let a site's own code do its session handshake (e.g. the Spotify
 * web player fetching its access token) instead of re-implementing it. The WebView
 * shares the app's cookie store, so a session signed in with openAuth carries over.
 */
class WebCapture {

    interface Callback {
        void onResult(String url, String body);

        void onError(String message);
    }

    private static final String DESKTOP_UA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView webView;
    private boolean done = false;

    WebCapture(Activity activity) {
        this.activity = activity;
    }

    /** Wraps fetch and XHR before the page's own scripts run. */
    private static String hookScript(String match) {
        String quoted = JSONObject.quote(match);
        return "(function(){"
            + "var m=" + quoted + ";"
            + "function rep(u,t){try{NoctisCapture.report(String(u),String(t))}catch(e){}}"
            + "var f=window.fetch;"
            + "if(f){window.fetch=function(i,o){var p=f.apply(this,arguments);"
            + "try{var u=typeof i==='string'?i:(i&&i.url)||'';"
            + "if(u.indexOf(m)!==-1){p.then(function(r){r.clone().text().then(function(t){if(r.ok)rep(u,t)})}).catch(function(){})}}catch(e){}"
            + "return p}}"
            + "var O=XMLHttpRequest.prototype.open,S=XMLHttpRequest.prototype.send;"
            + "XMLHttpRequest.prototype.open=function(a,u){this.__nu=u;return O.apply(this,arguments)};"
            + "XMLHttpRequest.prototype.send=function(){var x=this;"
            + "if(String(x.__nu||'').indexOf(m)!==-1){x.addEventListener('load',function(){if(x.status>=200&&x.status<300)rep(x.__nu,x.responseText)})}"
            + "return S.apply(this,arguments)};"
            + "})();";
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    void start(String url, String match, String userAgent, long timeoutMs, Callback callback) {
        activity.runOnUiThread(() -> {
            webView = new WebView(activity);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setUserAgentString(userAgent != null ? userAgent : DESKTOP_UA);

            webView.addJavascriptInterface(
                new Object() {
                    @JavascriptInterface
                    public void report(String responseUrl, String body) {
                        main.post(() -> finish(() -> callback.onResult(responseUrl, body)));
                    }
                },
                "NoctisCapture"
            );

            String script = hookScript(match);
            boolean early = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
            if (early) {
                WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton("*"));
            }
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                    super.onPageStarted(view, pageUrl, favicon);
                    // Older WebViews: hook as early as we can.
                    if (!early) view.evaluateJavascript(script, null);
                }
            });

            main.postDelayed(() -> finish(() -> callback.onError("Timed out")), timeoutMs);
            webView.loadUrl(url);
        });
    }

    private void finish(Runnable report) {
        if (done) return;
        done = true;
        report.run();
        if (webView != null) {
            webView.stopLoading();
            webView.removeJavascriptInterface("NoctisCapture");
            webView.destroy();
            webView = null;
        }
    }
}
