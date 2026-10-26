package app.noctis.player;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
 * Two kinds of sign-in in a WebView:
 *
 * - Google sign-in for YouTube Music (no extras), the way InnerTune-style clients do it:
 *   load the YouTube ServiceLogin page, wait until it redirects to music.youtube.com,
 *   then return the cookies for that origin.
 * - OAuth for plugins (EXTRA_URL + EXTRA_REDIRECT): load the authorization page and
 *   return the first URL that starts with the redirect URI, without loading it. Any
 *   redirect URI works, since it never has to resolve.
 * - A site's own sign-in for plugins (EXTRA_URL + EXTRA_COOKIE_URL + EXTRA_COOKIE_NAME):
 *   load the page and return the value of a cookie as soon as the site sets it (e.g.
 *   SoundCloud's oauth_token). Sites that sign in inside a single-page app never
 *   navigate anywhere a redirect could catch, so the cookie jar is checked every second.
 */
public class LoginActivity extends AppCompatActivity {

    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_VISITOR_DATA = "visitorData";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REDIRECT = "redirect";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_COOKIE_URL = "cookieUrl";
    public static final String EXTRA_COOKIE_NAME = "cookieName";
    /** Cookie mode's result: every cookie on cookieUrl, httpOnly ones too (a refresh token…). */
    public static final String EXTRA_COOKIES = "cookies";

    private static final String LOGIN_URL =
        "https://accounts.google.com/ServiceLogin?ytbTemplate=1&service=youtube&continue=https%3A%2F%2Fmusic.youtube.com";
    private static final String MUSIC_ORIGIN = "https://music.youtube.com";

    private WebView webView;
    private boolean finished = false;
    /** OAuth mode when set. */
    private String redirect;
    /** Cookie mode when set: wait for this cookie on cookieUrl. */
    private String cookieUrl;
    private String cookieName;
    private final Handler poll = new Handler(Looper.getMainLooper());
    private final Runnable checkCookie = new Runnable() {
        @Override
        public void run() {
            if (finished) return;
            String value = cookieValue();
            if (value != null) {
                finishWithCookie(value);
                return;
            }
            poll.postDelayed(this, 1000);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        redirect = getIntent().getStringExtra(EXTRA_REDIRECT);
        cookieUrl = getIntent().getStringExtra(EXTRA_COOKIE_URL);
        cookieName = getIntent().getStringExtra(EXTRA_COOKIE_NAME);
        boolean cookieMode = cookieUrl != null && cookieName != null;
        String startUrl = redirect != null || cookieMode ? getIntent().getStringExtra(EXTRA_URL) : LOGIN_URL;
        String heading = getIntent().getStringExtra(EXTRA_TITLE);

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
        title.setText(heading != null ? heading : "Sign in to YouTube Music");
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
        // Google (and "Continue with Google" on other sites) refuses user agents that
        // advertise an embedded WebView.
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return catchRedirect(request.getUrl().toString());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (catchRedirect(url)) {
                    view.stopLoading();
                    return;
                }
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (redirect == null && cookieName == null && url != null && url.startsWith(MUSIC_ORIGIN)) {
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

        if (startUrl == null) {
            cancel();
            return;
        }
        webView.loadUrl(startUrl);
        if (cookieMode) poll.postDelayed(checkCookie, 1000);
    }

    /** Cookie mode: the cookie's value, if the site has set it (a cookie left from before counts too). */
    private String cookieValue() {
        String all = CookieManager.getInstance().getCookie(cookieUrl);
        if (all == null) return null;
        for (String part : all.split(";")) {
            String[] pair = part.trim().split("=", 2);
            if (pair.length == 2 && pair[0].equals(cookieName) && !pair[1].isEmpty()) return pair[1];
        }
        return null;
    }

    private void finishWithCookie(String value) {
        if (finished) return;
        finished = true;
        CookieManager.getInstance().flush();
        Intent result = new Intent();
        result.putExtra(EXTRA_COOKIE, value);
        result.putExtra(EXTRA_COOKIES, CookieManager.getInstance().getCookie(cookieUrl));
        setResult(RESULT_OK, result);
        finish();
    }

    /** OAuth mode: hand the redirect back instead of loading it. */
    private boolean catchRedirect(String url) {
        if (redirect == null || url == null || !url.startsWith(redirect)) return false;
        if (!finished) {
            finished = true;
            Intent result = new Intent();
            result.putExtra(EXTRA_URL, url);
            setResult(RESULT_OK, result);
            finish();
        }
        return true;
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
        poll.removeCallbacks(checkCookie);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
