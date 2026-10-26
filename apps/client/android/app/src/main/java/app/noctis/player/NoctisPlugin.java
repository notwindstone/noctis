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
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import android.database.Cursor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
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
import java.io.ByteArrayOutputStream;
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
 * - wake locks: the CPU and Wi-Fi stay awake while music plays with the screen off;
 * - system colours: the wallpaper-derived Material You accent (Android 12+);
 * - Google sign-in: a dedicated WebView whose cookies are handed back to the app;
 * - local music: folders the user picks (Storage Access Framework), scanned with their
 *   tags (see LocalMusic);
 * - opened files: a .noctis plugin opened from a file manager, browser or chat app is
 *   handed to the web layer to install.
 */
@CapacitorPlugin(
    name = "Noctis",
    permissions = {
        // Local music: "Music and audio" on Android 13+, storage before that.
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        // Notifications are opt-in from Android 13.
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class NoctisPlugin extends Plugin {

    private OnBackPressedCallback backCallback;

    @Override
    public void load() {
        instance = this;
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

        // Launched by opening a file: handle it once (not again when the activity is recreated).
        Intent launch = getActivity().getIntent();
        if (isOpenFile(launch)) {
            readOpenedFile(launch.getData());
            getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && intent.hasExtra(EXTRA_NOTIFICATION)) {
            dispatchNotificationAction(intent.getStringExtra(EXTRA_NOTIFICATION), "click");
        }
        if (isOpenFile(intent)) readOpenedFile(intent.getData());
    }

    @Override
    protected void handleOnDestroy() {
        releaseAwake();
        releaseMediaSession();
        if (instance == this) instance = null;
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
                // Paused long enough, the phone may be asleep: stay awake while the web
                // layer fetches a fresh stream, or "play" on the lock screen does nothing.
                holdAwake(RESUME_AWAKE_MS);
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

    /* ------------------------------------------------------------------ *
     * Wake locks
     * ------------------------------------------------------------------ */

    /** How long a "play" from the lock screen keeps the phone awake before the web layer takes over. */
    private static final long RESUME_AWAKE_MS = 60_000;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private boolean awake = false;
    private final Runnable releaseIfIdle = () -> {
        if (!awake) releaseAwake();
    };

    /**
     * Held while music plays (the web layer says when). Without it, a phone with the
     * screen off can sleep between buffer refills: the stream stalls and the music stops.
     * The Wi-Fi lock keeps the radio from dropping to power save at the same moments.
     */
    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("awake", false));
        main.post(() -> {
            awake = enabled;
            if (enabled) holdAwake(0);
            else releaseAwake();
            call.resolve();
        });
    }

    /** Acquire both locks; with a timeout, they're let go then unless playback took them over. */
    private void holdAwake(long timeoutMs) {
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (power == null) return;
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Noctis:playback");
            wakeLock.setReferenceCounted(false);
        }
        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                @SuppressWarnings("deprecation")
                int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "Noctis:playback");
                wifiLock.setReferenceCounted(false);
            }
        }
        main.removeCallbacks(releaseIfIdle);
        if (timeoutMs > 0 && !awake) {
            wakeLock.acquire(timeoutMs);
            main.postDelayed(releaseIfIdle, timeoutMs);
        } else {
            // A lock acquired without a timeout replaces the pending timed release.
            wakeLock.acquire();
        }
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
    }

    private void releaseAwake() {
        main.removeCallbacks(releaseIfIdle);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
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

    /* ---------------- Opened files ---------------- */

    /** Plugin archives are a few MB at most; anything far bigger isn't one. */
    private static final int MAX_OPENED_BYTES = 32 * 1024 * 1024;
    private final ExecutorService fileReader = Executors.newSingleThreadExecutor();

    private static boolean isOpenFile(Intent intent) {
        return intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null;
    }

    /**
     * Read an opened file and emit "openFile" { name, data (base64) }, or { name, error }.
     * Retained until the web layer listens, since a cold start opens the file before the
     * app has loaded.
     */
    private void readOpenedFile(Uri uri) {
        fileReader.execute(() -> {
            JSObject event = new JSObject();
            String name = displayName(uri);
            event.put("name", name);
            try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IllegalStateException("The file couldn't be opened");
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    if (output.size() > MAX_OPENED_BYTES) throw new IllegalStateException("The file is too large to be a plugin");
                }
                event.put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            } catch (Exception e) {
                event.put("error", e.getMessage() != null ? e.getMessage() : "The file couldn't be read");
            }
            notifyListeners("openFile", event, true);
        });
    }

    /** The file's name as the sending app tells it ("youtube-music.noctis"), else the URI's last segment. */
    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
            } catch (Exception ignored) {
                // Some providers don't answer queries; fall back to the path.
            }
        }
        String last = uri.getLastPathSegment();
        if (last == null) return "";
        return last.contains("/") ? last.substring(last.lastIndexOf('/') + 1) : last;
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

    /**
     * A site's own sign-in page for plugins: opens `url` and resolves with the value of
     * the cookie `cookie` on `cookieUrl` once the site sets it, plus every cookie on
     * `cookieUrl` as a Cookie header ({ value, cookies }): sites keep refresh tokens there.
     */
    @PluginMethod
    public void openCookieLogin(PluginCall call) {
        String url = call.getString("url");
        String cookieUrl = call.getString("cookieUrl");
        String cookie = call.getString("cookie");
        if (url == null || cookieUrl == null || cookie == null || !url.startsWith("https://") || !cookieUrl.startsWith("https://")) {
            call.reject("https url and cookieUrl, and a cookie name, are required");
            return;
        }
        Intent intent = new Intent(getContext(), LoginActivity.class);
        intent.putExtra(LoginActivity.EXTRA_URL, url);
        intent.putExtra(LoginActivity.EXTRA_COOKIE_URL, cookieUrl);
        intent.putExtra(LoginActivity.EXTRA_COOKIE_NAME, cookie);
        intent.putExtra(LoginActivity.EXTRA_TITLE, call.getString("title", "Sign in"));
        startActivityForResult(call, intent, "onCookieLoginResult");
    }

    @ActivityCallback
    private void onCookieLoginResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            JSObject response = new JSObject();
            response.put("value", data.getStringExtra(LoginActivity.EXTRA_COOKIE));
            String all = data.getStringExtra(LoginActivity.EXTRA_COOKIES);
            response.put("cookies", all != null ? all : "");
            call.resolve(response);
        } else {
            call.reject("Sign-in was cancelled", "CANCELLED");
        }
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

    /* ---------------- Notifications ---------------- */

    static final String EXTRA_NOTIFICATION = "app.noctis.player.NOTIFICATION";
    private static final String CHANNEL_GENERAL = "noctis_general";
    private static final String CHANNEL_QUIET = "noctis_quiet";
    private static volatile NoctisPlugin instance;

    /** Taps and action buttons arrive here (from the activity or NotificationActionReceiver). */
    static void dispatchNotificationAction(String id, String action) {
        NoctisPlugin plugin = instance;
        if (plugin == null || id == null) return;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("action", action);
        plugin.notifyListeners("notificationAction", event);
    }

    private JSObject notificationPermissionState() {
        JSObject response = new JSObject();
        // Before Android 13 notifications need no permission.
        PermissionState state = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            ? PermissionState.GRANTED
            : getPermissionState("notifications");
        response.put("state", state == null ? "prompt" : state.toString());
        return response;
    }

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        call.resolve(notificationPermissionState());
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(notificationPermissionState());
            return;
        }
        requestPermissionForAlias("notifications", call, "onNotificationPermission");
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
        call.resolve(notificationPermissionState());
    }

    private void ensureNotificationChannels(android.app.NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (manager.getNotificationChannel(CHANNEL_GENERAL) == null) {
            manager.createNotificationChannel(
                new android.app.NotificationChannel(CHANNEL_GENERAL, "General", android.app.NotificationManager.IMPORTANCE_DEFAULT)
            );
        }
        if (manager.getNotificationChannel(CHANNEL_QUIET) == null) {
            android.app.NotificationChannel quiet = new android.app.NotificationChannel(
                CHANNEL_QUIET, "Progress", android.app.NotificationManager.IMPORTANCE_LOW
            );
            quiet.setDescription("Downloads and other long-running tasks");
            quiet.setShowBadge(false);
            manager.createNotificationChannel(quiet);
        }
    }

    /**
     * Show or update a notification:
     * { id, title, body?, progress? (0..1), indeterminate?, ongoing?, quiet?, actions?: [{ id, label }] }
     * Showing an id again replaces it. A tap or button emits "notificationAction" { id, action },
     * with action "click" for the notification itself.
     */
    @PluginMethod
    public void showNotification(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("A notification needs an id");
            return;
        }
        if (notificationPermissionState().getString("state").equals("denied")) {
            call.reject("Notifications are turned off");
            return;
        }
        android.app.NotificationManager manager = (android.app.NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        ensureNotificationChannels(manager);

        Intent open = new Intent(getContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_NOTIFICATION, id);
        int code = id.hashCode();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            getContext(),
            Boolean.TRUE.equals(call.getBoolean("quiet", false)) ? CHANNEL_QUIET : CHANNEL_GENERAL
        )
            .setSmallIcon(R.drawable.ic_stat_noctis)
            .setContentTitle(call.getString("title", ""))
            .setContentText(call.getString("body"))
            .setContentIntent(PendingIntent.getActivity(getContext(), code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .setOngoing(Boolean.TRUE.equals(call.getBoolean("ongoing", false)))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true);

        Double progress = call.getDouble("progress");
        if (progress != null) {
            builder.setProgress(1000, (int) Math.round(Math.max(0, Math.min(1, progress)) * 1000), false);
        } else if (Boolean.TRUE.equals(call.getBoolean("indeterminate", false))) {
            builder.setProgress(0, 0, true);
        }

        JSArray actions = call.getArray("actions");
        if (actions != null) {
            try {
                for (int i = 0; i < actions.length(); i++) {
                    org.json.JSONObject action = actions.getJSONObject(i);
                    Intent intent = new Intent(getContext(), NotificationActionReceiver.class)
                        .setPackage(getContext().getPackageName())
                        .putExtra(EXTRA_NOTIFICATION, id)
                        .putExtra("action", action.getString("id"));
                    builder.addAction(
                        0,
                        action.getString("label"),
                        PendingIntent.getBroadcast(getContext(), code + i + 1, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
                    );
                }
            } catch (org.json.JSONException e) {
                call.reject("Invalid notification actions");
                return;
            }
        }

        manager.notify(id, 0, builder.build());
        call.resolve();
    }

    @PluginMethod
    public void closeNotification(PluginCall call) {
        String id = call.getString("id");
        android.app.NotificationManager manager = (android.app.NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (id != null && manager != null) manager.cancel(id, 0);
        call.resolve();
    }
}
