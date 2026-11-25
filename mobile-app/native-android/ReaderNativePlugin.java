package com.dsh.paperreader;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.Window;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONException;

@CapacitorPlugin(
    name = "ReaderNative",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class ReaderNativePlugin extends Plugin {
    static final String NOTICE_CHANNEL = "paper-reader-pipeline";
    static volatile boolean selectionMenuDisabled = false;
    static volatile boolean keyInterceptionEnabled = false;
    static volatile boolean keyCaptureMode = false;
    static volatile int lastSafeTopDp = 0;
    static volatile int lastSafeBottomDp = 0;
    static final Set<Integer> prevKeyCodes = new HashSet<>();
    static final Set<Integer> nextKeyCodes = new HashSet<>();

    @PluginMethod
    public void setImmersive(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            View decor = window.getDecorView();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
            if (controller != null) {
                if (enabled) {
                    controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    );
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void getSafeInsets(PluginCall call) {
        com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
        ret.put("top", lastSafeTopDp);
        ret.put("bottom", lastSafeBottomDp);
        call.resolve(ret);
    }

    @PluginMethod
    public void setAppearance(PluginCall call) {
        final String bgColor = call.getString("bgColor", "#f6f1e7");
        final boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            int color;
            try {
                color = Color.parseColor(bgColor);
            } catch (Exception e) {
                color = Color.parseColor("#f6f1e7");
            }
            Window window = activity.getWindow();
            View decor = window.getDecorView();
            window.setBackgroundDrawable(new ColorDrawable(color));
            decor.setBackgroundColor(color);
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setBackgroundColor(color);
            }
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
            if (controller != null) {
                controller.setAppearanceLightStatusBars(!dark);
                controller.setAppearanceLightNavigationBars(!dark);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setSelectionMenuDisabled(PluginCall call) {
        selectionMenuDisabled = Boolean.TRUE.equals(call.getBoolean("disabled", false));
        call.resolve();
    }

    @PluginMethod
    public void configureKeys(PluginCall call) {
        keyInterceptionEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSArray prev = call.getArray("prevKeyCodes");
        JSArray next = call.getArray("nextKeyCodes");
        synchronized (prevKeyCodes) {
            prevKeyCodes.clear();
            if (prev != null) {
                for (int i = 0; i < prev.length(); i++) {
                    try { prevKeyCodes.add(prev.getInt(i)); } catch (JSONException ignored) {}
                }
            }
        }
        synchronized (nextKeyCodes) {
            nextKeyCodes.clear();
            if (next != null) {
                for (int i = 0; i < next.length(); i++) {
                    try { nextKeyCodes.add(next.getInt(i)); } catch (JSONException ignored) {}
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void setKeyCapture(PluginCall call) {
        keyCaptureMode = Boolean.TRUE.equals(call.getBoolean("capturing", false));
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            resolveGranted(call, true);
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            resolveGranted(call, false);
            return;
        }
        if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            resolveGranted(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsPermsCallback");
    }

    @PermissionCallback
    private void notificationsPermsCallback(PluginCall call) {
        resolveGranted(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        final String title = call.getString("title", "Paper Reader");
        final String body = call.getString("body", "");
        final String noticeId = call.getString("id", "pipeline");
        final Activity activity = getActivity();
        if (activity == null || title == null || title.isEmpty()) {
            call.resolve();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            NotificationManager manager = (NotificationManager) activity.getSystemService(Activity.NOTIFICATION_SERVICE);
            if (manager == null) {
                call.resolve();
                return;
            }
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = new NotificationChannel(NOTICE_CHANNEL, "转写与翻译", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("转写或翻译完成，以及处理遇到问题时的通知");
                manager.createNotificationChannel(channel);
            }
            Intent intent = new Intent(activity, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(activity, 0, intent, flags);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, NOTICE_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pending);
            manager.notify(noticeId.hashCode(), builder.build());
            call.resolve();
        });
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }
}
