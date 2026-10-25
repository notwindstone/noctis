package app.noctis.player;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.os.Handler;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.webkit.CookieManager;
import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native glue the web layer cannot do on its own:
 *
 * - predictive back: forwards OnBackPressedCallback progress so the web UI can run a
 *   gesture-driven transition (Android 14+ delivers progress, older versions only the
 *   final "invoked" event);
 * - haptics: the platform's own tuned feedback constants instead of raw vibration;
 * - media session: lock screen / notification controls, backed by PlaybackService;
 * - system colours: the wallpaper-derived Material You accent (Android 12+);
 * - Google sign-in: a dedicated WebView whose cookies are handed back to the app;
 * - local music: folders the user picks (Storage Access Framework), scanned with their
 *   tags (see LocalMusic).
 */
@CapacitorPlugin(
    name = "Noctis",
    permissions = {
        // Local music: "Music and audio" on Android 13+, storage before that.
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    }
)
public class NoctisPlugin extends Plugin {

    private OnBackPressedCallback backCallback;

    @Override
    public void load() {
        backCallback = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackStarted(@NonNull BackEventCompat event) {
                notifyListeners("backStarted", backEvent(event));
            }

            @Override
            public void handleOnBackProgressed(@NonNull BackEventCompat event) {
                notifyListeners("backProgressed", backEvent(event));
            }

            @Override
            public void handleOnBackCancelled() {
                notifyListeners("backCancelled", new JSObject());
            }

            @Override
            public void handleOnBackPressed() {
                notifyListeners("backInvoked", new JSObject());
            }
        };

        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backCallback));
    }

    @Override
    protected void handleOnDestroy() {
        releaseMediaSession();
        super.handleOnDestroy();
    }

    private static JSObject backEvent(BackEventCompat event) {
        JSObject data = new JSObject();
        data.put("progress", event.getProgress());
        data.put("touchX", event.getTouchX());
        data.put("touchY", event.getTouchY());
        data.put("swipeEdge", event.getSwipeEdge() == BackEventCompat.EDGE_RIGHT ? "right" : "left");
        return data;
    }

    /** Enabled while the web layer has somewhere to go back to; otherwise the system handles back (to home). */
    @PluginMethod
    public void setBackEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (backCallback != null) backCallback.setEnabled(enabled);
            call.resolve();
        });
    }

    /* ------------------------------------------------------------------ *
     * Haptics
     * ------------------------------------------------------------------ */

    /**
     * Semantic haptics mapped to HapticFeedbackConstants, with fallbacks for older
     * releases. These respect the system "touch feedback" setting and feel like the rest
     * of the OS, unlike fixed-length vibrations.
     */
    @PluginMethod
    public void haptic(PluginCall call) {
        String type = call.getString("type", "tap");
        int constant = hapticConstant(type == null ? "tap" : type);
        View view = getBridge().getWebView();
        view.post(() -> view.performHapticFeedback(constant));
        call.resolve();
    }

    private static int hapticConstant(String type) {
        int sdk = Build.VERSION.SDK_INT;
        switch (type) {
            case "tick":
                return sdk >= 34 ? HapticFeedbackConstants.SEGMENT_TICK : HapticFeedbackConstants.CLOCK_TICK;
            case "toggleOn":
                return sdk >= 34 ? HapticFeedbackConstants.TOGGLE_ON : HapticFeedbackConstants.CONTEXT_CLICK;
            case "toggleOff":
                return sdk >= 34 ? HapticFeedbackConstants.TOGGLE_OFF : HapticFeedbackConstants.CLOCK_TICK;
            case "confirm":
                return sdk >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK;
            case "reject":
                return sdk >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            case "longPress":
                return HapticFeedbackConstants.LONG_PRESS;
            case "dragStart":
                return sdk >= 34 ? HapticFeedbackConstants.DRAG_START : HapticFeedbackConstants.LONG_PRESS;
            case "thresholdOn":
                return sdk >= 34 ? HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE : HapticFeedbackConstants.CONTEXT_CLICK;
            case "thresholdOff":
                return sdk >= 34 ? HapticFeedbackConstants.GESTURE_THRESHOLD_DEACTIVATE : HapticFeedbackConstants.CLOCK_TICK;
            case "gestureEnd":
                return sdk >= 30 ? HapticFeedbackConstants.GESTURE_END : HapticFeedbackConstants.CLOCK_TICK;
            case "press":
                return HapticFeedbackConstants.KEYBOARD_TAP;
            case "tap":
            default:
                return HapticFeedbackConstants.VIRTUAL_KEY;
        }
    }

    /* ------------------------------------------------------------------ *
     * Media session (lock screen and notification controls)
     * ------------------------------------------------------------------ */

    private MediaSessionCompat mediaSession;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService artworkLoader = Executors.newSingleThreadExecutor();
    private String artworkUrl;
    private Bitmap artwork;
    private JSObject lastState;

    private void emitMediaAction(String action, Double position) {
        JSObject data = new JSObject();
        data.put("action", action);
        if (position != null) data.put("position", position);
        notifyListeners("mediaAction", data);
    }

    private MediaSessionCompat session() {
        if (mediaSession != null) return mediaSession;
        mediaSession = new MediaSessionCompat(getContext(), "Noctis");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                emitMediaAction("play", null);
            }

            @Override
            public void onPause() {
                emitMediaAction("pause", null);
            }

            @Override
            public void onSkipToNext() {
                emitMediaAction("next", null);
            }

            @Override
            public void onSkipToPrevious() {
                emitMediaAction("previous", null);
            }

            @Override
            public void onStop() {
                emitMediaAction("stop", null);
            }

            @Override
            public void onSeekTo(long pos) {
                emitMediaAction("seek", pos / 1000.0);
            }
        });

        Intent launch = new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        mediaSession.setSessionActivity(
            PendingIntent.getActivity(getContext(), 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
        );
        PlaybackService.session = mediaSession;
        return mediaSession;
    }

    /**
     * Update what the lock screen and notification show:
     * { title, artist, album, artwork, duration, position, playing, hasPrevious, hasNext }
     * Times are in seconds.
     */
    @PluginMethod
    public void updateMediaSession(PluginCall call) {
        JSObject state = call.getData();
        main.post(() -> {
            lastState = state;
            String url = state.getString("artwork", null);
            if (url != null && !url.equals(artworkUrl)) {
                artworkUrl = url;
                artwork = null;
                loadArtwork(url);
            }
            applyMediaState(state);
            call.resolve();
        });
    }

    @PluginMethod
    public void clearMediaSession(PluginCall call) {
        main.post(() -> {
            releaseMediaSession();
            call.resolve();
        });
    }

    private void releaseMediaSession() {
        PlaybackService.hide(getContext());
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
            PlaybackService.session = null;
        }
        lastState = null;
        artworkUrl = null;
        artwork = null;
    }

    private void loadArtwork(String url) {
        artworkLoader.submit(() -> {
            Bitmap bitmap = null;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                try (InputStream input = connection.getInputStream()) {
                    bitmap = BitmapFactory.decodeStream(input);
                }
            } catch (Exception ignored) {
                // Artwork is optional; the notification works without it.
            }
            Bitmap loaded = bitmap;
            main.post(() -> {
                if (!url.equals(artworkUrl) || loaded == null) return;
                artwork = loaded;
                if (lastState != null) applyMediaState(lastState);
            });
        });
    }

    private void applyMediaState(JSObject state) {
        MediaSessionCompat session = session();
        boolean playing = state.getBool("playing") != null && state.getBool("playing");
        boolean hasNext = state.getBool("hasNext") == null || state.getBool("hasNext");
        boolean hasPrevious = state.getBool("hasPrevious") == null || state.getBool("hasPrevious");
        long duration = Math.round(state.optDouble("duration", 0) * 1000);
        long position = Math.round(state.optDouble("position", 0) * 1000);
        String title = state.getString("title", "");
        String artist = state.getString("artist", "");

        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.getString("album", ""));
        if (duration > 0) metadata.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration);
        if (artwork != null) metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        session.setMetadata(metadata.build());

        long actions = PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SEEK_TO |
            PlaybackStateCompat.ACTION_STOP;
        if (hasNext) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        if (hasPrevious) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;

        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(
                    playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    position,
                    playing ? 1f : 0f
                )
                .build()
        );
        session.setActive(true);

        PlaybackService.show(getContext(), buildNotification(session, title, artist, playing));
    }

    private PendingIntent serviceIntent(String action, int requestCode) {
        Intent intent = new Intent(getContext(), PlaybackService.class).setAction(action);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? PendingIntent.getForegroundService(getContext(), requestCode, intent, flags)
            : PendingIntent.getService(getContext(), requestCode, intent, flags);
    }

    private Notification buildNotification(MediaSessionCompat session, String title, String artist, boolean playing) {
        Context context = getContext();
        PlaybackService.ensureChannel(context);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, PlaybackService.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_noctis)
            .setContentTitle(title)
            .setContentText(artist)
            .setLargeIcon(artwork)
            .setContentIntent(session.getController().getSessionActivity())
            .setDeleteIntent(serviceIntent(PlaybackService.ACTION_STOP, 5))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setOngoing(playing)
            .addAction(R.drawable.ic_media_previous, "Previous", serviceIntent(PlaybackService.ACTION_PREVIOUS, 1))
            .addAction(
                playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                playing ? "Pause" : "Play",
                serviceIntent(playing ? PlaybackService.ACTION_PAUSE : PlaybackService.ACTION_PLAY, 2)
            )
            .addAction(R.drawable.ic_media_next, "Next", serviceIntent(PlaybackService.ACTION_NEXT, 3))
            .addAction(R.drawable.ic_media_close, "Stop", serviceIntent(PlaybackService.ACTION_STOP, 4))
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );

        return builder.build();
    }

    /* ------------------------------------------------------------------ *
     * System colours and sign-in
     * ------------------------------------------------------------------ */

    @PluginMethod
    public void getSystemColors(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            result.put("accent", hex(ContextCompat.getColor(getContext(), android.R.color.system_accent1_500)));
            result.put("secondary", hex(ContextCompat.getColor(getContext(), android.R.color.system_accent2_500)));
            result.put("tertiary", hex(ContextCompat.getColor(getContext(), android.R.color.system_accent3_500)));
        }
        call.resolve(result);
    }

    private static String hex(int color) {
        return String.format("#%06X", 0xFFFFFF & color);
    }

    /* ---------------- Local music ---------------- */

    private final ExecutorService musicScanner = Executors.newSingleThreadExecutor();

    private String musicAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    private JSObject musicPermissionState() {
        JSObject response = new JSObject();
        PermissionState state = getPermissionState(musicAlias());
        response.put("state", state == null ? "prompt" : state.toString());
        return response;
    }

    /** Whether the app may read the device's music: "granted", "denied", "prompt"… */
    @PluginMethod
    public void checkMusicPermission(PluginCall call) {
        call.resolve(musicPermissionState());
    }

    @PluginMethod
    public void requestMusicPermission(PluginCall call) {
        if (getPermissionState(musicAlias()) == PermissionState.GRANTED) {
            call.resolve(musicPermissionState());
            return;
        }
        requestPermissionForAlias(musicAlias(), call, "onMusicPermission");
    }

    @PermissionCallback
    private void onMusicPermission(PluginCall call) {
        call.resolve(musicPermissionState());
    }

    /** Every song in Android's media index. Emits "musicScanProgress" { count }. */
    @PluginMethod
    public void scanMediaStore(PluginCall call) {
        if (getPermissionState(musicAlias()) != PermissionState.GRANTED) {
            call.reject("Allow access to music first", "PERMISSION");
            return;
        }
        musicScanner.execute(() -> {
            try {
                JSArray files = LocalMusic.scanMediaStore(getContext(), (count) -> {
                    JSObject progress = new JSObject();
                    progress.put("uri", "mediastore");
                    progress.put("count", count);
                    notifyListeners("musicScanProgress", progress);
                });
                JSObject response = new JSObject();
                response.put("files", files);
                call.resolve(response);
            } catch (Exception e) {
                call.reject("Couldn't read the device's music: " + e.getMessage());
            }
        });
    }

    /** Let the user pick a music folder; the grant is persisted across restarts. */
    @PluginMethod
    public void pickMusicFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onMusicFolderPicked");
    }

    @ActivityCallback
    private void onMusicFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No folder was picked", "CANCELLED");
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Android didn't grant lasting access to that folder");
            return;
        }
        String id = DocumentsContract.getTreeDocumentId(tree);
        JSObject response = new JSObject();
        response.put("uri", tree.toString());
        // "primary:Music/Albums" → "Music/Albums"
        response.put("name", id.contains(":") ? id.substring(id.indexOf(':') + 1) : id);
        call.resolve(response);
    }

    /** Every audio file in a picked folder, with tags. Emits "musicScanProgress" { count }. */
    @PluginMethod
    public void scanMusicFolder(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri is required");
            return;
        }
        musicScanner.execute(() -> {
            try {
                JSArray files = LocalMusic.scan(getContext(), Uri.parse(uri), (count) -> {
                    JSObject progress = new JSObject();
                    progress.put("uri", uri);
                    progress.put("count", count);
                    notifyListeners("musicScanProgress", progress);
                });
                JSObject response = new JSObject();
                response.put("files", files);
                call.resolve(response);
            } catch (Exception e) {
                call.reject("Couldn't read that folder: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getLocalArtwork(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri is required");
            return;
        }
        musicScanner.execute(() -> {
            JSObject response = new JSObject();
            response.put("dataUrl", LocalMusic.artwork(getContext(), Uri.parse(uri)));
            call.resolve(response);
        });
    }

    /** Give up access to a folder the user removed. */
    @PluginMethod
    public void releaseMusicFolder(PluginCall call) {
        String uri = call.getString("uri");
        try {
            if (uri != null) getContext().getContentResolver().releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // already gone
        }
        call.resolve();
    }

    @PluginMethod
    public void openLogin(PluginCall call) {
        Intent intent = new Intent(getContext(), LoginActivity.class);
        startActivityForResult(call, intent, "onLoginResult");
    }

    @ActivityCallback
    private void onLoginResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            JSObject response = new JSObject();
            response.put("cookie", data.getStringExtra(LoginActivity.EXTRA_COOKIE));
            response.put("visitorData", data.getStringExtra(LoginActivity.EXTRA_VISITOR_DATA));
            call.resolve(response);
        } else {
            call.reject("Sign-in was cancelled", "CANCELLED");
        }
    }

    /** OAuth for plugins: opens `url`, resolves with the URL it redirected to (starting with `redirect`). */
    @PluginMethod
    public void openAuth(PluginCall call) {
        String url = call.getString("url");
        String redirect = call.getString("redirect");
        if (url == null || redirect == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("url and redirect are required");
            return;
        }
        Intent intent = new Intent(getContext(), LoginActivity.class);
        intent.putExtra(LoginActivity.EXTRA_URL, url);
        intent.putExtra(LoginActivity.EXTRA_REDIRECT, redirect);
        intent.putExtra(LoginActivity.EXTRA_TITLE, call.getString("title", "Sign in"));
        startActivityForResult(call, intent, "onAuthResult");
    }

    @ActivityCallback
    private void onAuthResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            JSObject response = new JSObject();
            response.put("url", data.getStringExtra(LoginActivity.EXTRA_URL));
            call.resolve(response);
        } else {
            call.reject("Sign-in was cancelled", "CANCELLED");
        }
    }

    /**
     * Load `url` in a hidden WebView and resolve with the first response whose URL
     * contains `match` ({ url, body }). See WebCapture.
     */
    @PluginMethod
    public void captureResponse(PluginCall call) {
        String url = call.getString("url");
        String match = call.getString("match");
        if (url == null || match == null || !url.startsWith("https://")) {
            call.reject("An https url and a match are required");
            return;
        }
        long timeout = call.getLong("timeoutMs", 30000L);
        new WebCapture(getActivity()).start(url, match, call.getString("userAgent"), timeout, new WebCapture.Callback() {
            @Override
            public void onResult(String responseUrl, String body) {
                JSObject result = new JSObject();
                result.put("url", responseUrl);
                result.put("body", body);
                call.resolve(result);
            }

            @Override
            public void onError(String message) {
                call.reject(message, "TIMEOUT");
            }
        });
    }

    /** Remove every cookie, or with `url`, only the cookies visible to that URL (one site's session). */
    @PluginMethod
    public void clearCookies(PluginCall call) {
        String url = call.getString("url");
        getActivity().runOnUiThread(() -> {
            CookieManager manager = CookieManager.getInstance();
            if (url == null) {
                manager.removeAllCookies(removed -> {
                    manager.flush();
                    call.resolve();
                });
                return;
            }
            String host = android.net.Uri.parse(url).getHost();
            String cookies = manager.getCookie(url);
            if (cookies != null && host != null) {
                // Cookies may be set on the host or any parent domain; expire the name on each.
                String[] parts = host.split("\\.");
                for (String cookie : cookies.split(";")) {
                    String name = cookie.split("=", 2)[0].trim();
                    if (name.isEmpty()) continue;
                    manager.setCookie(url, name + "=; Max-Age=0; Path=/");
                    for (int i = 0; i < parts.length - 1; i++) {
                        StringBuilder domain = new StringBuilder();
                        for (int j = i; j < parts.length; j++) domain.append('.').append(parts[j]);
                        manager.setCookie(url, name + "=; Max-Age=0; Path=/; Domain=" + domain);
                    }
                }
            }
            manager.flush();
            call.resolve();
        });
    }
}
