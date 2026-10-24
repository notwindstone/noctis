package app.noctis.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import android.support.v4.media.session.MediaSessionCompat;

/**
 * Foreground service that keeps the app alive while music is loaded and hosts the media
 * notification (which Android also shows on the lock screen). Notification buttons send
 * intents here, which are forwarded to the media session's callbacks in NoctisPlugin.
 */
public class PlaybackService extends Service {

    public static final String CHANNEL_ID = "noctis_playback";
    public static final int NOTIFICATION_ID = 1201;

    public static final String ACTION_SHOW = "app.noctis.player.SHOW";
    public static final String ACTION_PLAY = "app.noctis.player.PLAY";
    public static final String ACTION_PAUSE = "app.noctis.player.PAUSE";
    public static final String ACTION_NEXT = "app.noctis.player.NEXT";
    public static final String ACTION_PREVIOUS = "app.noctis.player.PREVIOUS";
    public static final String ACTION_STOP = "app.noctis.player.STOP";

    /** Set by NoctisPlugin before starting the service. */
    static volatile Notification pendingNotification;
    static volatile MediaSessionCompat session;
    static volatile boolean running = false;

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Playback controls on the lock screen and in notifications");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /** Show or update the notification, starting the service the first time. */
    public static void show(Context context, Notification notification) {
        pendingNotification = notification;
        if (running) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, notification);
            return;
        }
        Intent intent = new Intent(context, PlaybackService.class).setAction(ACTION_SHOW);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void hide(Context context) {
        pendingNotification = null;
        context.stopService(new Intent(context, PlaybackService.class));
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = pendingNotification;
        if (notification == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        running = true;

        String action = intent != null ? intent.getAction() : null;
        MediaSessionCompat current = session;
        if (action != null && current != null) {
            switch (action) {
                case ACTION_PLAY:
                    current.getController().getTransportControls().play();
                    break;
                case ACTION_PAUSE:
                    current.getController().getTransportControls().pause();
                    break;
                case ACTION_NEXT:
                    current.getController().getTransportControls().skipToNext();
                    break;
                case ACTION_PREVIOUS:
                    current.getController().getTransportControls().skipToPrevious();
                    break;
                case ACTION_STOP:
                    current.getController().getTransportControls().stop();
                    break;
                default:
                    break;
            }
        }
        return START_NOT_STICKY;
    }

    /** Swiping the app away from recents destroys the WebView, so playback ends too. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        MediaSessionCompat current = session;
        if (current != null) current.getController().getTransportControls().stop();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
