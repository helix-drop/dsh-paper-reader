package com.dsh.paperreader;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private OnBackPressedCallback backCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReaderNativePlugin.class);
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setBackgroundDrawable(new ColorDrawable(Color.parseColor("#f6f1e7")));
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content != null ? content : window.getDecorView(), (v, insets) -> {
            Insets sb = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout());
            Insets nav = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars());
            float d = Math.max(1f, getResources().getDisplayMetrics().density);
            int topDp = Math.round(sb.top / d);
            int botDp = Math.round(nav.bottom / d);
            ReaderNativePlugin.lastSafeTopDp = topDp;
            ReaderNativePlugin.lastSafeBottomDp = botDp;
            evalJs("window.__nativeSafeInsets={top:" + topDp + ",bottom:" + botDp + "};window.__readerSetSafeInsets&&window.__readerSetSafeInsets(" + topDp + "," + botDp + ")");
            return ViewCompat.onApplyWindowInsets(v, insets);
        });
        backCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                    return;
                }
                final WebView webView = getBridge().getWebView();
                webView.evaluateJavascript(
                    "(function(){try{return window.__readerHandleBack?!!window.__readerHandleBack():false}catch(e){return false}})()",
                    value -> {
                        if (!"true".equals(value)) {
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        }
                    }
                );
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backCallback);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        if (ReaderNativePlugin.selectionMenuDisabled && mode != null) {
            // Strip Android system Copy/Share/Search bar so WeRead floating capsule has clear space
            Menu menu = mode.getMenu();
            if (menu != null) {
                menu.clear();
            }
            mode.setTitle(null);
            mode.setSubtitle(null);
        }
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        if (ReaderNativePlugin.selectionMenuDisabled) {
            return super.onWindowStartingActionMode(new ActionMode.Callback2() {
                @Override
                public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                    return true;
                }

                @Override
                public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                    if (menu != null) menu.clear();
                    return true;
                }

                @Override
                public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                    return false;
                }

                @Override
                public void onDestroyActionMode(ActionMode mode) {}
            }, type);
        }
        return super.onWindowStartingActionMode(callback, type);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        int action = event.getAction();
        String keyName = KeyEvent.keyCodeToString(keyCode);

        if (ReaderNativePlugin.keyCaptureMode) {
            if (action == KeyEvent.ACTION_DOWN) {
                evalJs("window.__readerOnKeyCaptured && window.__readerOnKeyCaptured(" + keyCode + ", '" + keyName + "')");
            }
            return true;
        }

        if (ReaderNativePlugin.keyInterceptionEnabled) {
            boolean isPrev;
            boolean isNext;
            synchronized (ReaderNativePlugin.prevKeyCodes) {
                isPrev = ReaderNativePlugin.prevKeyCodes.contains(keyCode);
            }
            synchronized (ReaderNativePlugin.nextKeyCodes) {
                isNext = ReaderNativePlugin.nextKeyCodes.contains(keyCode);
            }
            if (isPrev || isNext) {
                if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                    String dir = isPrev ? "prev" : "next";
                    evalJs("window.__readerOnPhysicalKey && window.__readerOnPhysicalKey('" + dir + "', " + keyCode + ", '" + keyName + "')");
                }
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void evalJs(final String script) {
        if (getBridge() == null) return;
        final WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
