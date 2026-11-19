package com.dsh.paperreader;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONException;

@CapacitorPlugin(name = "ReaderNative")
public class ReaderNativePlugin extends Plugin {
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
}
