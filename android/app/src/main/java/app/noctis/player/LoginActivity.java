package app.noctis.player;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Google sign-in for YouTube Music, the same way InnerTune-style clients do it: load the
 * YouTube ServiceLogin page, wait until it redirects to music.youtube.com, then return the
 * cookies for that origin. The web layer signs InnerTune requests with SAPISIDHASH.
 */
public class LoginActivity extends AppCompatActivity {

    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_VISITOR_DATA = "visitorData";

    private static final String LOGIN_URL =
        "https://accounts.google.com/ServiceLogin?ytbTemplate=1&service=youtube&continue=https%3A%2F%2Fmusic.youtube.com";
    private static final String MUSIC_ORIGIN = "https://music.youtube.com";

    private WebView webView;
    private boolean finished = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(8);
        bar.setPadding(pad, pad, pad, pad);

        ImageButton close = new ImageButton(this);
        close.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setContentDescription("Close");
        close.setOnClickListener(v -> cancel());
        bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));

        TextView title = new TextView(this);
        title.setText("Sign in to YouTube Music");
        title.setTextSize(18);
        title.setTextColor(Color.rgb(28, 27, 31));
        title.setPadding(dp(8), 0, 0, 0);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Google refuses sign-in from user agents that advertise an embedded WebView.
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith(MUSIC_ORIGIN)) {
                    tryFinish(view);
                }
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    cancel();
                }
            }
        });

        webView.loadUrl(LOGIN_URL);
    }

    private void tryFinish(WebView view) {
        if (finished) return;

        String cookie = CookieManager.getInstance().getCookie(MUSIC_ORIGIN);
        if (cookie == null || !cookie.contains("SAPISID")) return;

        finished = true;
        CookieManager.getInstance().flush();

        // visitorData keeps recommendations consistent with what the signed-in web client sees.
        view.evaluateJavascript(
            "(function(){try{return window.yt&&yt.config_?yt.config_.VISITOR_DATA||'':''}catch(e){return ''}})()",
            value -> {
                String visitorData = value == null ? "" : value.replace("\"", "");
                Intent result = new Intent();
                result.putExtra(EXTRA_COOKIE, cookie);
                result.putExtra(EXTRA_VISITOR_DATA, visitorData);
                setResult(RESULT_OK, result);
                finish();
            }
        );
    }

    private void cancel() {
        setResult(RESULT_CANCELED);
        finish();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
