package com.librae.nexus;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * 实时加载（F-23.12）在原生侧要做的两件事。
 *
 * 背景：装进 APK 的那份前端只是「本地壳」（assets 里的）。它探测到服务器可达后，
 * 会把 WebView 整个导航到服务器地址，由服务器上那份最新的前端接管 —— 这样 Web
 * 侧改动不用重新打包。但 Capacitor 默认不允许 WebView 导航到 appUrl 以外的 host，
 * 会把这种跳转丢给系统浏览器（Bridge.launchIntent 里 `startActivity(ACTION_VIEW)`），
 * 那样 App 就只剩一个浏览器壳，返回键和会话都不成立了。
 *
 * 为什么不直接给 `server.allowNavigation` 配 `"*"`：那会让**所有**外链也留在
 * WebView 里。终端输出里点一个 http 链接，现在会开系统浏览器、当前页面不动
 * （WebLinksAddon 显式用 `window.open('_blank')`，而 Capacitor 没开多窗口，
 * `_blank` 走的仍是主框架导航）；配成 `"*"` 之后它会直接顶掉当前页面。所以这里
 * 只精确放行两件事：壳自己那一跳，以及之后同 host 的导航。
 */
public class MainActivity extends BridgeActivity {

    /** 壳跳转时带在 URL 上的标记，与 frontend/src/baseUrl.ts 的 SHELL_MARK 同值。 */
    private static final String SHELL_MARK = "nexus_shell";

    /**
     * 壳跳过去的那台服务器。进程重启即失效 —— 那时会重新从本地壳走一遍，正好。
     * 只在主线程读写（shouldOverrideUrlLoading 都在主线程），不需要同步。
     */
    private String liveHost = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 用 Bridge.setWebViewClient 而不是 webView.setWebViewClient：前者会把
        // Bridge 内部的引用一起换掉，Capacitor 后续的 getWebViewClient() 才拿到
        // 我们这个子类。
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String scheme = url.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // 壳自己那一跳：记住目标 host，之后这个 host 的导航都留在 WebView。
                    if ("1".equals(url.getQueryParameter(SHELL_MARK))) {
                        liveHost = url.getHost();
                        return false;
                    }
                    if (url.getHost() != null && url.getHost().equals(liveHost)) {
                        return false;
                    }
                }
                // 其余一切（外链、非 http(s) 的自定义 scheme）保持 Capacitor 的原行为。
                return super.shouldOverrideUrlLoading(view, request);
            }
        });

        // 返回键：WebView 有历史就先回退 —— 从远端页面退到本地壳那一屏（服务器
        // 管理）。本地壳没有历史，于是走默认行为（退出 App）。
        // Capacitor 自己不动返回键，所以这里用官方的 OnBackPressedDispatcher 接。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                // 交回系统（finish）。先禁用自己，否则会原地打转。
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
