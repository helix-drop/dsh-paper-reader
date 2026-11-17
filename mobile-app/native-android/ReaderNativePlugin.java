package com.dsh.paperreader;

import android.app.Activity;
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
