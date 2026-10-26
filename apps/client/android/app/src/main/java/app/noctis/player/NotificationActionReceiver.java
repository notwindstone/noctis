package app.noctis.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** A button on a notification from NoctisPlugin.showNotification; hands the tap to the web layer without opening the app. */
public class NotificationActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        NoctisPlugin.dispatchNotificationAction(intent.getStringExtra(NoctisPlugin.EXTRA_NOTIFICATION), intent.getStringExtra("action"));
    }
}
