package com.dsh.paperreader;

import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReaderNativePlugin.class);
        super.onCreate(savedInstanceState);
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
